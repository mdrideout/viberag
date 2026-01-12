# ADR-008: Redux Toolkit State Management

## Status

Accepted (CLI-only scope per ADR-012)

## Context

The CLI interface needs state management for:

1. **Wizard flows** - Multi-step init and MCP setup wizards
2. **App state** - Output items, initialization status, index stats

Redux Toolkit provides:

- Type-safe actions and selectors
- React integration via hooks
- Predictable state updates

**Note:** The daemon uses a simple state container with event-based services (see ADR-012). Redux is CLI-only.

## Decision

Use Redux Toolkit in the CLI for wizard and app state management.

### Architecture

```
source/cli/store/         # CLI-only (no barrel exports)
├── store.ts              # Store configuration
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

### Slice Pattern

Each slice follows a consistent structure:

```typescript
// slice.ts
import {createSlice, type PayloadAction} from '@reduxjs/toolkit';

export interface DomainState {
	status: 'idle' | 'active' | 'complete';
}

const initialState: DomainState = {
	status: 'idle',
};

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
	},
});

export const DomainActions = domainSlice.actions;
export const domainReducer = domainSlice.reducer;
```

### Selector Pattern

```typescript
// selectors.ts
import {createSelector} from '@reduxjs/toolkit';
import type {DomainState} from './slice.js';

type RootState = {domain: DomainState};

// Basic selectors
export const selectStatus = (state: RootState) => state.domain.status;

// Memoized selectors
export const selectIsActive = createSelector(
	[selectStatus],
	(status): boolean => status === 'active',
);
```

### Usage in Components

```typescript
// source/cli/components/SomeComponent.tsx
import {useAppSelector, useAppDispatch} from '../store/hooks.js';
import {selectIsActive} from '../store/app/selectors.js';
import {AppActions} from '../store/app/slice.js';

function SomeComponent() {
	const dispatch = useAppDispatch();
	const isActive = useAppSelector(selectIsActive);

	const handleClick = () => {
		dispatch(AppActions.start());
	};

	return <Button onClick={handleClick}>Start</Button>;
}
```

### Import Pattern (NO BARREL EXPORTS)

Per project policy, use direct imports:

```typescript
// Direct imports to specific files
import {store} from './store/store.js';
import {useAppDispatch, useAppSelector} from './store/hooks.js';
import {AppActions} from './store/app/slice.js';
import {selectIsInitialized} from './store/app/selectors.js';
```

### Naming Conventions

| Element           | Pattern           | Example            |
| ----------------- | ----------------- | ------------------ |
| Slice folder      | `kebab-case/`     | `app/`             |
| State type        | `{Domain}State`   | `AppState`         |
| Actions export    | `{Domain}Actions` | `AppActions`       |
| Reducer export    | `{domain}Reducer` | `appReducer`       |
| Basic selector    | `select{Field}`   | `selectStatus`     |
| Computed selector | `select{Derived}` | `selectIsIndexing` |

## Daemon State

The daemon does NOT use Redux. It uses:

- `daemon/state.ts` - Simple state container
- Event-based services with TypedEmitter
- CLI polls `daemon.status()` via `DaemonStatusContext`

See ADR-012 for daemon architecture details.

## Consequences

### Positive

- **Type safety** - Full TypeScript inference for actions and selectors
- **React integration** - Works naturally with React components
- **Debuggable** - Redux DevTools compatible
- **Testable** - Reducers are pure functions

### Negative

- **Learning curve** - Developers must understand Redux patterns
- **Boilerplate** - Each domain requires slice + selectors files

### Neutral

- Redux bundle adds ~11KB gzipped
- CLI-only scope keeps daemon simple
