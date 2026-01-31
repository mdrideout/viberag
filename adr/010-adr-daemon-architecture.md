# ADR-010: Per-Project Daemon Architecture

## Status

Accepted

## Context

VibeRAG currently has a fundamental architecture issue: the CLI and MCP server are separate processes that share filesystem state (per-project data under `~/.local/share/viberag/projects/<projectId>/`, override via `VIBERAG_HOME`) but have no coordination mechanism.

### The Problem

When multiple processes access the same index:

1. **MCP servers auto-start** - Each IDE/agent spawns its own `viberag-mcp` process
2. **CLI operates alongside** - Users run `/index`, `/clean`, `/init` while MCP servers are active
3. **Multiple agents possible** - Claude Code, Cursor, VS Code Copilot may all connect to the same project

This leads to concrete failures:

```
User runs /clean in CLI
├── CLI deletes ~/.local/share/viberag/projects/<projectId>/lancedb/
├── MCP server still has open LanceDB connection
├── MCP server queries → "file not found" errors
└── User must restart IDE to recover
```

### Current State Problems

| Component          | Current State           | Problem                                    |
| ------------------ | ----------------------- | ------------------------------------------ |
| LanceDB connection | One per process         | Stale references when files deleted        |
| File watcher       | One per MCP process     | N watchers for N agents = wasted resources |
| Redux store        | One per process         | State diverges between CLI and MCP         |
| Indexing           | Any process can trigger | No coordination, potential corruption      |

### Failed Alternatives

**Filesystem-only coordination** (locks + epochs) was considered but rejected:

- `flock()` behavior varies across OS (especially Windows)
- File watching has race conditions
- Multiple watchers still waste resources
- Subtle/silent failures hard to debug

## Decision

Adopt a **per-project daemon architecture** where a single daemon process owns all mutable state for a project, and CLI/MCP processes become thin clients.

### Startup Behavior

- The daemon opens its IPC socket immediately so clients can connect without startup timeouts.
- Owner initialization (file watcher + warmup) runs after the socket is live.
- Handlers that need the owner block until initialization completes; status reflects warmup and watcher state.

### Daemon Locality

**One daemon per project** (keyed by a stable `projectId` derived from the project root):

```
~/.local/share/viberag/
├── projects/
│   ├── <projectIdA>/
│   │   ├── config.json
│   │   └── lancedb/
│   └── <projectIdB>/
│       ├── config.json
│       └── lancedb/
└── run/
    ├── <projectIdA>/
    │   ├── daemon.sock      ← Daemon A listens here (Unix)
    │   └── daemon.pid
    └── <projectIdB>/
        ├── daemon.sock      ← Daemon B (separate)
        └── daemon.pid
```

### Scenario 1: Two Separate Projects

```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│        Project A            │    │        Project B            │
│                             │    │                             │
│  ┌───────────────────────┐  │    │  ┌───────────────────────┐  │
│  │      Daemon A         │  │    │  │      Daemon B         │  │
│  │  - watches projectA   │  │    │  │  - watches projectB   │  │
│  │  - indexes projectA   │  │    │  │  - indexes projectB   │  │
│  └───────────┬───────────┘  │    │  └───────────┬───────────┘  │
│              │              │    │              │              │
│      ┌───────┴───────┐      │    │      ┌───────┴───────┐      │
│      ▼               ▼      │    │      ▼               ▼      │
│  ┌───────┐      ┌───────┐   │    │  ┌───────┐      ┌───────┐   │
│  │ MCP   │      │  CLI  │   │    │  │ MCP   │      │  CLI  │   │
│  └───────┘      └───────┘   │    │  └───────┘      └───────┘   │
└─────────────────────────────┘    └─────────────────────────────┘

✓ Two separate daemons, no interference
✓ Each daemon manages its own index
```

### Scenario 2: One Project, Multiple Agents

```
┌─────────────────────────────────────────────────────────────────┐
│                          Project A                               │
│                                                                  │
│                    ┌─────────────────────┐                       │
│                    │      Daemon A       │                       │
│                    │                     │                       │
│                    │  - 1 file watcher   │                       │
│                    │  - 1 LanceDB conn   │                       │
│                    │  - 1 indexer        │                       │
│                    └──────────┬──────────┘                       │
│                               │                                  │
│           ┌───────────────────┼───────────────────┐              │
│           │                   │                   │              │
│           ▼                   ▼                   ▼              │
│    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│    │ viberag-mcp │    │ viberag-mcp │    │    CLI      │        │
│    │  (Claude)   │    │  (Cursor)   │    │             │        │
│    └─────────────┘    └─────────────┘    └─────────────┘        │
│                                                                  │
│  ✓ ONE daemon serves all clients                                 │
│  ✓ File changes indexed once, all clients notified              │
│  ✓ CLI operations immediately visible to agents                 │
└──────────────────────────────────────────────────────────────────┘
```

