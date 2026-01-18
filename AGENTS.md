# AGENTS.md

VibeRAG: React Ink CLI for local codebase RAG.

Check the current date and time.

## Architecture: Vertical Slicing

Interfaces are self-contained features. Delete a folder, delete the feature.

```
source/
├── common/           # Generic React/Ink infrastructure
│   ├── components/   # TextInput, CommandSuggestions
│   ├── hooks/        # useCtrlC, useCommandHistory, etc.
│   └── types.ts      # OutputItem, TextBufferState
│
├── daemon/           # Headless business logic (NO UI)
│   ├── state.ts      # Simple state container
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
│   ├── app.tsx       # Main app component
│   ├── store/        # Redux store (CLI-only)
│   ├── components/   # StatusBar, wizards
│   ├── commands/     # useCommands, handlers
│   └── index.tsx     # Entry point
│
└── mcp/              # MCP server (uses client/, no UI)
    ├── index.ts      # Entry point
    └── server.ts     # MCP tools implementation
```

**Dependency flow**: `common/ ← cli/ ↔ client/ → daemon/` and `mcp/ → client/ → daemon/`

**Principle**: Interfaces don't reach into each other. Delete cli/ → mcp/ still works.

## Critical: ESM Imports

Always use `.js` extension:

```typescript
import {SearchEngineV2} from './services/v2/search/engine.js'; // correct
import {SearchEngineV2} from './services/v2/search/engine'; // breaks at runtime
```

## Import Patterns

### NO BARREL EXPORTS - NEVER

**Barrel files (`index.ts` that re-export from submodules) are FORBIDDEN.**

Barrels cause:

- ALL submodules to load at import time
- Slower startup for MCP server (handshake timeout risk)
- Circular dependency risks
- Harder tree-shaking

**Pattern:**

```typescript
// ❌ FORBIDDEN - barrel imports:
import {SearchEngineV2, StorageV2} from '../daemon/services/v2/index.js';

// ✅ REQUIRED - direct imports:
import {SearchEngineV2} from '../daemon/services/v2/search/engine.js';
import {StorageV2} from '../daemon/services/v2/storage/index.js';

// ❌ FORBIDDEN - barrel exports in index.ts:
export * from './types.js';
export * from './utils.js';

// ✅ REQUIRED - modules export their own content only:
// If index.ts exists, it should ONLY contain the module's own code
```

**Rule:** Every import must point to the file that DEFINES what you're importing.

## Testing Philosophy

**Test system behavior, not library correctness.**

We don't test that tree-sitter parses Python or that LanceDB stores vectors. We test that:

- Our Merkle tree correctly detects file changes
- Our search returns expected files for known queries
- Our incremental indexing only reprocesses what changed
- Our manifest persistence enables recovery

**Principles:**

- Real dependencies, no mocks (real embeddings, real LanceDB)
- E2E/integration tests over unit tests
- Avoid pointless unit tests for simple functions
- Create tests for critical contracts between components
- Add regression tests when failures are encountered

**Test fixtures:** `test-fixtures/codebase/` contains semantically distinct files (math.py, http_client.ts, utils.js) so we can verify search finds the right files.

**Running tests:** `npm test` (~20s with real embeddings)

## Storage

All data lives in `.viberag/` (gitignored).
