# ADR-008: Redux Toolkit State Management

## Status

Accepted (Scope Reduced - see ADR-012)

## Current State

**Redux is now CLI-only.** Per ADR-012, the daemon uses a simple state container (`daemon/state.ts`) with event-based services. Redux remains in the CLI for:

- **Wizard state** - Multi-step init and MCP setup wizards
- **App state** - Output items, initialization status, index stats

The daemon slices (`indexing/`, `slot-progress/`, `warmup/`, `watcher/`) have been removed. CLI components now poll `daemon.status()` via `DaemonStatusContext` for daemon state.

---

## Original Context (Historical)

VibeRAG manages complex state across multiple domains:

1. **Indexing progress** - Files processed, chunks embedded, rate limits, errors
2. **Slot progress** - Concurrent batch processing with N parallel slots
3. **Warmup status** - Embedding provider initialization state
4. **File watcher** - Real-time file change detection and batching
5. **Wizard flows** - Multi-step init and MCP setup wizards
6. **App state** - Output items, initialization status, index stats

Previously, state flowed through deeply nested callback chains:

```
Indexer → progressCallback → handlers.ts → useRagCommands → setAppStatus → StatusBar
```

This 7-layer callback chain was difficult to debug, test, and extend. Adding a new consumer (e.g., MCP status endpoint) required threading callbacks through multiple layers.

Key requirements:

1. **Multi-interface access** - Both CLI and MCP interfaces need to read/write the same state (e.g., indexing progress, watcher status)
2. **React + Node.js access** - Both React components and headless Node.js code need to read/write state
3. **Predictable updates** - State changes should be traceable and debuggable
4. **No callback threading** - Any code should dispatch actions without callback chains
5. **Type safety** - Full TypeScript inference for actions and selectors

## Decision

We adopt Redux Toolkit as the central state management solution with a single store shared between React components (via Provider) and Node.js code (via direct import).

### Architecture

```
source/store/
├── store.ts              # Store configuration
├── hooks.ts              # Typed useAppDispatch, useAppSelector
├── index.ts              # Centralized exports
│
├── app/                  # App-level state
│   ├── slice.ts          # State, reducers, actions
│   └── selectors.ts      # Basic + memoized selectors
│
├── indexing/             # Indexing progress
│   ├── slice.ts
│   ├── selectors.ts
│   └── listeners.ts      # Side effect middleware
│
├── slot-progress/        # Concurrent slot tracking
│   ├── slice.ts
│   ├── selectors.ts
│   └── listeners.ts
│
├── warmup/               # Embedding provider warmup
│   ├── slice.ts
│   └── selectors.ts
│
├── watcher/              # File watcher state
│   ├── slice.ts
│   └── selectors.ts
│
└── wizard/               # Wizard flows
    ├── slice.ts
    └── selectors.ts
```

### Slice Structure

Each slice follows a consistent pattern:

```typescript
// slice.ts
import {createSlice, type PayloadAction} from '@reduxjs/toolkit';

// ============================================================================
// Types
// ============================================================================

export interface DomainState {
	status: 'idle' | 'active' | 'complete';
	// ... domain-specific fields
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: DomainState = {
	status: 'idle',
};

// ============================================================================
// Slice
// ============================================================================

export const domainSlice = createSlice({
	name: 'domain',
	initialState,
	reducers: {
		start: state => {
			state.status = 'active';
		},
		complete: state => {
			state.status = 'complete';
		},
		setProgress: (
			state,
			action: PayloadAction<{current: number; total: number}>,
		) => {
			// ... update state
		},
	},
});

export const DomainActions = domainSlice.actions;
export const domainReducer = domainSlice.reducer;
```

### Selector Structure

```typescript
// selectors.ts
import {createSelector} from '@reduxjs/toolkit';
import type {DomainState} from './slice.js';

// Local RootState type (avoids circular imports)
type RootState = {domain: DomainState};

// ============================================================================
// Basic Selectors
// ============================================================================

export const selectDomainState = (state: RootState): DomainState =>
	state.domain;
export const selectStatus = (state: RootState) => state.domain.status;

// ============================================================================
// Memoized Selectors
// ============================================================================

export const selectIsActive = createSelector(
	[selectStatus],
	(status): boolean => status === 'active',
);
```

### Direct Dispatch from Node.js

Node.js code (indexer, watcher, warmup) imports the store directly:

```typescript
// source/rag/indexer/indexer.ts
import {
	store,
	IndexingActions,
	SlotProgressActions,
} from '../../store/index.js';

async function indexFiles() {
	store.dispatch(IndexingActions.start());

	for (const file of files) {
		// ... process file
		store.dispatch(IndexingActions.setProgress({current, total, stage}));
	}

	store.dispatch(IndexingActions.complete());
}
```

