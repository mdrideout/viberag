# ADR-011: Error Handling and Logging Strategy

## Status

Accepted

## Context

VibeRAG runs across multiple process types (daemon, MCP server, CLI) and needs consistent error handling for:

1. **Debugging** - Developers need full stack traces to diagnose issues
2. **Monitoring** - Future Sentry/PostHog integration for production error tracking
3. **User Experience** - Users need actionable error messages without noise
4. **Persistence** - Errors should survive process restarts for post-mortem analysis

### Current State

| Component  | Console         | File Log             | Stack Trace | Sentry-Ready |
| ---------- | --------------- | -------------------- | ----------- | ------------ |
| Daemon     | `console.error` | `.viberag/debug.log` | Yes         | Centralized  |
| MCP Server | `console.error` | `.viberag/debug.log` | Partial     | Partial      |
| CLI        | `console.error` | None                 | No          | Scattered    |

### Problems

1. **CLI errors not persisted** - Lost when terminal closes
2. **Inconsistent patterns** - Some catches log, others silent
3. **Stack traces lost** - `err.message` loses the trace
4. **No centralized capture point** - Sentry would need many integration points

## Decision

Adopt a **three-tier error logging strategy** that captures errors at the point of exception with full context, routing to appropriate destinations based on purpose.

### The Three Tiers

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ERROR OCCURS                                 │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 1: Immediate Visibility (console.error)                       │
│  ─────────────────────────────────────────────                      │
│  • Full Error object with stack trace                               │
│  • Component prefix for context                                     │
│  • Appears in terminal/stderr immediately                           │
│  • MCP clients see in their error stream                            │
│                                                                     │
│  Format: console.error(`[component] Context:`, error)               │
│          ─────────────────────────────────────────                  │
│          Pass the Error OBJECT, not just error.message              │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 2: Persistent Debug Log (.viberag/debug.log)                  │
│  ─────────────────────────────────────────────────                  │
│  • Full Error object with stack trace                               │
│  • Structured format with timestamp                                 │
│  • Survives process restarts                                        │
│  • Available for post-mortem debugging                              │
│                                                                     │
│  Format: logger.error('Component', 'message', error)                │
│                                                                     │
│  Output:                                                            │
│  [2024-01-11T15:30:00.000Z] [ERROR] Component: message              │
│    Error: Connection timeout                                        │
│    Stack: Error: Connection timeout                                 │
│        at DaemonConnection.connect (connection.ts:74)               │
│        at DaemonClient.doConnect (index.ts:111)                     │
│        ...                                                          │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 3: Error Monitoring (Sentry - Future)                         │
│  ─────────────────────────────────────────────                      │
│  • Full Error object for grouping/deduplication                     │
│  • Breadcrumbs from console.* calls (automatic)                     │
│  • User context, tags, extra data                                   │
│  • Alerts and dashboards                                            │
│                                                                     │
│  Format: Sentry.captureException(error, { extra: { ... } })         │
└─────────────────────────────────────────────────────────────────────┘
```

### Critical: Preserve the Error Object

**Always pass the Error object, never just the message string:**

```typescript
// WRONG - loses stack trace
console.error(`[daemon] Error: ${error.message}`);

// RIGHT - preserves full stack trace
console.error(`[daemon] Handler error:`, error);
```

Console output with Error object:

```
[daemon] Handler error: Error: Connection timeout
    at DaemonConnection.connect (connection.ts:74)
    at DaemonClient.doConnect (index.ts:111)
    at async handleSearch (handlers.ts:45)
```

### Centralized Error Handlers

Each process type has ONE centralized error handler that implements all three tiers:

#### Daemon Server (`daemon/server.ts`)

```typescript
// In handleMessage() catch block - ALL handler errors flow through here
} catch (error) {
    // Tier 1: Immediate visibility with full stack
    console.error(`[daemon] Handler error (${request.method}):`, error);

    // Tier 2: Persistent log with full stack
    const logger = this.owner.getLogger();
    if (logger) {
        logger.error('DaemonServer', `Handler error: ${request.method}`,
            error instanceof Error ? error : new Error(String(error)));
    }

    // Tier 3: Error monitoring (future)
    // Sentry.captureException(error, { extra: { method: request.method } });

    // Return structured error to client (message only - stack stays server-side)
    const message = error instanceof Error ? error.message : String(error);
    socket.write(formatError(request.id, code, message));
}
```

#### MCP Server (`mcp/server.ts`)

```typescript
// Lazy-initialized logger
let logger: Logger | null = null;
const getLogger = (): Logger => {
    if (!logger) logger = createDebugLogger(projectRoot);
    return logger;
};