### Scenario 3: CLI Reinitializes While Agents Connected

```
STEP 1: User runs `/clean` or `/init` in CLI
─────────────────────────────────────────────
              Daemon ◄──── MCP (Claude)
                  ▲
                  ├──────── MCP (Cursor)
                  │
                  └──────── CLI: "shutdown" command

STEP 2: Daemon handles coordinated shutdown
───────────────────────────────────────────
              Daemon:
                1. Notifies clients: "shutting down for reinit"
                2. Closes LanceDB connection
                3. Stops file watcher
                4. Removes socket file
                5. Exits

              MCP clients receive: "daemon disconnected"
              MCP clients enter: "reconnecting" state

STEP 3: CLI performs /clean or /init
────────────────────────────────────
              CLI:
                - Deletes/recreates the per-project data directory under `~/.local/share/viberag/projects/<projectId>/`
                - Runs initialization wizard
                - Creates new config.json
                - (Optional) Starts initial indexing

STEP 4: Clients auto-reconnect to new daemon
────────────────────────────────────────────
              New Daemon ◄──── MCP (Claude) [reconnected]
                  ▲
                  └──────── MCP (Cursor) [reconnected]

  ✓ All clients now using fresh index
  ✓ No manual restart required
```

### Daemon Ownership

The daemon exclusively owns:

| Resource                | Daemon Owns       | Clients Access Via                                                 |
| ----------------------- | ----------------- | ------------------------------------------------------------------ |
| LanceDB connection      | Single connection | IPC: `search()`, `getSymbol()`, `expandContext()`                  |
| File watcher (chokidar) | Single watcher    | IPC: `watchStatus()` (polled)                                      |
| Indexer                 | Single indexer    | IPC: `index()` / `indexAsync()` (progress observed via `status()`) |
| Manifest                | Read/write        | IPC: `status()`                                                    |
| Config                  | Read              | IPC: `status()`                                                    |

### IPC Protocol

Socket location: `~/.local/share/viberag/run/<projectId>/daemon.sock` (Unix) or `\\.\pipe\viberag-<projectId>` (Windows)

Protocol: JSON-RPC 2.0 over newline-delimited JSON

```
Client → Daemon (requests):
─────────────────────────
{"jsonrpc":"2.0","method":"search","params":{"query":"auth","intent":"auto","k":20},"id":1}
{"jsonrpc":"2.0","method":"getSymbol","params":{"symbol_id":"..."},"id":2}
{"jsonrpc":"2.0","method":"expandContext","params":{"table":"symbols","id":"..."},"id":3}
{"jsonrpc":"2.0","method":"indexAsync","params":{"force":false},"id":4}
{"jsonrpc":"2.0","method":"status","id":5}
{"jsonrpc":"2.0","method":"watchStatus","id":6}
{"jsonrpc":"2.0","method":"cancel","params":{"target":"indexing","reason":"cli"},"id":7}
{"jsonrpc":"2.0","method":"shutdown","params":{"reason":"reinit"},"id":8}

Daemon → Client (responses):
───────────────────────────
{"jsonrpc":"2.0","result":{...},"id":1}
{"jsonrpc":"2.0","error":{"code":-1,"message":"..."},"id":2}
```

The protocol is request/response only. Clients poll `status()` (and optionally `watchStatus()`) to observe progress and state changes.

### Daemon Lifecycle

**Startup:**

1. First client checks for `~/.local/share/viberag/run/<projectId>/daemon.sock`
2. If connectable → use existing daemon
3. If not → spawn daemon subprocess, wait for socket, connect

**Shutdown:**

1. Idle timeout: daemon exits after 5 minutes with no activity (any request resets the timer)
2. Explicit: CLI sends `shutdown` command for `/clean`, `/init`
3. Signal: SIGTERM/SIGINT triggers graceful shutdown

**Crash Recovery:**

1. Client detects connection failure
2. Client checks `~/.local/share/viberag/run/<projectId>/daemon.pid` - if process dead, clean up stale socket
3. Client spawns new daemon
4. Client reconnects

### Client State Machine

