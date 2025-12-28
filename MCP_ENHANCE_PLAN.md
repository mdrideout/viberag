# VibeRAG MCP Enhancement Plan

## Executive Summary

This plan enhances VibeRAG's MCP tools to support diverse AI agent coding tasks. The design follows a core principle: **store facts, not interpretations**. We provide powerful, transparent search primitives and let the AI agent interpret results and construct queries.

### Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Store facts, not interpretations** | Pre-computed categories (e.g., `file_category='test'`) can be wrong, causing silent false negatives. Store raw facts; let AI interpret. |
| **Transparent filtering** | AI sees exactly what's filtered via explicit path patterns, not opaque categories. |
| **No silent false negatives** | The worst failure mode is excluding relevant code without the AI knowing. Avoid heuristic classifications. |
| **AI interprets, system retrieves** | We don't decide what's a "test file" or "API endpoint". We provide search; AI decides. |
| **Multi-stage over detection** | Progressive narrowing with powerful filters beats brittle pattern detection. |

---

## Current State

### Schema (code_chunks table)
```
id, vector, text, content_hash, filepath, filename, extension,
type, name, start_line, end_line, file_hash
```

### Search Capability
- Single hybrid search (vector + BM25 with RRF fusion)
- Parameters: `query`, `limit`, `bm25_weight`

### Gaps
- No search mode differentiation (semantic vs exact vs definition)
- No exhaustive mode for refactoring tasks
- No metadata filtering (path, type, extension)
- No symbol definition/usage tracking
- Single-stage retrieval only

---

## Phase 1: Safe Metadata Enrichment

**Goal**: Add only deterministic, AST-derived metadata that cannot be wrong.

### New Schema Fields

| Field | Type | Source | Purpose |
|-------|------|--------|---------|
| `signature` | Utf8 | AST | Function/method signature line for quick preview |
| `docstring` | Utf8 (nullable) | AST | Extracted documentation for semantic enrichment |
| `is_exported` | Bool | AST | True if `export` keyword present (JS/TS) or public (Python `__all__`) |
| `decorator_names` | Utf8 (nullable) | AST | Comma-separated decorator/annotation names |

### Why These Are Safe

All fields are **deterministic extractions** from the AST:

- `signature`: The literal text of the function signature line
- `docstring`: The literal text of the first docstring/JSDoc comment
- `is_exported`: Boolean check for `export` keyword presence
- `decorator_names`: List of decorator node names, no interpretation

If extraction is wrong, it's a bug to fix—not a heuristic that varies by codebase.

### What We Explicitly Do NOT Add

| Rejected Field | Reason |
|----------------|--------|
| `file_category` | Heuristic. "Is this a test file?" depends on conventions we can't know. |
| `service_name` | Heuristic. Requires config or convention inference that could be wrong. |
| `language` | Redundant. We already have `extension`. AI can map if needed. |
| `complexity_tier` | Arbitrary. "Simple vs complex" is subjective and low-value. |
| `is_api_endpoint` | Heuristic. Requires framework-specific pattern detection. |
| `event_type` | Heuristic. Framework-specific, highly fragile. |

### Extraction Implementation

**Signature extraction** (tree-sitter):
```
function_definition → first line up to opening brace/colon
class_definition → first line (class Name extends Base)
method_definition → first line of method
```

**Docstring extraction**:
- Python: First expression if it's a string literal
- JS/TS: JSDoc comment immediately preceding function
- Go: Comment block immediately preceding function

**is_exported**:
- JS/TS: Node has `export` modifier or is in `export { }` statement
- Python: Name is in module's `__all__` list (if present)

**decorator_names**:
- Python: `@decorator` → extract "decorator"
- TS: `@Decorator()` → extract "Decorator"
- Java: `@Annotation` → extract "Annotation"

### Implementation Tasks

- [ ] Extend `createCodeChunksSchema()` with new fields
- [ ] Add `extractSignature()` to Chunker
- [ ] Add `extractDocstring()` to Chunker
- [ ] Add `extractIsExported()` to Chunker
- [ ] Add `extractDecoratorNames()` to Chunker
- [ ] Update `Indexer.processFileBatch()` to populate new fields
- [ ] Increment schema version, require reindex on upgrade

