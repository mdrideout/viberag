# LanceDB TypeScript Implementation Strategy

This document outlines the strategy for implementing a LanceDB-based semantic code search system in TypeScript/Node.js. The system will provide local codebase indexing with hybrid search (vector + BM25 + fuzzy) and efficient incremental updates via Merkle tree change detection.

---

## Table of Contents

1. [Technology Decisions](#technology-decisions)
2. [Architecture Overview](#architecture-overview)
3. [Module Specifications](#module-specifications)
4. [Data Schemas](#data-schemas)
5. [Key Algorithms](#key-algorithms)
6. [Implementation Phases](#implementation-phases)
7. [Testing Strategy](#testing-strategy)
8. [References](#references)

---

## Technology Decisions

### Runtime: Node.js

**Decision**: Use Node.js (not Bun) for the following reasons:

- Proven compatibility with Claude Code's MCP infrastructure
- Full native module support for `onnxruntime-node` (used by fastembed)
- Established patterns for Homebrew formula distribution
- Global installation via `npm install -g` is well-understood

### Vector Database: LanceDB

**Package**: `@lancedb/lancedb`

LanceDB provides:
- Embedded vector database (no separate server)
- Vector similarity search + full-text search (BM25)
- Apache Arrow columnar format
- Cross-platform persistence (same format as Python SDK)

### Embeddings: fastembed-js

**Package**: `fastembed`

**Decision**: Use fastembed-js over @huggingface/transformers because:
- Simpler, focused API for embeddings
- Uses ONNX runtime (efficient, no GPU required)
- Default model: `BGE-base-en-v1.5` (768 dimensions)
- Lightweight with minimal dependencies

**Fallback**: If fastembed-js proves unmaintained, migrate to `@huggingface/transformers` with the `feature-extraction` pipeline.

### Code Parsing: web-tree-sitter (WASM)

**Package**: `web-tree-sitter` + language grammars

**Decision**: Use WASM bindings instead of native `tree-sitter` because:
- Official `node-tree-sitter` is unmaintained and broken on Node.js 23+
- Grammar packages ship with prebuilt `.wasm` files (no build step)
- No native compilation = reliable cross-platform installs
- Performance difference is negligible for batch-indexing use case
- ESM support built-in

**Fallback**: If performance proves problematic, evaluate `@keqingmoe/tree-sitter` community fork.

**Grammar packages** (ship with .wasm files):
```
tree-sitter-python
tree-sitter-javascript
tree-sitter-typescript
```

### File System & Hashing

- **File operations**: `node:fs/promises` + `node:path`
- **Hashing**: `node:crypto` with `createHash('sha256')`
- **Glob patterns**: `fast-glob` or `globby`

---

## Architecture Overview

### Directory Structure

```
source/
├── cli/                     # React Ink CLI (existing)
│   ├── app.tsx
│   ├── index.tsx
│   ├── types.ts
│   ├── commands/
│   ├── components/
│   └── hooks/
│
└── rag/                     # RAG engine core
    ├── index.ts             # Package exports
    ├── constants.ts         # LCR_DIR = ".lance-code-rag", file paths
    │
    ├── storage/
    │   ├── index.ts         # Storage class (LanceDB wrapper)
    │   ├── schema.ts        # Arrow schemas for tables
    │   └── types.ts         # CodeChunk, CachedEmbedding interfaces
    │
    ├── merkle/
    │   ├── index.ts         # MerkleTree class
    │   ├── node.ts          # MerkleNode type and serialization
    │   ├── diff.ts          # TreeDiff type, comparison logic
    │   └── hash.ts          # File/directory hash functions
    │
    ├── indexer/
    │   ├── index.ts         # Indexer class, orchestration
    │   ├── chunker.ts       # Tree-sitter based chunking
    │   └── types.ts         # Chunk, IndexStats interfaces
    │
    ├── search/
    │   ├── index.ts         # SearchEngine class
    │   ├── vector.ts        # Vector similarity search
    │   ├── fts.ts           # Full-text BM25 search (includes fuzzy via LanceDB)
    │   ├── hybrid.ts        # RRF reranking
    │   └── types.ts         # SearchResult, SearchResults
    │
    ├── embeddings/
    │   ├── index.ts         # Factory, provider interface
    │   └── local.ts         # FastEmbed provider
    │
    ├── config/
    │   └── index.ts         # LCRConfig, load/save
    │
    ├── manifest/
    │   └── index.ts         # Manifest, load/save
    │
    └── logger/
        └── index.ts         # Session logging for debugging
```

### Storage Layout (On Disk)

```
project-root/
├── .lance-code-rag/
│   ├── config.json          # User configuration
│   ├── manifest.json        # Merkle tree + stats
│   ├── lancedb/             # LanceDB database files
│   │   ├── code_chunks.lance/
│   │   └── embedding_cache.lance/
│   └── logs/                # Session logs (gitignored)
│       └── 2024-12-25.log   # Daily log files
└── (project files)
```

**Note**: The `.lance-code-rag/` directory should be added to `.gitignore`.

---

## Module Specifications

### Storage Module

**Purpose**: LanceDB wrapper for code chunks and embedding cache.

**Tables**:
| Table | Purpose |
|-------|---------|
| `code_chunks` | Indexed code with vectors |
| `embedding_cache` | Content-addressed embedding cache |

**Key Methods**:
```typescript
class Storage {
  connect(): Promise<void>
  close(): void

  // Chunks
  upsertChunks(chunks: CodeChunk[]): Promise<void>
  deleteChunksByFilepath(filepath: string): Promise<number>
  deleteChunksByFilepaths(filepaths: string[]): Promise<number>
  getChunksByFilepath(filepath: string): Promise<CodeChunk[]>
  getAllFilepaths(): Promise<Set<string>>
  countChunks(): Promise<number>

  // Cache
  getCachedEmbeddings(hashes: string[]): Promise<Map<string, number[]>>
  cacheEmbeddings(entries: CachedEmbedding[]): Promise<void>

  // Maintenance
  clearAll(): Promise<void>  // Clears chunks, keeps cache
}
```

---

### Merkle Tree Module

**Purpose**: Efficient change detection via content-addressed tree.

**Core Concept**:
- Files have hash = SHA256(content)
- Directories have hash = SHA256(sorted child name+hash pairs)
- If root hash unchanged, entire codebase unchanged
- If subtree hash unchanged, skip that subtree

**MerkleNode Structure**:
```typescript
interface MerkleNode {
  hash: string;
  type: "file" | "directory";
  path: string;                        // Relative to project root
  children?: Map<string, MerkleNode>;  // Directories only
  size?: number;                       // Files only (bytes)
  mtime?: number;                      // Files only (Unix ms)
}
```

**TreeDiff Structure**:
```typescript
interface TreeDiff {
  new: string[];       // Paths of new files
  modified: string[];  // Paths of modified files
  deleted: string[];   // Paths of deleted files
  hasChanges: boolean;
}
```

**mtime Optimization**:
When building a new tree with a previous tree available:
- If file's `mtime` and `size` match previous node → reuse cached hash
- Skip content hashing for unchanged files
- Dramatically speeds up incremental scans

**Key Methods**:
```typescript
class MerkleTree {
  static build(
    projectRoot: string,
    extensions: string[],
    excludePatterns: string[],
    previousTree?: MerkleTree
  ): Promise<MerkleTree>

  compare(other: MerkleTree): TreeDiff

  toJSON(): object
  static fromJSON(data: object): MerkleTree
}

function computeFileHash(filepath: string): Promise<string>
function computeDirectoryHash(children: Map<string, MerkleNode>): string
function isBinaryFile(filepath: string): Promise<boolean>
function shouldExclude(path: string, patterns: string[]): boolean
```

---

### Chunker Module

**Purpose**: Extract semantic code chunks using tree-sitter.

**Chunk Types**:
- `function` - Top-level functions
- `method` - Methods inside classes
- `class` - Class definitions (includes methods)
- `module` - Fallback for entire file

**Chunk Structure**:
```typescript
interface Chunk {
  text: string;
  type: "function" | "class" | "method" | "module";
  name: string;          // Symbol name, empty for module
  startLine: number;     // 1-indexed
  endLine: number;       // 1-indexed
  contentHash: string;   // SHA256 of text
}
```

**Supported Languages (Phase 1)**:
```typescript
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
};
```

**Key Methods**:
```typescript
class Chunker {
  chunkFile(filepath: string, content?: string): Promise<Chunk[]>
  getLanguageForExtension(ext: string): string | null
}
```

**Fallback Behavior**: If parsing fails or language unsupported, return single module-level chunk containing entire file.

---

### Indexer Module

**Purpose**: Orchestrate the indexing pipeline.

**IndexStats Structure**:
```typescript
interface IndexStats {
  filesScanned: number;
  filesNew: number;
  filesModified: number;
  filesDeleted: number;
  chunksAdded: number;
  chunksDeleted: number;
  embeddingsComputed: number;
  embeddingsCached: number;
}
```

**Progress Callback**:
```typescript
type ProgressCallback = (current: number, total: number, stage: string) => void;
```

**Key Methods**:
```typescript
class Indexer {
  constructor(projectRoot: string, config?: LCRConfig)

  index(options?: {
    force?: boolean;
    progressCallback?: ProgressCallback
  }): Promise<IndexStats>

  close(): void
}
```

**Pipeline Flow**:
```
1. Load previous Merkle tree from manifest (if exists)
2. Build current Merkle tree from filesystem
   - Use mtime optimization with previous tree
3. Compare trees → TreeDiff { new, modified, deleted }
4. If force=true, clear all existing chunks
5. Delete chunks for deleted files
6. For each new/modified file:
   a. Read file content
   b. Compute file hash
   c. Delete existing chunks for this file
   d. Chunk file with tree-sitter
   e. For each chunk:
      - Check embedding cache by content hash
      - If miss: compute embedding, store in cache
   f. Upsert chunks to LanceDB
7. Save updated manifest with new Merkle tree
```

---

### Search Module

**Purpose**: Hybrid search combining multiple strategies.

**SearchResult Structure**:
```typescript
interface SearchResult {
  id: string;              // "{filepath}:{startLine}"
  text: string;
  filepath: string;
  filename: string;
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  ftsScore?: number;
}

interface SearchResults {
  results: SearchResult[];
  query: string;
  searchType: "vector" | "fts" | "hybrid";
  elapsedMs: number;
}
```

**Search Types**:

| Type | Description | Use Case |
|------|-------------|----------|
| `vector` | Semantic similarity via embeddings | "code that handles authentication" |
| `fts` | BM25 keyword search with fuzzy matching | "getUserById" or "getUsrByld" (typos) |
| `hybrid` | Vector + FTS with RRF reranking | Best of both worlds |

**Key Methods**:
```typescript
class SearchEngine {
  constructor(projectRoot: string)

  search(query: string, options?: {
    limit?: number;        // Default: 10
    bm25Weight?: number;   // 0.0-1.0, weight for BM25 vs vector
  }): Promise<SearchResults>

  vectorSearch(query: string, limit: number): Promise<SearchResult[]>
  ftsSearch(query: string, limit: number): Promise<SearchResult[]>  // Includes fuzzy via LanceDB
  hybridSearch(query: string, limit: number, bm25Weight: number): Promise<SearchResult[]>
}
```

**FTS Index**: Created lazily on first FTS/hybrid search, not during indexing.

---

### Embeddings Module

**Purpose**: Generate vector embeddings for code chunks.

**Provider Interface**:
```typescript
interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
}
```

**Local Provider (fastembed-js)**:
```typescript
import { EmbeddingModel, FlagEmbedding } from "fastembed";

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  private model: FlagEmbedding | null = null;

  async initialize(): Promise<void> {
    this.model = await FlagEmbedding.init({
      model: EmbeddingModel.BGEBaseEN
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for await (const batch of this.model!.embed(texts, 32)) {
      results.push(Array.from(batch));
    }
    return results;
  }
}
```

---

### Config Module

**LCRConfig Structure**:
```typescript
interface LCRConfig {
  version: number;
  embeddingProvider: "local" | "openai" | "gemini";
  embeddingModel: string;
  embeddingDimensions: number;
  extensions: string[];
  excludePatterns: string[];
  chunkMaxSize: number;
  watchDebounceMs: number;
}

const DEFAULT_CONFIG: LCRConfig = {
  version: 1,
  embeddingProvider: "local",
  embeddingModel: "BAAI/bge-base-en-v1.5",
  embeddingDimensions: 768,
  extensions: [".py", ".js", ".ts", ".tsx", ".go", ".rs", ".java"],
  excludePatterns: [
    "node_modules", ".git", "__pycache__", "venv", ".venv",
    ".lance-code-rag", "dist", "build", ".next", "coverage"
  ],
  chunkMaxSize: 2000,        // Max chars before splitting large functions
  watchDebounceMs: 500,
};
```

**Note on Chunking**: Tree-sitter produces semantic chunks (functions, classes, methods) rather than sliding-window chunks. `chunkMaxSize` is a fallback for unusually large functions that exceed embedding model limits - these are split at logical boundaries (e.g., between statements).

---

### Manifest Module

**Manifest Structure**:
```typescript
interface ManifestStats {
  totalFiles: number;
  totalChunks: number;
}

interface Manifest {
  version: number;
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp
  tree: object | null;  // Serialized MerkleTree
  stats: ManifestStats;
}
```

---

### Logger Module

**Purpose**: Session logging for debugging and transparency. All operations log to daily files for troubleshooting.

**Design Principles**:
- Never obfuscate exceptions - full stack traces in logs
- Logs should be human-readable and copy/paste friendly for debugging
- Daily rotation with ISO date filenames

**Log Format**:
```
[2024-12-25T10:30:45.123Z] [INFO] Indexer: Starting index of /path/to/project
[2024-12-25T10:30:45.456Z] [INFO] Merkle: Built tree with 150 files
[2024-12-25T10:30:46.789Z] [INFO] Indexer: Processing 12 new files, 3 modified, 0 deleted
[2024-12-25T10:30:50.000Z] [ERROR] Chunker: Failed to parse file.py
  Error: SyntaxError at line 42
  Stack: ...
[2024-12-25T10:31:00.123Z] [INFO] Indexer: Complete - 45 chunks indexed in 15.2s
```

**Key Methods**:
```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug(component: string, message: string, data?: object): void;
  info(component: string, message: string, data?: object): void;
  warn(component: string, message: string, data?: object): void;
  error(component: string, message: string, error?: Error): void;
}

function createLogger(projectRoot: string): Logger;
function getLogPath(projectRoot: string): string;  // Returns path to today's log
```

**Usage**:
```typescript
const logger = createLogger(projectRoot);
logger.info("Indexer", "Starting index", { files: 150 });
logger.error("Chunker", "Parse failed", parseError);
```

---

## Data Schemas

### code_chunks Table (LanceDB)

```typescript
// Arrow schema
{
  id: Utf8,                    // "{filepath}:{startLine}"
  vector: FixedSizeList<Float32>(768),
  text: Utf8,                  // Code content
  content_hash: Utf8,          // SHA256 of text
  filepath: Utf8,              // Relative path
  filename: Utf8,              // Just filename
  extension: Utf8,             // e.g., ".py"
  type: Utf8,                  // function/class/method/module
  name: Utf8,                  // Symbol name
  start_line: Int32,           // 1-indexed
  end_line: Int32,             // 1-indexed
  file_hash: Utf8,             // Hash of source file
}
```

### embedding_cache Table (LanceDB)

```typescript
{
  content_hash: Utf8,          // SHA256 of chunk text (primary key)
  vector: FixedSizeList<Float32>(768),
  created_at: Utf8,            // ISO timestamp
}
```

---

## Key Algorithms

### Reciprocal Rank Fusion (RRF) Reranking

Combines results from vector and FTS search:

```typescript
function rerankRRF(
  vectorResults: SearchResult[],
  ftsResults: SearchResult[],
  limit: number,
  k: number = 60
): SearchResult[] {
  const scores = new Map<string, number>();
  const resultMap = new Map<string, SearchResult>();

  // Score from vector results
  vectorResults.forEach((result, rank) => {
    const rrf = 1 / (k + rank + 1);
    scores.set(result.id, (scores.get(result.id) || 0) + rrf);
    resultMap.set(result.id, result);
  });

  // Score from FTS results
  ftsResults.forEach((result, rank) => {
    const rrf = 1 / (k + rank + 1);
    scores.set(result.id, (scores.get(result.id) || 0) + rrf);
    if (!resultMap.has(result.id)) {
      resultMap.set(result.id, result);
    }
  });

  // Sort by combined RRF score
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({
      ...resultMap.get(id)!,
      score
    }));
}
```

### Merkle Tree Comparison

```typescript
function compareNodes(
  oldNode: MerkleNode,
  newNode: MerkleNode,
  diff: TreeDiff
): void {
  // Quick check: if hashes match, entire subtree unchanged
  if (oldNode.hash === newNode.hash) {
    return;
  }

  // File modified
  if (oldNode.type === "file" && newNode.type === "file") {
    diff.modified.push(newNode.path);
    return;
  }

  // Type changed (file→dir or dir→file)
  if (oldNode.type !== newNode.type) {
    collectAllFiles(oldNode, diff.deleted);
    collectAllFiles(newNode, diff.new);
    return;
  }

  // Both directories: compare children
  const oldChildren = oldNode.children || new Map();
  const newChildren = newNode.children || new Map();

  // New entries
  for (const [name, child] of newChildren) {
    if (!oldChildren.has(name)) {
      collectAllFiles(child, diff.new);
    }
  }

  // Deleted entries
  for (const [name, child] of oldChildren) {
    if (!newChildren.has(name)) {
      collectAllFiles(child, diff.deleted);
    }
  }

  // Recurse into shared entries
  for (const [name, newChild] of newChildren) {
    const oldChild = oldChildren.get(name);
    if (oldChild) {
      compareNodes(oldChild, newChild, diff);
    }
  }
}
```

---

## Implementation Phases

Focus: RAG engine core (`source/rag/`) + CLI integration. MCP server is out of scope for this plan.

### Phase 1: Core Infrastructure
- [ ] Install dependencies (`@lancedb/lancedb`, `fastembed`, `web-tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-javascript`, `fast-glob`)
- [ ] `source/rag/constants.ts` - directory paths, file names
- [ ] `source/rag/logger/index.ts` - session logging
- [ ] `source/rag/config/index.ts` - LCRConfig types, load/save
- [ ] `source/rag/manifest/index.ts` - Manifest types, load/save
- [ ] `source/rag/index.ts` - package exports

### Phase 2: Storage Layer
- [ ] `source/rag/storage/types.ts` - CodeChunk, CachedEmbedding interfaces
- [ ] `source/rag/storage/schema.ts` - Arrow schemas for tables
- [ ] `source/rag/storage/index.ts` - Storage class with LanceDB
- [ ] CRUD operations for chunks
- [ ] CRUD operations for embedding cache

### Phase 3: Merkle Tree
- [ ] `source/rag/merkle/node.ts` - MerkleNode type
- [ ] `source/rag/merkle/hash.ts` - file/directory hash functions
- [ ] `source/rag/merkle/index.ts` - MerkleTree.build()
- [ ] `source/rag/merkle/diff.ts` - tree comparison
- [ ] mtime optimization for incremental scans
- [ ] Binary file detection
- [ ] Exclusion pattern matching

### Phase 4: Code Chunking
- [ ] `source/rag/indexer/chunker.ts` - tree-sitter setup
- [ ] Python language support
- [ ] JavaScript/TypeScript support
- [ ] Fallback module chunks for unsupported files

### Phase 5: Embeddings
- [ ] `source/rag/embeddings/index.ts` - provider interface
- [ ] `source/rag/embeddings/local.ts` - FastEmbed provider
- [ ] Batch embedding support
- [ ] Integration with storage cache

### Phase 6: Indexer
- [ ] `source/rag/indexer/index.ts` - orchestration pipeline
- [ ] Progress callback support
- [ ] Force reindex option
- [ ] Incremental indexing via Merkle diff
- [ ] Integration test: full index → verify chunks created

### Phase 7: Search
- [ ] `source/rag/search/vector.ts` - vector similarity
- [ ] `source/rag/search/fts.ts` - BM25 full-text with fuzzy (via LanceDB)
- [ ] `source/rag/search/hybrid.ts` - RRF reranking
- [ ] `source/rag/search/index.ts` - SearchEngine class
- [ ] Lazy FTS index creation
- [ ] Integration test: index → search → verify results

### Phase 8: CLI Integration
- [ ] `/index` command - run indexer with progress display
- [ ] `/search <query>` command - execute search, display results
- [ ] `/status` command - show index stats (files, chunks, last indexed)
- [ ] `/reindex` command - force full reindex
- [ ] Error display in CLI (full exceptions visible)

---

## Testing Strategy

**Philosophy**: Avoid pointless unit tests. Focus on critical P0 integration tests that validate functionality and prevent regressions.

### Integration Tests (P0 - Critical)

Create tests sparingly for:

1. **Full index → search cycle**
   - Index a sample project, verify search returns expected results
   - Validates the entire pipeline works end-to-end

2. **Incremental indexing**
   - Add file → verify new chunks appear
   - Modify file → verify chunks update
   - Delete file → verify chunks removed
   - Validates Merkle tree change detection

3. **Embedding cache behavior**
   - Index same content twice → verify cache hit (no re-embedding)
   - Modify content → verify cache miss (re-embed)

4. **Regression tests**
   - Add tests when bugs are fixed to prevent recurrence

### Test Fixtures

Sample project for integration tests:
```
fixtures/sample_project/
├── src/
│   ├── main.py           # Functions, classes
│   ├── utils.py          # Helper functions
│   └── models/
│       └── user.py       # Class with methods
├── lib/
│   ├── index.js          # JavaScript
│   └── helpers.ts        # TypeScript
└── README.md             # Should be excluded
```

### When NOT to Write Tests

- Individual hash functions (covered by integration tests)
- Simple CRUD operations (covered by integration tests)
- UI components (manual testing is sufficient)
- Anything that would just test the framework/library behavior

---

## References

### Packages

| Package | Purpose | URL |
|---------|---------|-----|
| `@lancedb/lancedb` | Vector database | https://www.npmjs.com/package/@lancedb/lancedb |
| `fastembed` | Local embeddings | https://www.npmjs.com/package/fastembed |
| `web-tree-sitter` | Code parsing (WASM) | https://www.npmjs.com/package/web-tree-sitter |
| `tree-sitter-python` | Python grammar | https://www.npmjs.com/package/tree-sitter-python |
| `tree-sitter-javascript` | JS grammar | https://www.npmjs.com/package/tree-sitter-javascript |
| `tree-sitter-typescript` | TS grammar | https://www.npmjs.com/package/tree-sitter-typescript |
| `fast-glob` | File globbing | https://www.npmjs.com/package/fast-glob |

### Documentation

- [LanceDB Documentation](https://lancedb.github.io/lancedb/)
- [LanceDB JS API](https://lancedb.github.io/lancedb/js/)
- [web-tree-sitter npm](https://www.npmjs.com/package/web-tree-sitter)
- [Tree-sitter Documentation](https://tree-sitter.github.io/tree-sitter/)
- [fastembed-js GitHub](https://github.com/Anush008/fastembed-js)
- [Transformers.js (fallback)](https://huggingface.co/docs/transformers.js)

### Algorithms

- [Reciprocal Rank Fusion paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [BM25 explanation](https://en.wikipedia.org/wiki/Okapi_BM25)
- [Merkle tree concept](https://en.wikipedia.org/wiki/Merkle_tree)