```
                          ┌─────────────┐
                          │   START     │
                          └──────┬──────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │  Check daemon.sock     │
                    │  exists & connectable? │
                    └───────────┬────────────┘
                          yes/  \no
                            /    \
                           ▼      ▼
            ┌──────────────┐      ┌──────────────┐
            │   CONNECT    │      │ START DAEMON │
            └───────┬──────┘      └───────┬──────┘
                    │                     │
                    ▼                     ▼
            ┌───────────────────────────────────┐
            │           CONNECTED               │◄────────┐
            │   - Can call search(), indexAsync() │         │
            │   - Polls status() for updates    │         │
            └───────────────┬───────────────────┘         │
                            │                             │
                   daemon disconnects                     │
                            │                             │
                            ▼                             │
            ┌───────────────────────────────┐             │
            │        RECONNECTING           │─────────────┘
            │   - Retry connect with backoff │    success
            │   - Start new daemon if needed │
            └───────────────────────────────┘
```

### Architecture Diagram

```
source/
├── daemon/                      # NEW: Daemon process
│   ├── index.ts                 # Entry point (viberag-daemon)
│   ├── server.ts                # IPC server, request routing
│   ├── lifecycle.ts             # Startup, shutdown, idle timeout
│   └── protocol.ts              # JSON-RPC types and helpers
│
├── client/                      # NEW: Shared client library
│   ├── index.ts                 # DaemonClient class
│   ├── connection.ts            # Socket connection management
│   └── auto-start.ts            # Daemon spawning logic
│
├── mcp/
│   ├── index.ts                 # Uses DaemonClient instead of direct calls
│   └── server.ts                # Proxies MCP tools to daemon
│
└── cli/
    ├── store/                   # Redux stays in CLI only
    │   └── ...
    └── commands/
        └── handlers.ts          # Uses DaemonClient for /index, /search
```

### What Changes for viberag-mcp

Current `viberag-mcp`:

- Owns LanceDB connection
- Runs file watcher
- Runs indexer directly
- Has Redux store

New `viberag-mcp`:

- Thin client to daemon
- Proxies MCP tool calls via IPC
- Forwards notifications to MCP client
- No local state for index/watcher

```typescript
// Before: Direct calls
const storage = new Storage(projectRoot, dimensions);
await storage.connect();
const results = await searchEngine.search(query);

// After: Via daemon client
const client = new DaemonClient(projectRoot);
await client.connect(); // Starts daemon if needed
const results = await client.search(query);
```

### What Changes for CLI

Previous CLI commands called `Indexer` and `SearchEngine` directly (before migrating CLI to daemon IPC).

New CLI commands:

- Connect to daemon (starting it if needed)
- Call daemon methods via IPC
- For `/clean` and `/init`: send shutdown command first

```typescript
// /index command
const client = new DaemonClient(projectRoot);
await client.connect();
const stats = await client.index({force: false});

// /clean command
const client = new DaemonClient(projectRoot);
if (await client.isRunning()) {
	await client.shutdown('clean');
}
// Now safe to delete the project data dir
await fs.rm(viberagDir, {recursive: true});
```

## Consequences

### Positive

- **Single source of truth** - One daemon owns all mutable state per project
- **No stale connections** - Clients don't hold LanceDB references
- **Efficient at scale** - 1 watcher regardless of agent count
- **Clean CLI integration** - CLI changes immediately visible to agents
- **Better debugging** - Single daemon log for all indexing activity
- **Coordinated shutdown** - `/clean` and `/init` work reliably

### Negative

- **Additional process** - Daemon adds complexity to deployment
- **IPC overhead** - Searches go through socket instead of direct calls
- **Startup latency** - First connection spawns daemon (~100-500ms)
- **Platform differences** - Unix sockets vs Windows named pipes

### Neutral

- **Redux is CLI-only** - Daemon uses simple state container (see ADR-012)
- **Same MCP interface** - Agents see no change, tools work identically
- **Same CLI interface** - Commands work the same, just via daemon

## Implementation Plan

### Phase 1: Daemon Core

1. Create `source/daemon/` with IPC server
2. Move LanceDB connection, watcher, indexer to daemon
3. Implement `search()`, `index()`, `status()` handlers
4. Add PID file and socket management

### Phase 2: Client Library

1. Create `source/client/` with `DaemonClient` class
2. Implement auto-start logic (spawn daemon if not running)
3. Implement reconnection with backoff
4. Add push notification handling

### Phase 3: Integration

1. Update `viberag-mcp` to use `DaemonClient`
2. Update CLI commands to use `DaemonClient`
3. Add `/clean` and `/init` shutdown coordination
4. Test multi-agent scenarios

### Phase 4: Polish

1. Idle timeout (5 min default)
2. Health check endpoint
3. Protocol versioning for upgrades
4. Windows named pipe support