---

## Phase 2: Search Modes & Filtering

**Goal**: Expose different search strategies and transparent filters that AI agents control.

### Search Modes

| Mode | Implementation | Best For |
|------|----------------|----------|
| `semantic` | Dense vector search only | "How does auth work?", conceptual queries |
| `exact` | BM25/FTS only | Symbol names, exact strings, exhaustive search |
| `hybrid` | Vector + BM25 with RRF (default) | Mixed queries |
| `definition` | Metadata filter: `type IN (...) AND name = ?` | "Where is X defined?" |
| `similar` | Vector search with code snippet as query | "Find code like this" |

### Exhaustiveness Control

| Setting | Behavior | Use Case |
|---------|----------|----------|
| `exhaustive: false` (default) | Top-K by relevance score | Exploration, understanding |
| `exhaustive: true` | All matches above threshold | Refactoring, auditing, rename-all |

When `exhaustive: true`:
- No early termination
- Returns all matches up to `limit` (which can be set high)
- Includes `total_matches` count in response for verification

### Filter Parameters

Filters are **transparent and AI-controlled**. The AI sees exactly what's being filtered.

```typescript
interface SearchFilters {
  // Path-based filtering (replaces opaque categories)
  path_prefix?: string;           // e.g., "src/api/"
  path_contains?: string[];       // Must contain ALL strings
  path_not_contains?: string[];   // Must not contain ANY string
  path_glob?: string;             // Glob pattern, e.g., "src/**/*.ts"

  // Code structure filtering
  type?: ('function' | 'class' | 'method' | 'module')[];
  extension?: string[];           // e.g., [".ts", ".tsx"]

  // Metadata filtering (Phase 1 fields)
  is_exported?: boolean;          // Only exported/public symbols
  decorator_contains?: string;    // Decorator name contains string
  has_docstring?: boolean;        // Has documentation
}
```

### Filter Examples

Instead of opaque categories, AI constructs explicit filters:

```
"Find auth code, not tests"
→ filters: {
    path_contains: ["auth"],
    path_not_contains: ["test", "__tests__", "spec", ".test.", ".spec."]
  }

"Find API endpoints"
→ filters: {
    path_prefix: "src/api/",
    type: ["function", "method"]
  }
  OR
→ filters: {
    decorator_contains: "Get"  // or "Post", "route", etc.
  }

"Find exported functions in the payments service"
→ filters: {
    path_contains: ["payment"],
    type: ["function"],
    is_exported: true
  }
```

### Updated Tool Schema

```typescript
interface ViberagSearchParams {
  // Query
  query: string;                  // Natural language or keywords
  code_snippet?: string;          // For mode='similar' only

  // Mode selection
  mode?: 'semantic' | 'exact' | 'hybrid' | 'definition' | 'similar';

  // Result control
  limit?: number;                 // 1-100, default 10
  exhaustive?: boolean;           // Return all matches, default false
  min_score?: number;             // Score threshold 0-1, default 0

  // Filtering
  filters?: SearchFilters;
}

interface ViberagSearchResponse {
  results: SearchResult[];
  query: string;
  mode: string;
  total_matches?: number;         // When exhaustive=true
  elapsed_ms: number;
}
```

### Implementation Tasks

- [ ] Add `mode` parameter to `SearchEngine.search()`
- [ ] Implement `searchSemantic()` — vector-only path
- [ ] Implement `searchExact()` — BM25-only path
- [ ] Implement `searchDefinition()` — metadata filter path
- [ ] Implement `searchSimilar()` — embed code_snippet, vector search
- [ ] Add `exhaustive` mode with full scan
- [ ] Implement filter builder for LanceDB WHERE clauses
- [ ] Add path pattern matching (prefix, contains, glob)
- [ ] Update MCP tool schema and description
- [ ] Deprecate `bm25_weight` parameter (replaced by `mode`)

---

## Phase 3: Symbol Index

