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
│   ├── components/   # TextInput, StatusBar, CommandSuggestions
│   ├── hooks/        # useCtrlC, useCommandHistory, useTextBuffer
│   └── types.ts      # OutputItem, TextBufferState
│
├── store/            # Redux state management (see ADR-008)
│   ├── store.ts      # Store configuration
│   ├── hooks.ts      # Typed useAppDispatch, useAppSelector
│   ├── index.ts      # Centralized exports
│   └── {domain}/     # Slice per domain (app, indexing, etc.)
│
├── rag/              # Headless RAG engine (NO UI)
│   ├── indexer/      # Chunking, orchestration
│   ├── search/       # Vector, FTS, hybrid
│   ├── storage/      # LanceDB wrapper
│   └── index.ts      # Public API
│
├── cli/              # CLI interface (self-contained)
│   ├── app.tsx       # Main component
│   ├── components/   # WelcomeBanner (interface-specific)
│   ├── commands/     # Command handlers
│   └── index.tsx     # Entry point
│
└── mcp/              # MCP server (self-contained)
    ├── server.ts     # JSON-RPC server
    └── index.ts      # Entry point
```

### Dependency Flow

```
common/ ← cli/ → rag/
    ↑       ↓      ↓
    └── store/ ←───┘
              ↖
         mcp/ ─┘
```

- **cli/** uses `common/` for UI + `rag/` for business logic + `store/` for state
- **mcp/** uses `rag/` for business logic + `store/` for state (headless, no UI)
- **rag/** dispatches to `store/` directly (no callback threading)
- **common/** uses `store/` for shared state access
- **store/** has zero dependencies on interfaces (decoupled so multiple interfaces can share state)

### Principles

#### 1. Interfaces Are Features

Each interface (cli, mcp) is a complete vertical slice with its own entry point, components, and command handlers. Deleting an interface folder removes that feature entirely without affecting others.

#### 2. Headless Engine

The `rag/` module contains all business logic with no UI dependencies. Any interface can consume it:

```typescript
import {Indexer, SearchEngine} from '../rag/index.js';
```

#### 3. Direct Imports

Use direct imports to specific files rather than barrel re-exports. This improves build performance and avoids circular dependency risks:

```typescript
import TextInput from '../common/components/TextInput.js';
import {useCtrlC} from '../common/hooks/useCtrlC.js';
```

#### 4. Interface-Specific Components

Components that depend on feature state live in the interface folder:

- `cli/components/WelcomeBanner.tsx` - knows about RAG init status
- `common/components/TextInput.tsx` - generic, reusable anywhere

#### 5. Consolidated Command Handling

Each interface owns its command routing. For CLI, `useRagCommands` hook encapsulates all `/command` handling, keeping `app.tsx` focused on composition.

### Adding a New Interface

To add a new interface (e.g., `web/`):

1. Create `source/web/` with entry point
2. Import from `rag/` for business logic
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
