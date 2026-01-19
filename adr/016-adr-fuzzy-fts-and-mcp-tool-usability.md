# ADR-016: Fuzzy Full-Text Search for Definitions + MCP Tool Usability

## Status

Accepted

## Context

Search v2 relies on multi-channel retrieval (FTS + vectors + hybrid rerank). However:

- The FTS layer previously provided **substring/prefix recall** via **ngram tokenization** on symbol names and qualnames, but it did **not** provide true typo-tolerance via **Levenshtein fuzzy matching**.
- Public-facing documentation states “full-text fuzzy match”, and agents often issue symbol queries with minor typos (e.g., `HtppClient`).
- MCP tool selection can be confusing for agents. We want the tool interface to be self-explanatory, with clear “use when…” guidance and stable follow-up handles.

Greenfield rewrite: backward compatibility is not required. Index schemas and tool surface may change.

## Decision

### 1) Add Dedicated Fuzzy FTS Columns for Symbol Names

We add two dedicated columns to `v2_symbols`:

- `symbol_name_fuzzy`
- `qualname_fuzzy`

These duplicate deterministic values from `symbol_name` / `qualname`, but allow a **separate FTS index configuration** from the ngram/prefix indexes.

FTS configuration for fuzzy columns:

- `baseTokenizer: whitespace`
- `lowercase: true`
- `stem: false`
- `removeStopWords: false`
- conservative `maxTokenLength`

Rationale:

- We avoid applying Levenshtein fuzziness to ngram-tokenized fields (too noisy).
- We keep ngram/prefix indexes for substring recall, and add fuzzy indexes only for typo tolerance.

### 2) Use Fuzzy Matching Only for Definition-Style Queries

Fuzzy FTS is only executed for definition retrieval when the query normalizes to a **single identifier-like token** (optionally qualified with `.`, `::`, `#`), and meets a minimum length threshold.

Rationale:

- Avoids “blatantly wrong” matches on natural-language queries.
- Keeps cost/noise bounded while improving symbol lookup ergonomics.

### 3) Explainability + Reranking Integration

Fuzzy channels are surfaced in `why.channels` as:

- `symbols.name_fuzzy`
- `symbols.qualname_fuzzy`

The reranker assigns explicit RRF weights for these sources so they meaningfully contribute without overpowering exact/substr matches.

### 4) MCP Tool Usability Improvements

We add a new MCP tool:

- `help` — returns a concise tool guide and a summary of how search works (FTS / fuzzy / vector / hybrid).

We also update MCP tool descriptions to embed “use when…” guidance and improve `codebase_search` follow-up ergonomics by expanding `suggested_next_actions` to include file entrypoints when present.

### 5) Schema Version Bump (Reindex Required)

We bump `V2_SCHEMA_VERSION` to require a full reindex whenever these schema changes are introduced, ensuring the new columns exist before search attempts to create FTS indexes.

## Implementation References

- Schema: `source/daemon/services/v2/storage/schema.ts`
- Extraction: `source/daemon/services/v2/extract/extract.ts`
- Indexing persistence: `source/daemon/services/v2/indexing.ts`
- Retrieval + fuzzy routing: `source/daemon/services/v2/search/engine.ts`
- MCP tool guide + descriptions: `source/mcp/server.ts`
- Regression tests:
  - `source/daemon/__tests__/search-modes.test.ts`
  - `source/mcp/__tests__/mcp-server.test.ts`

## Consequences

### Positive

- Definition searches become typo-tolerant in a controlled, explainable way.
- Agents have clearer guidance for tool selection and follow-up navigation.
- Search behavior remains “facts not interpretations”: fuzzy is a retrieval channel, not a hidden filter.

### Tradeoffs

- Requires a full reindex due to schema change.
- Adds two extra FTS indexes on the symbols table (small overhead, bounded by gating).