**Goal**: Enable precise symbol definition/usage lookup without vector search.

### Why This Is Worth Building

Symbol lookup is:
- **Deterministic**: "Where is X defined?" has a factual answer
- **High-value**: Most common coding assistant query pattern
- **Hard to replicate**: Exact search finds occurrences but can't distinguish definition from usage

### Symbol Roles

The same symbol name appears in code with different **roles**:

```typescript
// DEFINITION — where the symbol is created
export class UserService { ... }

// EXPORT — where it's made available (often same as definition)
export { UserService };

// IMPORT — where another file brings it into scope
import { UserService } from './services';

// USAGE — where it's actually referenced
const svc = new UserService();
```

### New Table: `symbols`

```
id              Utf8    "{filepath}:{name}:{line}"
name            Utf8    Symbol name (e.g., "UserService")
qualified_name  Utf8    Full path (e.g., "UserService.authenticate")
kind            Utf8    "class" | "function" | "method" | "type" | "interface" | "variable"
role            Utf8    "definition" | "export" | "import" | "usage"
filepath        Utf8    File containing symbol
line            Int32   Line number
is_exported     Bool    Is this symbol exported (for definitions)
chunk_id        Utf8    FK to code_chunks.id for context retrieval
```

### New Tool: `viberag_symbol_lookup`

```typescript
interface SymbolLookupParams {
  name: string;                   // Symbol name (exact match)
  kind?: ('class' | 'function' | 'method' | 'type' | 'interface' | 'variable')[];
  role?: ('definition' | 'export' | 'import' | 'usage')[];
  filters?: {
    path_prefix?: string;
    path_contains?: string[];
    extension?: string[];
  };
  include_context?: boolean;      // Return chunk text (more tokens)
  limit?: number;                 // Default 50
}

interface SymbolLookupResponse {
  symbols: {
    name: string;
    qualified_name: string;
    kind: string;
    role: string;
    filepath: string;
    line: number;
    context?: string;             // If include_context=true
  }[];
  total_count: number;
}
```

### Use Cases

| Query | Parameters |
|-------|------------|
| "Where is UserService defined?" | `name="UserService", role=["definition"]` |
| "What files import PaymentClient?" | `name="PaymentClient", role=["import"]` |
| "Find all usages of deprecated apiV1" | `name="apiV1", role=["usage"], exhaustive=true` |
| "What does the auth module export?" | `filters={path_prefix: "src/auth/"}, role=["export"]` |

### Implementation Tasks

- [ ] Create `symbols` table schema
- [ ] Create `SymbolExtractor` class for tree-sitter analysis
- [ ] Extract definitions (class, function, method, type declarations)
- [ ] Extract exports (export statements, export modifiers)
- [ ] Extract imports (import statements)
- [ ] Optionally extract usages (identifier references) — may be expensive
- [ ] Add `viberag_symbol_lookup` MCP tool
- [ ] Index symbol names for fast text search

---

## Phase 4: Multi-Stage Retrieval Support

**Goal**: Enable progressive narrowing for complex queries.

### The Pattern

Complex coding tasks require multiple search stages:

```
Stage 1 (Discover): Broad search to find the general area
  "checkout flow" → Returns frontend, API, service code

Stage 2 (Refine): Narrow within discovered context
  "database operations" + filters from stage 1 → Returns specific DB code

Stage 3 (Expand): Follow relationships from refined results
  "What calls this function?" → Returns callers
```

### Stage Hint Parameter

```typescript
interface SearchParams {
  // ... existing params ...

  stage?: 'discover' | 'refine';
}
```

| Stage | Behavior |
|-------|----------|
| `discover` | Higher limit (2x), relaxed score threshold, prefer diversity |
| `refine` | Normal behavior, strict matching |

### Context Narrowing

Allow filtering to files related to previous results:

```typescript
interface SearchParams {
  // ... existing params ...

  // Narrow to files from previous search
  context_filepaths?: string[];   // Limit to these files
  context_path_prefix?: string;   // Derived from previous results
}
```

### Workflow Example

