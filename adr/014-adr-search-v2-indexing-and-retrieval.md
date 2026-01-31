# ADR-014: Search v2 — Multi-Entity Index + Intent-Routed Retrieval

## Status

Accepted

## Context

Search v1 treated “chunks” as the primary product and exposed search tools that returned mostly chunk-like results. This worked for basic semantic retrieval but was not agent-first:

- Agents need **definitions**, **entrypoints**, and **relevant blocks**, not only arbitrary chunks.
- The system must avoid **silent false negatives** (e.g., never hide “test-ish” code via opaque heuristics).
- Agents need **stable handles** for follow-ups (open spans, fetch symbol metadata, expand context).
- Retrieval should be **intent-aware** (definitions vs concepts vs exact text vs similar code).
- Results should be **explainable** (which channels matched and what priors were applied).

This is a greenfield rewrite. Backward compatibility is explicitly **not** required (schemas, MCP tools, CLI flags, IDs, modes may change).

## Decision

### 1) New v2 Data Model: Multi-Entity Tables

Stop treating “chunks” as the only table. Index the entities agents actually navigate:

- **symbols**: canonical definitions (functions/classes/methods/types/etc.)
- **chunks**: semantic blocks (subspans) for large bodies + non-code/doc chunks
- **files**: file-level orientation (imports/exports/top doc + embedding)
- **refs**: fact occurrences (imports/calls/identifiers/string literals) for usage-style navigation

Tables are stored in LanceDB as:

- `v2_symbols`
- `v2_chunks`
- `v2_files`
- `v2_refs`
- `v2_embedding_cache` (shared embedding cache keyed by input hash)

The v2 manifest is stored separately as `~/.local/share/viberag/projects/<projectId>/manifest-v2.json` (override via `VIBERAG_HOME`).

### 2) Stable Handles for Agent Navigation

Search v2 returns stable IDs and locations for follow-ups:

- `symbol_id` identifies a definition row in `v2_symbols`
- `chunk_id` identifies a block row in `v2_chunks`
- `file_id` identifies a file row in `v2_files`
- `file_path` + `start_line/end_line` are always included for `read_file_lines`

### 3) Indexing Pipeline: Deterministic Facts + Cached Embeddings

Indexing is split conceptually into:

1. Extract deterministic facts and spans per file (tree-sitter-backed extraction via the existing chunker)
2. Embed the chosen surfaces with a cache to avoid recomputation

Incremental updates are based on `file_hash` diffs; changed files have prior rows deleted and are reinserted.

Revision handling for working tree indexing:

- `revision` is fixed to `'working'` to avoid mixed-revision rows during incremental updates.
- Actual content changes are tracked via `file_hash`.

Deterministic extraction details:

- For parseable languages, `start_byte/end_byte` are sourced from tree-sitter byte offsets.
- Token facts for `symbols` and `chunks` (`identifiers`, `identifier_parts`, `called_names`, `string_literals`) are extracted from the tree-sitter AST (with a safe fallback for unsupported/markdown content).

### 4) Retrieval: Intent Router + Multi-Channel Recall + Explainable Rerank

Search uses intent routing (`auto` → concrete intent) and parallel candidate generation:

- FTS surfaces (names, identifiers_text, search_text, code_text)
- Vector surfaces (`vec_summary`, `vec_code`, `vec_file`)

Candidates are merged and reranked with:

- Reciprocal-rank fusion across channels
- Soft priors (e.g., exported symbol boost, test-path demotion, file diversity)
- No hard heuristic filtering (filters must be explicit and transparent)

Per-hit explainability includes contributing channels and applied priors.

Operational robustness:

- Embeddings are initialized lazily. Lexical-only intents (`exact_text`, `usage`) do not require embeddings.
- If embeddings are unavailable for vector-requiring intents, search degrades to FTS-only and returns an explicit `warnings[]` payload.
- `exact_text` queries `string_literals` and `code_text` to reduce false negatives for small definitions that do not emit chunk rows.

### 5) MCP Tool Surface: Minimal and Agent-Centric

Expose a small set of composable tools that return stable handles:

- `codebase_search` (intent routed, grouped results + optional explain payload)
- `help` (tool usage guide + how search works)
- `read_file_lines` (read exact file line ranges from disk)
- `get_symbol_details` (fetch a symbol row by `symbol_id`)
- `find_references` (fetch usage refs grouped by file)
- `get_surrounding_code` (neighbors/chunks for a hit)
- `build_index`, `get_status`, `get_watcher_status`, `cancel_operation`

### 6) Evaluation Harness (Shipped with v2)

To keep retrieval quality measurable (not “vibes”), ship a v2 eval harness that:

- Generates query sets from the indexed corpus (definitions/docstrings/string literals/chunks)
- Measures quality metrics (e.g., MRR@10, Recall@50, Hit@5, Hit@20 for usage) and latency percentiles (p50/p95)
- Is accessible via CLI (`/eval`) and daemon RPC (`eval`)

## Consequences

### Positive

- Agent-first results: definitions/files/blocks are first-class outputs.
- No silent exclusions: path-based filters are explicit; heuristic signals only affect ranking.
- Composable navigation: agents can reliably follow up via stable IDs and spans.
- Explainability: agents can iterate on retrieval based on “why” signals.

### Negative / Tradeoffs

- Breaking changes: v1 schemas and MCP tool names are not preserved.
- More complex storage schema: multiple tables and surfaces must be maintained.
- Some extractions are best-effort (notably `refs`), and can be upgraded over time without changing the agent-facing tool surface.
  - Refs extraction moved from regex scanning to tree-sitter AST facts; see ADR-017.

## Implementation References

- V2 services root: `source/daemon/services/v2/`
- V2 manifest: `source/daemon/services/v2/manifest.ts`
- V2 storage schemas: `source/daemon/services/v2/storage/schema.ts`
- V2 search engine: `source/daemon/services/v2/search/engine.ts`
- V2 refs + usages: `source/daemon/services/v2/extract/extract.ts`
- V2 eval harness: `source/daemon/services/v2/eval/eval.ts`
- MCP tools: `source/mcp/server.ts`
- Chunker (tree-sitter): `source/daemon/lib/chunker/index.ts`

## References

- LanceDB Full Text Search: https://docs.lancedb.com/search/full-text-search
- LanceDB Vector Search: https://docs.lancedb.com/search/vector-search
- LanceDB Hybrid Search: https://docs.lancedb.com/search/hybrid-search
- ADR-005: Facts not interpretations
- ADR-009: MCP startup performance (thin client; no heavy imports)
