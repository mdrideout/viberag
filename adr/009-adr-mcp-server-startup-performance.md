# ADR-009: MCP Server Startup Performance

## Status

Accepted

## Context

MCP (Model Context Protocol) servers must complete a handshake with the client within a timeout window. Different clients have different tolerances:

| Client      | Timeout Behavior                            |
| ----------- | ------------------------------------------- |
| Claude Code | Retries on failure, eventually succeeds     |
| Zed         | Fails with "context server request timeout" |
| Cursor      | Generally tolerant                          |

The viberag-mcp server was failing to start in time for some clients. Investigation revealed the root cause: **synchronous native module loading during import**.

### The Problem

```
mcp/server.ts imports from barrel file
  → barrel re-exports ALL submodules
    → storage/index.ts → @lancedb/lancedb (NATIVE MODULE, ~500ms)
    → chunker/index.ts → web-tree-sitter (WASM, ~200ms)
    → storage/schema.ts → apache-arrow (10MB JS package)
```

**Result:** ~1-2 seconds before the server could respond to the MCP `initialize` request.

### Why This Matters

1. **Native modules are slow to load** - `dlopen()` and initialization takes 500-1000ms
2. **WASM modules add overhead** - tree-sitter requires loading and compiling WASM
3. **Barrel files force loading everything** - Even if you only need one function
4. **MCP handshake is time-sensitive** - Clients expect quick responses

## Decision

### 1. Direct Imports for Lightweight Modules

Import directly from submodules, not barrel files:

```typescript
// ❌ Anti-pattern (loads ALL modules via barrel):
import {SearchEngine, Storage} from '../daemon/services/index.js';

// ✅ Correct (loads only what's needed):
import {configExists} from '../daemon/lib/config.js';
```

### 2. Lazy Loading for Heavy Modules

Create a lazy loader service for modules with native dependencies:

```typescript
// Lazy loading pattern for heavy modules
let searchModule: typeof import('../client/index.js') | null = null;

export async function getClient(): Promise<DaemonClient> {
	if (!searchModule) {
		searchModule = await import('../client/index.js');
	}
	return new searchModule.DaemonClient(projectRoot);
}
```

Usage in tool handlers:

```typescript
// Load on first use, cached for subsequent calls
const client = await getClient();
const results = await client.search(query);
```

### 3. Break Transitive Dependencies

Move shared constants to avoid pulling in heavy dependencies:

```typescript
// ❌ manifest/index.ts importing from storage/schema.ts
// This pulls in apache-arrow (10MB) just for SCHEMA_VERSION

// ✅ Move SCHEMA_VERSION to constants.ts
// Both manifest and storage import from constants
```

## Module Classification

### Light Modules (Direct Import)

| Module    | Path                                | Load Time |
| --------- | ----------------------------------- | --------- |
| config    | `../daemon/lib/config.js`           | <10ms     |
| manifest  | `../daemon/services/v2/manifest.js` | <10ms     |
| logger    | `../daemon/lib/logger.js`           | <10ms     |
| gitignore | `../daemon/lib/gitignore.js`        | <10ms     |
| constants | `../daemon/lib/constants.js`        | <5ms      |

### Heavy Modules (Lazy Load via Client)

| Module       | Path                 | Heavy Dependency | Load Time  |
| ------------ | -------------------- | ---------------- | ---------- |
| DaemonClient | `../client/index.js` | IPC connection   | ~100-200ms |
| (Indexer)    | daemon-internal      | tree-sitter WASM | ~200-400ms |
| (Search)     | daemon-internal      | @lancedb/lancedb | ~500-800ms |

**Note:** Heavy modules are now daemon-internal. MCP server uses the thin client, avoiding direct loading of native modules.

## Alternatives Considered

### Worker Threads

Run RAG in a worker thread to keep main thread responsive.

| Pros                         | Cons                          |
| ---------------------------- | ----------------------------- |
| True parallelism             | Serialization overhead        |
| Main thread stays responsive | Complex error handling        |
|                              | Cross-thread state management |
|                              | Difficult debugging           |

**Decision:** Rejected. Lazy loading is simpler and sufficient for MCP handshake timing.

### Pre-warming on Install

Load native modules during `npm install` or first run.

| Pros                  | Cons                          |
| --------------------- | ----------------------------- |
| No first-call latency | Doesn't help MCP startup      |
|                       | Complex to implement reliably |

**Decision:** Rejected. The problem is per-process startup, not one-time loading.

### Dynamic Imports Everywhere

Use `await import()` for all modules.

| Pros                | Cons                           |
| ------------------- | ------------------------------ |
| Maximum flexibility | Unnecessary for light modules  |
|                     | Adds async overhead everywhere |
|                     | Makes code harder to read      |

**Decision:** Rejected. Only heavy modules need lazy loading.

## Results

| Metric           | Before         | After                   |
| ---------------- | -------------- | ----------------------- |
| Module load time | ~1000-2000ms   | ~200ms                  |
| MCP handshake    | Timeout in Zed | Success                 |
| First tool call  | N/A            | ~600-1000ms (lazy load) |
| Subsequent calls | Same           | Instant (cached)        |

## Consequences

### Positive

1. **Fast MCP handshake** - Server responds immediately
2. **Works with all clients** - No more timeouts in Zed or other strict clients
3. **Simple pattern** - Easy to understand and maintain
4. **No external dependencies** - Uses standard dynamic imports

### Negative

1. **First-call latency** - First tool invocation loads heavy modules
2. **Async requirement** - Tool handlers must be async to use lazy loader
3. **Import discipline** - Developers must avoid barrel imports in MCP code

### Mitigations

1. **Warmup on connect** - Start loading heavy modules after MCP handshake completes
2. **Clear documentation** - AGENTS.md and this ADR document the pattern
3. **Code review** - Check MCP code for barrel imports

## Checklist for MCP Development

When adding or modifying MCP server code:

```
Import Checks
[ ] No barrel imports (NO BARREL EXPORTS policy)
[ ] Direct imports to specific files only
[ ] Type-only imports use 'import type' syntax

Performance Checks
[ ] No synchronous file I/O at module level
[ ] No heavy computation at import time
[ ] MCP uses thin client (heavy modules in daemon process)

Testing
[ ] MCP smoke test passes
[ ] Server starts in <500ms (measure with: time node dist/mcp/index.js)
```

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [FastMCP](https://github.com/punkpeye/fastmcp)
- [MCP Development Best Practices](https://github.com/cyanheads/model-context-protocol-resources/blob/main/guides/mcp-server-development-guide.md)
- AGENTS.md - NO BARREL EXPORTS policy
- ADR-010 - Daemon architecture (MCP uses thin client)
