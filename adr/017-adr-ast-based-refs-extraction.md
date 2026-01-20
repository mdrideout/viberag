# ADR-017: AST-Based Refs Extraction (Tree-sitter) — Replace Regex

## Status

Accepted

## Context

Search depends on a `refs` table to power usage-style navigation (“where is X used?”) and agent follow-ups (open the surrounding code). An earlier v2 implementation extracted refs by scanning file text with regexes.

Regex-derived refs caused avoidable quality and scaling problems:

- **False positives**: identifiers matched inside comments and string literals.
- **False negatives**: language constructs vary (imports/calls), and regex patterns are brittle across grammars.
- **Size blowups**: “identifier refs” over large repos can dominate `v2_refs`, increasing index size and slowing indexing.
- **Hard to reason about**: regex heuristics make it unclear why a ref exists and make regressions likely.

VibeRAG is greenfield (no backward compatibility requirement). We prefer deterministic facts derived from parsing (“facts not interpretations”).

## Decision

### 1) Extract refs from the AST (tree-sitter), not whole-file regex

For supported languages (tree-sitter WASM grammars), derive `v2_refs` from an AST walk:

- Skip **comment** nodes entirely.
- Avoid treating **string literal content** as code (prevents identifier refs from string contents), while still traversing into **interpolations/substitutions** (e.g., JS/TS template strings) so embedded expressions produce refs.
- Emit refs as deterministic facts:
  - `import` — import bindings (best-effort per grammar)
  - `call` — call callee identifiers (best-effort per grammar)
  - `identifier` — optional; gated to reduce size/noise
  - `string_literal` — optional; disabled by default for v2 (see below)

For member/qualified calls, also emit a deterministic **qualified token** to reduce ambiguity:

- Base callee token: `baz`
- Qualified token (when available): `receiver.method`
  - `foo.bar.baz()` → `bar.baz`
  - `Endpoints.getUser()` → `Endpoints.getUser`

This is stored on a single ref row via `token_texts: list<string>` as `[base, qualified?]`.

Usage retrieval prefers qualified matches and still dedupes by span so agents do not see duplicate occurrences.

For unsupported languages / markdown, `refs` are currently empty (the primary value remains symbols/chunks/files).

### 2) Parse once per file (single analysis API)

Introduce a parse-once API in the chunker:

- `Chunker.analyzeFile(filepath, content, …)` returns:
  - `definition_chunks` (unsplit/unmerged semantic definitions)
  - `chunks` (size-constrained blocks)
  - `refs` (AST-derived refs)

This avoids re-parsing per file for different artifacts and keeps deterministic extraction separate from embedding/storage.

### 3) Prevent “definition == usage” and cap pathological blowups

To keep usage results actionable:

- Exclude identifier refs that point at definition-name tokens (so a definition does not appear as its own “usage”).
- Deterministically dedupe refs by `(start_byte, end_byte, token_texts[0])` with kind priority, and merge `token_texts` deterministically when duplicates occur.
- Support an optional deterministic per-token occurrence cap per file (`max_occurrences_per_token`) for pathological cases, while remaining stable.
- Default v2 extraction uses `identifier_mode = symbolish` (PascalCase / ALL_CAPS) because:
  - calls/imports cover the high-signal, high-recall usage path for lower-case functions
  - symbolish identifiers cover types/constants without indexing every local variable
- v2 extraction disables per-token capping by default (`max_occurrences_per_token = 0`) to avoid silent truncation; result limits are enforced at query time (`k`).

### 4) String literal refs are disabled by default

Exact-text search does not require `v2_refs` string-literal rows because v2 already indexes deterministic `string_literals` arrays on `v2_symbols` and `v2_chunks`.

Therefore, v2 keeps `include_string_literals = false` for refs extraction to reduce `v2_refs` size. This can be revisited if agents need string-literal usages grouped like other refs.

### 5) Schema version bump (full reindex required)

The `v2_refs` Arrow schema changes (from `token_text: string` to `token_texts: list<string>`) and the semantics of refs extraction also change materially (AST-derived vs regex-derived). To avoid mixed indexes and missing columns, bump `V2_SCHEMA_VERSION` and require a full reindex.

## Consequences

### Positive

- Usage results become significantly more precise (no comment/string false positives).
- Index size and indexing time become more predictable.
- Extraction is deterministic and easier to reason about and test.
- AST walk provides a stable foundation for future per-language improvements (more ref kinds, richer import parsing).

### Tradeoffs / Follow-ups

- Import/call extraction is still best-effort across many languages; coverage can be expanded over time by refining per-grammar node handling.
- If per-token capping is enabled in the future, surface a “truncated” signal so agents know results may be incomplete.

## Implementation References

- Chunker analysis + AST refs:
  - `source/daemon/lib/chunker/types.ts`
  - `source/daemon/lib/chunker/index.ts`
- v2 extraction uses parse-once analysis:
  - `source/daemon/services/v2/extract/extract.ts`
- v2 refs schema + usage retrieval:
  - `source/daemon/services/v2/storage/schema.ts`
  - `source/daemon/services/v2/search/engine.ts`
- Regression tests / fixtures:
  - `source/daemon/__tests__/search-exact-text.test.ts`
  - `source/daemon/__tests__/search-modes.test.ts`
  - `test-fixtures/codebase/src/pages/LoginPage.tsx`
  - `test-fixtures/codebase/src/services/user_greeting.ts`
  - `test-fixtures/codebase/src/utils/refs_noise.ts`
