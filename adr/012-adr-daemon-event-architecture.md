# ADR-012: Daemon Event-Based Architecture

## Status

Accepted

## Context

ADR-010 established the per-project daemon architecture. During implementation, we encountered significant complexity from using Redux inside the daemon process. The daemon had:

- ~1100 lines of Redux boilerplate (slices, reducers, selectors, middleware)
- 32 `dispatch()` calls scattered through the indexing pipeline
- Unused listener middleware infrastructure
- Dependencies on React ecosystem patterns in a headless Node.js service

Additionally, the codebase had fragmented ownership:

```
BEFORE (Fragmented):

source/
├── daemon/          ← Owns server, handlers, lifecycle
│   └── imports from rag/, store/, mcp/watcher  ← REACHING OUT
│
├── rag/             ← "Headless engine" but...
│   ├── indexer.ts   → dispatches to store/  ← REDUX COUPLING
│   └── api-utils.ts → dispatches to store/  ← REDUX COUPLING
│
├── store/           ← Redux slices
│   └── Used by daemon, CLI, and rag/  ← SHARED MUTABLE STATE
│
└── mcp/
    └── watcher.ts   ← FileWatcher used by daemon  ← WRONG LOCATION
```

## Decision

Replace Redux in the daemon with:

1. **Simple State Container** (~100 lines)
2. **Event-based Services** using TypedEmitter
3. **Vertical Slice Architecture** where daemon owns all its code

### State Container

```typescript
// source/daemon/state.ts
export class StateContainer {
	private state: DaemonState = createInitialState();
	private listeners: Set<StateListener> = new Set();

	getSnapshot(): DaemonState {
		return this.state;
	}

	updateNested<K extends keyof DaemonState>(
		key: K,
		updater: (value: DaemonState[K]) => Partial<DaemonState[K]>,
	): void {
		// Immutable update, notify listeners
	}

	subscribe(listener: StateListener): () => void {
		// For reactive updates if needed
	}
}

export const daemonState = new StateContainer();
```

### Event-Based Services

Services emit events instead of dispatching Redux actions:

```typescript
// source/daemon/services/indexing.ts
export class IndexingService extends TypedEmitter<IndexingEvents & SlotEvents> {
	async index(options: IndexOptions): Promise<IndexStats> {
		this.emit('start');

		// Instead of: store.dispatch(IndexingActions.setProgress(...))
		// Now:        this.emit('progress', { current, total, stage });

		this.emit('complete', {stats});
	}
}
```

The daemon owner wires events to state:

```typescript
// source/daemon/owner.ts
private wireIndexingEvents(indexer: IndexingService): void {
  indexer.on('start', () => {
    daemonState.updateNested('indexing', () => ({
      status: 'initializing' as const,
    }));
  });

  indexer.on('progress', ({ current, total, stage }) => {
    daemonState.updateNested('indexing', () => ({
      status: 'indexing' as const,
      current,
      total,
      stage,
    }));
  });
}
```

### Vertical Slice Structure

```
AFTER (Vertical Slice):

source/daemon/                    ← SELF-CONTAINED VERTICAL SLICE
├── index.ts                      # Entry point
├── server.ts                     # IPC server
├── handlers.ts                   # RPC method handlers
├── protocol.ts                   # JSON-RPC types
├── lifecycle.ts                  # Shutdown, signals
├── state.ts                      # Simple state object (NOT Redux)
├── owner.ts                      # Daemon owner, wires events to state
│
├── services/                     # Business logic OWNED by daemon
│   ├── types.ts                  # TypedEmitter, event interfaces
│   ├── indexing.ts               # IndexingService with events
│   ├── watcher.ts                # FileWatcher with events
│   ├── storage/                  # LanceDB wrapper
│   │   ├── index.ts              # Storage class (no re-exports)
│   │   ├── types.ts
│   │   └── schema.ts
│   └── search/                   # Search engine
│       ├── index.ts              # SearchEngine class (no re-exports)
│       ├── types.ts
│       ├── vector.ts
│       ├── fts.ts
│       └── hybrid.ts
│
├── providers/                    # Embedding providers (direct imports)
│   ├── types.ts
│   ├── local.ts
│   ├── local-4b.ts
│   ├── gemini.ts
│   ├── openai.ts
│   └── mistral.ts
│
└── lib/                          # Pure utilities
    ├── constants.ts
    ├── config.ts
    ├── manifest.ts
    ├── gitignore.ts
    ├── logger.ts
    ├── merkle/
    └── chunker/
```

