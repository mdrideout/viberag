# AGENTS.md

VibeRAG: React Ink CLI for local codebase RAG.

## Architecture: Vertical Slicing

Features own their entire vertical slice. Delete a folder, delete the feature.

```
source/
├── common/           # Shared infrastructure only
│   ├── components/   # TextInput, StatusBar, etc.
│   ├── hooks/        # useCtrlC, useCommandHistory, etc.
│   └── types.ts
│
├── rag/              # RAG feature (self-contained)
│   ├── components/   # RAG-specific UI
│   ├── commands/     # /index, /search, /init handlers
│   ├── hooks/        # RAG-specific hooks
│   ├── indexer/      # Chunking, orchestration
│   ├── search/       # Vector, FTS, hybrid
│   ├── storage/      # LanceDB wrapper
│   └── index.ts      # Feature exports
│
└── app.tsx           # Shell that composes features
```

**Principle**: Features don't reach into each other. Common infrastructure is truly shared.

## Critical: ESM Imports

Always use `.js` extension:

```typescript
import {SearchEngine} from './search/index.js';  // correct
import {SearchEngine} from './search/index';     // breaks at runtime
```

## Storage

All data lives in `.viberag/` (gitignored).