This eliminates callback threading entirely. The indexer doesn't need to know about UI components—it just dispatches actions.

### React Component Usage

Components use typed hooks for full inference:

```typescript
// source/cli/components/StatusBar.tsx
import { useAppSelector } from '../../store/index.js';
import { selectIndexingPercent, selectIsIndexing } from '../../store/index.js';

function StatusBar() {
  const isIndexing = useAppSelector(selectIsIndexing);
  const percent = useAppSelector(selectIndexingPercent);

  if (isIndexing) {
    return <Text>Indexing: {percent}%</Text>;
  }
  return <Text>Ready</Text>;
}
```

### Listener Middleware

For cross-slice coordination and side effects, use listener middleware:

```typescript
// listeners.ts
import {createListenerMiddleware} from '@reduxjs/toolkit';
import {IndexingActions} from './slice.js';
import {SlotProgressActions} from '../slot-progress/slice.js';

export const indexingListenerMiddleware = createListenerMiddleware();

export const startIndexingListening =
	indexingListenerMiddleware.startListening.withTypes<RootState, AppDispatch>();

// Clear slot progress when indexing starts
startIndexingListening({
	actionCreator: IndexingActions.start,
	effect: async (_action, listenerApi) => {
		listenerApi.dispatch(SlotProgressActions.clearFailures());
		listenerApi.dispatch(SlotProgressActions.resetSlots());
	},
});
```

### Naming Conventions

| Element           | Pattern           | Example            |
| ----------------- | ----------------- | ------------------ |
| Slice folder      | `kebab-case/`     | `slot-progress/`   |
| State type        | `{Domain}State`   | `IndexingState`    |
| Actions export    | `{Domain}Actions` | `IndexingActions`  |
| Reducer export    | `{domain}Reducer` | `indexingReducer`  |
| Basic selector    | `select{Field}`   | `selectStatus`     |
| Computed selector | `select{Derived}` | `selectIsIndexing` |
| Status type       | `{Domain}Status`  | `IndexingStatus`   |

### Centralized Exports

All exports flow through `store/index.ts`:

```typescript
// Good - import from index
import {store, IndexingActions, selectIsIndexing} from '../../store/index.js';

// Avoid - direct slice imports (breaks encapsulation)
import {indexingSlice} from '../../store/indexing/slice.js';
```

### Adding a New Slice

1. Create folder: `source/store/{domain}/`
2. Create `slice.ts` with state, reducers, actions
3. Create `selectors.ts` with basic and memoized selectors
4. (Optional) Create `listeners.ts` for side effects
5. Register reducer in `store.ts`
6. Export everything from `store/index.ts`

## Consequences

### Positive

- **No callback chains** - Any code dispatches directly, no threading
- **Single source of truth** - All state in one inspectable store
- **React + Node.js parity** - Same API everywhere
- **Type safety** - Full inference for actions and selectors
- **Debuggable** - Redux DevTools compatible, actions are traceable
- **Testable** - Reducers are pure functions, easy to unit test
- **Scalable** - Add slices without modifying existing code

### Negative

- **Learning curve** - Developers must understand Redux patterns
- **Boilerplate** - Each domain requires slice + selectors files
- **Bundle size** - Redux Toolkit adds ~11KB gzipped

### Neutral

- Single store instance works because all interfaces (CLI, MCP) run in the same Node.js process
- Store is decoupled from interfaces—lives in `store/` not `cli/` or `mcp/`—enabling shared state access
- Listener middleware replaces Redux Saga/Thunk for side effects

## Migration Path

When adding new state:

1. **Don't** add useState in components for shared state
2. **Don't** thread callbacks through multiple layers
3. **Do** create a slice if multiple consumers need the state
4. **Do** dispatch actions directly from business logic

## Current Architecture (Post ADR-012)

The store structure has been simplified to CLI-only concerns:

```
source/cli/store/         # Store is CLI-only (no barrel exports)
├── store.ts              # Store configuration (wizard + app only)
├── hooks.ts              # Typed useAppDispatch, useAppSelector
│
├── app/                  # App-level state
│   ├── slice.ts          # Output items, init status, index stats
│   └── selectors.ts
│
└── wizard/               # Wizard flows
    ├── slice.ts          # Init wizard, MCP setup wizard
    └── selectors.ts
```

**Note:** The store barrel (`cli/store/index.ts`) was deleted per NO BARREL EXPORTS policy. Use direct imports:

```typescript
import {store} from './store/store.js';
import {useAppDispatch, useAppSelector} from './store/hooks.js';
import {AppActions} from './store/app/slice.js';
```

Daemon state is now managed by:

- `daemon/state.ts` - Simple state container
- `daemon/services/` - Event-based services
- `cli/contexts/DaemonStatusContext.tsx` - Polls daemon status for CLI components