// In tool execute functions or wrapper
} catch (error) {
    // Tier 1: Immediate visibility with full stack
    console.error(`[mcp] Tool error (${toolName}):`, error);

    // Tier 2: Persistent log
    getLogger().error('MCP', `Tool error: ${toolName}`,
        error instanceof Error ? error : new Error(String(error)));

    // Tier 3: Future
    // Sentry.captureException(error, { tags: { tool: toolName } });

    throw error; // Re-throw for MCP protocol error response
}
```

#### CLI (`cli/` - to be implemented)

```typescript
// Centralized CLI error handler
function handleCliError(component: string, error: unknown): void {
	// Tier 1: User-facing with full stack
	console.error(`[${component}]:`, error);

	// Tier 2: Persistent log (when project initialized)
	if (projectRoot && isInitialized) {
		const logger = createDebugLogger(projectRoot);
		logger.error(
			component,
			'CLI error',
			error instanceof Error ? error : new Error(String(error)),
		);
	}

	// Tier 3: Future
	// Sentry.captureException(error, { tags: { component } });
}
```

### Error Preservation Rules

1. **Never lose the Error object** - Pass the original Error, don't reconstruct

   ```typescript
   // WRONG - loses stack trace
   console.error(`Error: ${error.message}`);
   throw new Error(error.message);

   // RIGHT - preserves stack trace
   console.error('Error:', error);
   throw error;

   // RIGHT - adds context while preserving cause (ES2022)
   throw new Error('Config parse failed', {cause: error});
   ```

2. **Log before re-throwing** - Capture at point of occurrence

   ```typescript
   } catch (error) {
       console.error('[component] Error:', error);
       logger.error('Component', 'message', error);
       throw error;  // Propagate after logging
   }
   ```

3. **Distinguish expected vs unexpected errors**

   ```typescript
   } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
       const isExpected = message.includes('ENOENT') ||
                          message.includes('ECONNREFUSED');

       if (!isExpected) {
           // Full logging for unexpected errors
           console.error('[component] Unexpected error:', error);
           logger.error('Component', 'Unexpected error', error);
       }
       // Expected errors: handle silently or debug-level logging
   }
   ```

## Retry Policy for API Embeddings

Embedding API calls use a shared `withRetry()` helper that retries all errors, not just rate limits or known transient issues. This keeps indexing resilient in flaky network conditions.

- Maximum attempts: 10 per batch (initial attempt + retries)
- Backoff: exponential with a max of 60s
- After the final attempt fails, the batch is recorded as failed and indexing continues
- Failures are surfaced via daemon status and persisted in the manifest for retry on later runs

### Log File Location

Per-service folders with hourly rotation:

```
.viberag/
└── logs/
    ├── daemon/
    │   ├── 2024-01-11-14.log
    │   └── 2024-01-11-15.log
    ├── mcp/
    │   └── 2024-01-11-15.log
    ├── cli/
    │   └── 2024-01-11-15.log
    └── indexer/
        └── 2024-01-11-15.log
```

**Benefits:**

- **Per-service separation** - Easy to find logs for specific component
- **Hourly rotation** - Small files, natural time boundaries
- **Chronological naming** - Files sort naturally by time

### Sentry Integration (Future)

When Sentry is added:

1. **Initialize early** in each entry point:

   ```typescript
   // daemon/index.ts, mcp/index.ts, cli/app.tsx
   import * as Sentry from '@sentry/node';

   Sentry.init({
   	dsn: process.env.SENTRY_DSN,
   	environment: process.env.NODE_ENV,
   	integrations: [
   		// Capture console.error as breadcrumbs (automatic)
   		// Capture unhandled rejections (automatic)
   	],
   });
   ```

2. **Add to centralized handlers** (one line each):

   ```typescript
   Sentry.captureException(error, {
   	tags: {component: 'daemon', method: request.method},
   	extra: {params: request.params},
   });
   ```

3. **Automatic captures** (no code changes needed):
   - Uncaught exceptions
   - Unhandled promise rejections
   - Console breadcrumbs for context

## Consequences

### Positive

- **Full visibility** - Every error captured with stack trace in all tiers
- **Persistent history** - Debug log survives restarts
- **Sentry-ready** - One line addition per centralized handler
- **Debuggable** - Stack traces everywhere for fast diagnosis

### Negative

- **Verbose console output** - Stack traces in terminal (can be noisy)
- **Log file growth** - Debug.log grows unbounded (mitigate with rotation)
- **Disk I/O** - Synchronous file writes on each error

### Neutral

- **Three outputs** - Console, file, Sentry serve different purposes
- **Expected errors** - Still need per-case handling for known scenarios

## Implementation Checklist

- [x] Daemon centralized handler (`daemon/server.ts:253-272`)
- [x] DaemonOwner exposes logger (`daemon/owner.ts:483-485`)
- [x] MCP server logger setup (`mcp/server.ts:263-270`)
- [x] Pass Error object to console.error (preserves stack trace)
- [x] Per-service log folders (`daemon/lib/constants.ts`)
- [x] Hourly log rotation (`daemon/lib/logger/index.ts`)
- [x] Service logger factory (`createServiceLogger()`)
- [x] CLI error handler (`cli/utils/error-handler.ts`)
- [x] CLI logging to `.viberag/logs/cli/`
- [ ] Sentry initialization
- [ ] Sentry in centralized handlers