```
Task: "How does data flow from checkout to database?"

1. viberag_search(query="checkout form submit", stage="discover")
   → Returns chunks in: src/frontend/checkout/, src/api/orders/

2. viberag_search(query="API call fetch post",
                  filters={path_prefix: "src/frontend/checkout/"})
   → Finds: calls POST /api/orders

3. viberag_search(query="orders endpoint handler",
                  filters={path_prefix: "src/api/"})
   → Finds: OrderController.create()

4. viberag_symbol_lookup(name="OrderService", role=["usage"],
                         filters={path_prefix: "src/api/orders/"})
   → Finds: OrderService.createOrder() call

5. viberag_search(query="database insert save",
                  filters={path_contains: ["order", "service"]})
   → Finds: OrderRepository.insert() → Postgres
```

Each stage narrows based on what was learned. No special detection needed.

### Implementation Tasks

- [ ] Add `stage` parameter with discover/refine behavior
- [ ] Implement diversity-aware ranking for discover stage
- [ ] Add `context_filepaths` filter
- [ ] Document multi-stage patterns in tool descriptions

---

## Phase 5: Performance & Operations

**Goal**: Ensure the system scales and is observable.

### Index Optimization

- [ ] Add LanceDB IVF_PQ vector index for indexes >10k chunks
- [ ] Pre-build FTS index during indexing (not at first query)
- [ ] Add index statistics to status output

### Query Caching

- [ ] Cache recent query embeddings (LRU, 100 entries)
- [ ] Cache filter query results with short TTL

### Observability

- [ ] Log all MCP tool invocations with parameters
- [ ] Track search latency by mode
- [ ] Add `viberag_debug` tool for index inspection

### Implementation Tasks

- [ ] Benchmark on 10k, 50k, 100k chunk indexes
- [ ] Implement embedding cache for queries
- [ ] Add structured logging
- [ ] Create debug/inspection tool

---

## Phase 6: Documentation — ADR

**Goal**: Document the indexing strategy decisions for future maintainers and users.

### Create ADR-005: Indexing Strategy

Document:

1. **What we index and why**
   - Deterministic AST-derived metadata
   - Symbol definitions and usages
   - The "facts not interpretations" principle

2. **What we chose NOT to index and why**
   - File categories (test/source/config)
   - Service names
   - Event publishers/subscribers
   - API endpoints
   - The risks of heuristic classification

3. **The filtering philosophy**
   - Transparent, AI-controlled filters
   - Path-based filtering over categories
   - Why silent false negatives are the worst failure mode

4. **Multi-stage over detection**
   - Why progressive narrowing beats pattern detection
   - The fragility of framework-specific detection
   - Letting AI interpret vs system classify

### Implementation Tasks

- [ ] Write ADR-005-indexing-strategy.md
- [ ] Include examples of safe vs risky metadata
- [ ] Document the filter design rationale
- [ ] Add decision record for removed features (event/API detection)

---

## Implementation Priority

| Phase | Effort | Impact | Priority |
|-------|--------|--------|----------|
| Phase 1: Safe Metadata | Medium | High | P0 |
| Phase 2: Search Modes & Filters | Medium | High | P0 |
| Phase 3: Symbol Index | High | High | P1 |
| Phase 4: Multi-Stage | Low | Medium | P1 |
| Phase 5: Performance | Medium | Medium | P2 |
| Phase 6: ADR Documentation | Low | High | P0 |

**Recommended order**: Phase 6 (ADR) → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

Write the ADR first to solidify decisions before implementation.

---

## Migration Strategy

### Schema Versioning

Increment `schemaVersion` in manifest when schema changes:
```json
{
  "schemaVersion": 2,
  "..."
}
```

On version mismatch: prompt for `/reindex`.

### Backward Compatibility

- `bm25_weight` parameter continues to work (maps to hybrid mode with weight)
- New parameters are optional with sensible defaults
- Old indexes work for basic search until reindex

---

## Appendix A: Final Tool Summary

