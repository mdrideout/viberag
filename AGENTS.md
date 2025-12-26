# AGENTS.md

VibeRAG: React Ink CLI for local codebase RAG.

## Architecture: Vertical Slicing

Interfaces are self-contained features. Delete a folder, delete the feature.

```
source/
├── common/           # Generic React/Ink infrastructure
│   ├── components/   # TextInput, StatusBar, CommandSuggestions
│   ├── hooks/        # useCtrlC, useCommandHistory, etc.
│   └── types.ts      # OutputItem, TextBufferState
│
├── rag/              # Headless RAG engine (NO UI)
│   ├── indexer/      # Chunking, orchestration
│   ├── search/       # Vector, FTS, hybrid
│   ├── storage/      # LanceDB wrapper
│   ├── embeddings/   # Local embedding provider
│   ├── merkle/       # Change detection
│   └── index.ts      # Public API
│
├── cli/              # CLI interface (self-contained)
│   ├── app.tsx       # Main app component
│   ├── components/   # WelcomeBanner
│   ├── commands/     # handlers, useRagCommands
│   └── index.tsx     # Entry point
│
└── mcp/              # Future: MCP server (uses rag/, no UI)
```

**Dependency flow**: `common/ ← cli/ → rag/` and `mcp/ → rag/`

**Principle**: Interfaces don't reach into each other. Delete cli/ → mcp/ still works.

## Critical: ESM Imports

Always use `.js` extension:

```typescript
import {SearchEngine} from './search/index.js'; // correct
import {SearchEngine} from './search/index'; // breaks at runtime
```

## Storage

All data lives in `.viberag/` (gitignored).
