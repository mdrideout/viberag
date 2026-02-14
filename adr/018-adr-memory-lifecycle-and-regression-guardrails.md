# ADR-018: Memory Lifecycle Contracts and Regression Guardrails

## Status

Accepted

## Context

We observed sustained memory growth in long-lived `node` processes running VibeRAG daemon + MCP workloads across multiple machines, including cases that exhausted system memory.

The failure mode was mostly visible as RSS/external growth (native/WASM memory), not only JS heap growth. That makes lifecycle ownership and release of native-backed resources a first-class architecture concern.

Primary pressure points:

- Tree-sitter parse trees in chunking/analysis paths.
- LanceDB table/connection handles during repeated index/search lifecycle churn.
- Indexing pipeline retaining large intermediate arrays/maps longer than needed.
- Search candidate materialization pulling wider rows than required.
- Daemon in-memory failure history growing without a cap.

Because daemon/MCP processes are long-lived, relying on process restart is not acceptable. Memory behavior must be bounded by design and protected by regression checks.

## Decision

### 1) Enforce parse tree ownership and deterministic release

`Chunker` parse paths now treat parse trees as owned resources and always release them via `tree.delete()` in `try/finally`.

- Applied in `chunkFile(...)` and `analyzeFile(...)`.
- This prevents native parse-tree accumulation during repeated analyze/index loops.

### 2) Make storage shutdown explicit and idempotent

`StorageV2.close()` now explicitly closes all table handles and the DB connection before nulling references.

- Added guarded `safeClose(...)` to tolerate close-time errors without masking shutdown flow.
- This hardens repeated connect/index/search/close cycles.

### 3) Bound daemon failure retention

Daemon failure history is now capped (`MAX_FAILURE_HISTORY = 100`) instead of unbounded growth.

- Prevents unbounded in-memory retention from repeated slot failures.

### 4) Reduce indexing peak and retained memory

Indexing was refactored to retain less intermediate data at once.

- Removed intermediate `embedItems` accumulation.
- Deduplicates embedding inputs directly into `uniqueByHash`.
- Persists rows in batches (`PERSIST_BATCH_SIZE = 500`) instead of one large terminal upsert.
- Clears large temporary structures (`uniqueByHash`, `cached`, `extracted`) once no longer needed.

This keeps peak memory lower and shortens retention windows for large objects.

### 5) Tighten search materialization footprint

Search candidate queries now use explicit `.select(...)` projections for FTS/vector paths.

- Returns only fields needed by candidate normalization/ranking.
- Includes LanceDB score/distance columns (`_score`, `_distance`) explicitly.

This reduces unnecessary row materialization and per-query memory footprint.

### 6) Add memory regression guardrails

Add lightweight and repeatable regression checks focused on post-GC drift.

- `source/daemon/__tests__/chunker-memory-regression.test.ts`
- `source/daemon/__tests__/indexing-memory-regression.test.ts`
- `npm run test:memory` for quick CI/local verification.
- `scripts/memory/profile.mjs` and `npm run memory:profile` for deeper repeated-run diagnostics.

The guardrails test for bounded growth trends rather than absolute machine-specific peaks.

### 7) Expose daemon memory snapshot in status responses

Daemon `status` now includes a lightweight memory snapshot (`rssMB`, `heapUsedMB`, `externalMB`, `arrayBuffersMB`) so operators can observe drift without attaching profilers.

- Included in daemon IPC status payload.
- Surfaced by MCP `get_status` under `daemon.memory`.

## Consequences

### Positive

- Native memory from parsing/indexing/search lifecycles is less likely to grow without bound.
- Daemon shutdown and storage lifecycle behavior are explicit.
- Large indexing workloads have lower peak retention and better release behavior.
- Memory regressions become easier to detect before release.

### Tradeoffs

- More frequent persistence batches can add some overhead versus one large write.
- Memory thresholds in regression tests may need calibration if workloads/platforms change.
- Lifecycle ownership is stricter; future code paths must preserve these contracts.

## Implementation References

- Parse-tree lifecycle:
  - `source/daemon/lib/chunker/index.ts`
- Daemon state cap:
  - `source/daemon/owner.ts`
- Indexing retention + batching:
  - `source/daemon/services/v2/indexing.ts`
- Search projection tightening:
  - `source/daemon/services/v2/search/engine.ts`
- Storage close semantics:
  - `source/daemon/services/v2/storage/index.ts`
- Regression tests/scripts:
  - `source/daemon/__tests__/chunker-memory-regression.test.ts`
  - `source/daemon/__tests__/indexing-memory-regression.test.ts`
  - `scripts/memory/profile.mjs`
  - `package.json`
  - `vitest.config.ts`
  - `.github/workflows/ci.yml`
- Daemon/MCP status memory snapshot:
  - `source/daemon/owner.ts`
  - `source/client/types.ts`
  - `source/mcp/server.ts`

## References

- ADR-009: MCP Server Startup Performance
- ADR-010: Daemon Architecture
- ADR-013: Cooperative Cancellation
- ADR-014: Search v2 Indexing and Retrieval
- ADR-017: AST-Based Refs Extraction