| Tool | Purpose | Key Differentiator |
|------|---------|-------------------|
| `viberag_search` | General code search | Mode selection, transparent filters |
| `viberag_symbol_lookup` | Symbol definition/usage lookup | Direct metadata query, no vector search |
| `viberag_index` | Index codebase | Unchanged |
| `viberag_status` | Index status | Add schema version, index stats |
| `viberag_watch_status` | File watcher status | Unchanged |

### Removed from Original Plan

| Removed Tool | Reason |
|--------------|--------|
| `viberag_event_trace` | Fragile framework-specific detection; AI can search instead |
| `viberag_endpoint_lookup` | Fragile detection; decorator_contains filter + search suffices |
| `viberag_expand_context` | Over-engineered; multi-stage search achieves same goal |
| `viberag_composite_search` | Over-engineered; AI can make multiple calls |

---

## Appendix B: AI Agent Tool Descriptions

These descriptions should be used in the MCP tool definitions to help AI agents select the right tool.

### viberag_search

```
Search code by meaning or keywords. Primary search tool.

MODE SELECTION:
- 'semantic': For conceptual queries ("how does auth work"). Finds code by meaning.
- 'exact': For symbol names, specific strings ("handlePayment"). Keyword-based, fast.
- 'hybrid' (default): Combines semantic + keyword. Good general purpose.
- 'definition': For "where is X defined". Direct lookup, fastest.
- 'similar': For "find code like this". Pass code_snippet parameter.

EXHAUSTIVE MODE:
Set exhaustive=true for refactoring tasks that need ALL matches.
Default (false) returns top results by relevance.

FILTERS (transparent, you control what's excluded):
- path_prefix: Scope to directory (e.g., "src/api/")
- path_contains: Must contain strings (e.g., ["auth"])
- path_not_contains: Exclude paths with strings (e.g., ["test", "__tests__"])
- type: Code structure (["function", "class", "method"])
- extension: File types ([".ts", ".py"])
- is_exported: Only public/exported symbols
- decorator_contains: Has decorator matching string (e.g., "Get", "route")

MULTI-STAGE PATTERN:
For complex queries, call multiple times with progressive filtering:
1. Broad search to discover area
2. Narrow with path filters from results
3. Refine with specific terms

For precise symbol lookup, prefer viberag_symbol_lookup.
```

### viberag_symbol_lookup

```
Find where symbols are defined, exported, imported, or used.

WHEN TO USE:
- "Where is UserService defined?" → name='UserService', role=['definition']
- "What imports PaymentClient?" → name='PaymentClient', role=['import']
- "Find all usages of apiV1" → name='apiV1', role=['usage']

FASTER than viberag_search for symbol queries (indexed metadata lookup).

PARAMETERS:
- name: Symbol name (exact match, required)
- kind: Filter by type ('class', 'function', 'method', 'type', 'interface', 'variable')
- role: Filter by role ('definition', 'export', 'import', 'usage')
- include_context: Set true to get surrounding code (uses more tokens)
- filters: Path-based filters (path_prefix, path_contains, extension)

Returns filepath, line number, kind, role, and optionally code context.
```

---

## Appendix C: ADR-005 Outline

The ADR should cover:

### Title
ADR-005: Code Indexing Strategy — Facts Not Interpretations

### Status
Proposed

### Context
- AI agents need code search for diverse tasks
- Pre-computed metadata can improve search precision
- But heuristic classifications risk silent false negatives

### Decision
1. Index only deterministic, AST-derived metadata
2. Do not index interpreted categories (file_category, service_name)
3. Provide transparent path-based filters instead of opaque categories
4. Let AI agents interpret results rather than system classifying code
5. Use multi-stage search instead of brittle pattern detection

### Consequences
- Positive: No silent false negatives from misclassification
- Positive: AI agents have full control over filtering
- Positive: System is framework-agnostic, no maintenance for new patterns
- Negative: AI must construct filters explicitly (more verbose)
- Negative: No pre-computed event/API graphs (AI must search iteratively)

### Alternatives Considered
- Pre-computed file categories → Rejected (heuristic, could be wrong)
- Event detection → Rejected (framework-specific, fragile)
- API endpoint detection → Rejected (fragile, search suffices)
