# AGENTS.md

VibeRAG: React Ink CLI for local codebase RAG.

Check the current date and time.

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

## Import Patterns

### Avoid Barrel Exports for Performance-Critical Code

Barrel files (`index.ts` that re-export from submodules) cause ALL submodules to load
at import time. This is problematic for:

- MCP server (must start quickly for handshake)
- Any code with native module dependencies (LanceDB, tree-sitter)

**Pattern:**

```typescript
// ❌ Anti-pattern (loads ALL rag modules including native dependencies):
import {configExists, Indexer} from '../rag/index.js';

// ✅ Correct (loads only what's needed):
import {configExists} from '../rag/config/index.js';
import {Indexer} from '../rag/indexer/index.js';
```

**Where this applies:**

- `source/mcp/` - Must use direct imports for fast startup
- `source/cli/` - Can use barrel imports (startup time less critical)

**Why:** Native modules (@lancedb/lancedb, tree-sitter) take 500-1000ms to load.
Barrel imports force loading ALL exports, even if you only need one function.

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
