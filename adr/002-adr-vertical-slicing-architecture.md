# ADR-002: Vertical Slicing Architecture

## Status

Accepted

## Context

VibeRAG needs an architecture that scales as the application grows. Key requirements:

1. **Multiple interfaces** - CLI today, MCP server next, potentially web/API later
2. **Feature isolation** - Delete a folder, delete a feature
3. **Clear ownership** - Each module has a single responsibility
4. **Minimal coupling** - Interfaces don't reach into each other

## Decision

We adopt a vertical slicing architecture where interfaces are self-contained features that consume a shared headless engine.

### Structure

```
source/
├── common/           # Generic React/Ink infrastructure
│   ├── components/   # TextInput, CommandSuggestions
│   ├── hooks/        # useCtrlC, useCommandHistory, useTextBuffer
│   └── types.ts      # OutputItem, TextBufferState
│
├── daemon/           # Headless business logic (NO UI)
│   ├── state.ts      # Simple state container (see ADR-012)
│   ├── owner.ts      # Wires events to state
│   ├── services/     # Indexing, search, storage, watcher
│   ├── providers/    # Embedding providers (local, gemini, etc.)
│   ├── lib/          # Pure utilities (merkle, chunker, config)
│   └── __tests__/    # All daemon tests
│
├── client/           # Thin IPC client
│   ├── index.ts      # DaemonClient class
│   └── types.ts      # Client types
│
├── cli/              # CLI interface (self-contained)
│   ├── app.tsx       # Main component
│   ├── store/        # Redux store (CLI-only, see ADR-008)
│   ├── components/   # StatusBar, wizards
│   ├── commands/     # Command handlers
│   └── index.tsx     # Entry point
│
└── mcp/              # MCP server (self-contained)
    ├── server.ts     # MCP tools implementation
    └── index.ts      # Entry point
```

### Dependency Flow

```
common/ ← cli/ ↔ client/ → daemon/
              ↓
         cli/store/
              ↖
    mcp/ → client/ → daemon/
```

- **cli/** uses `common/` for UI + `client/` for IPC + `cli/store/` for Redux state
- **mcp/** uses `client/` for IPC to daemon (headless, no UI, no Redux)
- **daemon/** uses event-based architecture with TypedEmitter (see ADR-012)
- **client/** thin IPC layer over Unix socket
- **cli/store/** CLI-only Redux for wizard and app state

### Principles

#### 1. Interfaces Are Features

Each interface (cli, mcp) is a complete vertical slice with its own entry point, components, and command handlers. Deleting an interface folder removes that feature entirely without affecting others.

#### 2. Headless Engine

The `daemon/` module contains all business logic with no UI dependencies. Interfaces communicate via `client/`:

```typescript
import {DaemonClient} from '../client/index.js';
const client = new DaemonClient();
await client.search({query: 'auth'});
```

#### 3. Direct Imports (NO BARREL EXPORTS)

Use direct imports to specific files. Barrel exports are FORBIDDEN:

```typescript
// ✅ Direct imports
import TextInput from '../common/components/TextInput.js';
import {useCtrlC} from '../common/hooks/useCtrlC.js';
import {SearchEngine} from '../daemon/services/search/index.js';

// ❌ FORBIDDEN - barrel imports
import {SearchEngine, Storage} from '../daemon/services/index.js';
```

#### 4. Interface-Specific Components

Components that depend on feature state live in the interface folder:

- `cli/components/WelcomeBanner.tsx` - knows about RAG init status
- `common/components/TextInput.tsx` - generic, reusable anywhere

#### 5. Consolidated Command Handling

Each interface owns its command routing. For CLI, `useCommands` hook encapsulates all `/command` handling, keeping `app.tsx` focused on composition.

### Adding a New Interface

To add a new interface (e.g., `web/`):

1. Create `source/web/` with entry point
2. Import from `client/` for IPC to daemon
3. Import from `common/` if UI components are needed
4. Add entry point to `package.json` bin

No changes to existing interfaces required.

## Consequences

### Positive

- **Scalable**: New interfaces follow the same pattern
- **Testable**: Each module tested in isolation
- **Clear boundaries**: Imports reveal ownership
- **Deletable features**: Remove interface folder, feature is gone

### Negative

- **Discipline required**: Developers must respect module boundaries

### Neutral

- ESM imports require `.js` extension (TypeScript constraint)