### Type Ownership

Each domain owns its types:

- `daemon/state.ts` → `DaemonState`, `SlotInfo`, `FailureInfo`
- `daemon/services/indexing.ts` → `IndexStats`, `IndexOptions`
- `daemon/services/search/types.ts` → `SearchResults`, `SearchFilters`
- `client/types.ts` → Client-facing types, re-exports from daemon

Cross-imports between services are fine. The domain that owns the data is the origin and owner of the type.

### CLI Integration

The CLI polls `daemon.status()` and can use the response directly in components. Redux in the CLI is only for CLI-specific state (wizard, output items), not daemon state sync.

```typescript
// CLI components read from daemon status response directly
const {data: status} = useDaemonStatus();

// CLI-only state stays in local Redux
dispatch(AppActions.addOutput(item));
```

## Consequences

### Positive

- **~1000 fewer lines** - Simple state replaces Redux boilerplate
- **Clearer data flow** - Events → state updates, no hidden dispatch chains
- **Better testability** - Mock services by listening to events
- **Type-safe events** - TypedEmitter ensures event payload types
- **Vertical ownership** - daemon/ imports nothing from outside except client/
- **Simpler debugging** - Follow events through wiring code

### Negative

- **Manual wiring** - Events must be explicitly connected to state updates
- **No time-travel** - Redux DevTools not available for daemon state
- **Duplicate code** - Some utilities duplicated from rag/ to daemon/lib/

### Neutral

- **Redux CLI-only** - For wizard state, output items, React integration
- **Same IPC protocol** - Clients unaffected by internal changes

## Migration Status

**Completed** - All phases of the migration are complete:

1. `mcp/watcher.ts` deleted - replaced by `daemon/services/watcher.ts`
2. `daemon/handlers.ts` updated to use `daemonState` instead of Redux
3. `StatusBar.tsx`, `SlotRow.tsx` moved from `common/components/` to `cli/components/`
4. `DaemonStatusContext` created for CLI to poll daemon status directly
5. `rag/` folder deleted - tests migrated to `daemon/__tests__/`
6. Redux slices removed: `slot-progress/`, `indexing/`, `warmup/`, `watcher/`
7. `store/` now CLI-only with `app/` and `wizard/` slices

### Final Architecture

```
source/
├── daemon/                    ← VERTICAL SLICE (owns all business logic)
│   ├── state.ts               # Simple state container
│   ├── services/              # Event-based services (indexing, search, storage, watcher)
│   ├── providers/             # Embedding providers
│   ├── lib/                   # Pure utilities (merkle, chunker, config, manifest)
│   └── __tests__/             # All RAG tests
│
├── client/                    ← Thin IPC client
│   ├── index.ts
│   └── types.ts               # Re-exports daemon types
│
├── cli/                       ← UI layer
│   ├── components/            # StatusBar, SlotRow, wizards
│   ├── contexts/              # DaemonStatusContext
│   ├── commands/
│   └── hooks/
│
├── common/                    ← Truly shared (no Redux deps)
│   ├── types.ts
│   ├── components/            # TextInput, CommandSuggestions
│   └── hooks/                 # useTerminalResize, useTextBuffer
│
└── mcp/                       ← MCP integration (thin client)
    ├── index.ts
    └── server.ts

# Note: Redux store is at cli/store/ (see ADR-008)
# No barrel exports anywhere (see AGENTS.md)
```
