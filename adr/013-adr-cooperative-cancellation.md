# ADR-013: Cooperative Cancellation

## Status

Accepted

## Context

When VibeRAG runs via MCP (Claude Code, Cursor, other AI assistants), the daemon process is held alive by the MCP client. Users cannot simply Ctrl+C to stop a stuck or long-running operation because:

1. The daemon runs as a background process started by the MCP server
2. Killing the daemon would affect all connected MCP clients
3. The MCP client might automatically restart the daemon
4. Users may not know where the daemon process is running

This creates a real problem when indexing gets stuck due to:

- API rate limits causing extended backoff
- Network issues
- Very large codebases taking too long
- Embedding provider errors

Without a cancellation mechanism, users must either wait indefinitely or manually find and kill the daemon process.

## Decision

Implement cooperative cancellation using `AbortController`/`AbortSignal`, the standard JavaScript pattern for cancellable async operations.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Cancel Request                          │
│  CLI: /cancel [target]    MCP: cancel                           │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DaemonOwner.cancelActivity()               │
│  - Aborts indexingAbortController and/or warmupAbortController  │
│  - Updates state to 'cancelling'                                │
│  - Pauses watcher auto-indexing for 30s                         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Signal Propagation                         │
│                                                                 │
│  IndexingService                                                │
│    ├── MerkleTree.build()     → checks signal at each file     │
│    ├── Chunking loop          → checks signal between files    │
│    └── Embedding batches      → signal passed to providers     │
│                                                                 │
│  EmbeddingProvider.embed()                                      │
│    ├── processBatchesWithLimit() → checks signal, cleans slots │
│    ├── withRetry()               → checks signal before retry  │
│    ├── sleepWithSignal()         → rejects on abort            │
│    └── fetch()                   → receives signal for network │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Cleanup & State                            │
│  - State transitions to 'cancelled'                             │
│  - Pending watcher changes preserved in queue                   │
│  - After 30s cooldown, auto-indexing resumes                    │
└─────────────────────────────────────────────────────────────────┘
```

### Abort Utilities

```typescript
// source/daemon/lib/abort.ts

export function throwIfAborted(signal?: AbortSignal, message?: string): void {
	if (signal?.aborted) {
		throw new DOMException(message ?? getAbortReason(signal), 'AbortError');
	}
}

export function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

export function getAbortReason(signal?: AbortSignal): string {
	if (!signal) return 'Operation aborted';
	const reason = signal.reason;
	if (typeof reason === 'string') return reason;
	if (reason instanceof Error) return reason.message;
	return 'Operation aborted';
}

export async function sleepWithSignal(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	// Resolves after ms, or rejects immediately if signal aborts
}
```

### Cancel Response Type

```typescript
interface CancelResponse {
	cancelled: boolean;
	targets: Array<'indexing' | 'warmup'>;
	skipped: Array<'indexing' | 'warmup'>;
	reason: string | null;
	message: string;
}
```

### Watcher Pause Mechanism

When cancel is requested, the watcher pauses auto-indexing for 30 seconds to prevent immediate re-triggering:

```typescript
// source/daemon/services/watcher.ts

pauseAutoIndexing(durationMs: number, reason?: string): void {
  this.autoIndexPausedUntil = Date.now() + durationMs;
  this.autoIndexPauseReason = reason;
  // Clear pending timers, schedule resume
}
```

This prevents the race condition where:

1. User cancels indexing
2. Watcher has pending file changes
3. Indexing ends (cancelled)
4. Watcher immediately triggers new indexing

After the cooldown, auto-indexing resumes normally with any queued changes.

### State Tracking

The daemon state tracks cancellation metadata for debugging:

```typescript
interface IndexingState {
	status:
		| 'idle'
		| 'initializing'
		| 'indexing'
		| 'cancelling'
		| 'cancelled'
		| 'complete'
		| 'error';
	// ...
	cancelRequestedAt: string | null;
	cancelledAt: string | null;
	lastCancelled: string | null;
	cancelReason: string | null;
}
```

### Stall Detection

Both CLI and MCP expose stall indicators:

```typescript
// Stalled if no progress for 60+ seconds while active
const stalled =
	isActive && secondsSinceProgress !== null && secondsSinceProgress > 60;
```

This helps users and agents identify when to cancel.

## Consequences

### Positive

- **MCP-first design** - AI agents can programmatically cancel operations
- **Standard patterns** - Uses `AbortController`/`AbortSignal`, familiar to JS developers
- **Clean propagation** - Signal flows through entire async call stack
- **No resource leaks** - Network requests cancelled, timers cleared
- **Preserved queue** - Pending watcher changes not lost on cancel
- **Auto-resume** - Normal operation resumes after cooldown without manual intervention

### Negative

- **Complexity** - ~400 lines across 12+ files
- **Cooldown is arbitrary** - 30s pause may be too long or too short
- **Not instant** - Cooperative cancellation requires checkpoints; can't cancel mid-batch

### Neutral

- **CLI gets it free** - `/cancel` command added alongside MCP tool
- **Same protocol** - Cancel is just another RPC method

## API Reference

### CLI

```
/cancel            Cancel all active operations
/cancel indexing   Cancel only indexing
/cancel warmup     Cancel only warmup
```

### MCP

```typescript
// cancel_operation tool
{
  target: 'indexing' | 'warmup' | 'all',  // default: 'all'
  reason?: string                          // optional, logged for debugging
}
```

### Status Indicators

```
/status output:
  Watcher: watching · 1234 files · 0 pending · auto-index paused 25s (cancel requested)

get_status tool response (includes daemon summary when running):
  "daemon": {
    "indexing": {
      "status": "indexing",
      "secondsSinceProgress": 65
    }
  }
```
