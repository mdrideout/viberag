# Memory Diagnostics Scripts

This folder contains repeatable memory diagnostics for daemon + MCP search/indexing workloads.

Reference ADR: `adr/018-adr-memory-lifecycle-and-regression-guardrails.md`

## Scripts

### `profile.mjs`

Purpose:

- Repeated in-process memory profiling for chunking and indexing loops.
- Useful for post-GC drift checks while iterating on lifecycle fixes.

Run:

```bash
npm run memory:profile
```

Optional env:

- `VIBERAG_MEM_RUNS` (default `3`)
- `VIBERAG_MEM_ITERATIONS` (default `200`)

Notes:

- Uses `--expose-gc` via npm script.
- Prints JSON samples (`rssMB`, `heapUsedMB`, `externalMB`, `arrayBuffersMB`).

### `isolate-intent-growth.mjs`

Purpose:

- Reproduces memory behavior per search intent on a fresh daemon process.
- Kills daemon between scenarios to avoid cross-run contamination.
- Captures before/after RSS from both `ps` and daemon status.

Run:

```bash
npm run memory:isolate
```

Useful env:

- `VIBERAG_ISOLATE_QUERY`
- `VIBERAG_ISOLATE_INTENTS` (comma-separated, e.g. `exact_text,concept`)
- `VIBERAG_ISOLATE_K` (clamped to `1..100`)
- `VIBERAG_ISOLATE_EXPLAIN` (`1` or `0`)
- `VIBERAG_ISOLATE_REQUEST_TIMEOUT_MS`
- `VIBERAG_ISOLATE_POST_SAMPLE_DELAY_MS`
- `VIBERAG_ISOLATE_VMMAP_TRIGGER_MB`

Example:

```bash
VIBERAG_ISOLATE_QUERY='indexing memory lifecycle ownership contract cleanup' \
VIBERAG_ISOLATE_INTENTS='exact_text' \
VIBERAG_ISOLATE_K=100 \
npm run memory:isolate
```

### `stress-search-growth.mjs`

Purpose:

- High-concurrency search stress test with periodic memory sampling.
- Supports optional indexing churn and safety guards.

Run:

```bash
npm run memory:stress
```

Safety defaults:

- Hard guard: `VIBERAG_STRESS_MAX_RSS_MB=10240` (10 GB)
- Soft guard: `VIBERAG_STRESS_SOFT_RSS_MB=8192` (80% of hard cap by default)
- On guard trigger, script cancels work and requests daemon shutdown.

Key env:

- `VIBERAG_STRESS_SECONDS`
- `VIBERAG_STRESS_PARALLELISM`
- `VIBERAG_STRESS_MAX_IN_FLIGHT`
- `VIBERAG_STRESS_K` (clamped to `1..100`)
- `VIBERAG_STRESS_MAX_RSS_MB`
- `VIBERAG_STRESS_SOFT_RSS_MB`
- `VIBERAG_STRESS_GUARD_KILL` (`1` default, `0` disables SIGTERM fallback)
- `VIBERAG_STRESS_INDEX_CHURN_SECONDS`
- `VIBERAG_STRESS_INDEX_FORCE`

## Testing Daemon Memory Alerts

You can force local alerting by lowering daemon monitor thresholds via env vars.

Supported daemon monitor env vars:

- `VIBERAG_MEMORY_MONITOR_POLL_INTERVAL_MS` (default `3000`)
- `VIBERAG_MEMORY_MONITOR_THRESHOLD_MB` (default `4096`)
- `VIBERAG_MEMORY_MONITOR_RECOVERY_MB` (default `3584`)
- `VIBERAG_MEMORY_MONITOR_GROWTH_THRESHOLD_MB` (default `1024`)
- `VIBERAG_MEMORY_MONITOR_GROWTH_WINDOW_MS` (default `10000`)
- `VIBERAG_MEMORY_MONITOR_MIN_REPORT_INTERVAL_MS` (default `10000`)
- `VIBERAG_MEMORY_MONITOR_MAX_REPORTS_PER_DAY` (default `20`)

Example (force threshold alerts at normal RSS):

```bash
VIBERAG_MEMORY_MONITOR_THRESHOLD_MB=200 \
VIBERAG_MEMORY_MONITOR_RECOVERY_MB=150 \
VIBERAG_STRESS_SECONDS=10 \
VIBERAG_STRESS_PARALLELISM=1 \
VIBERAG_STRESS_MAX_IN_FLIGHT=1 \
npm run memory:stress
```

Expected signal:

- Daemon log line like:
  `Memory monitor triggered Sentry report (threshold) at rss=...MB`

## Output Files

Generated run logs are written to `scripts/memory/out/` as JSONL.

- `isolate-intent-growth-*.jsonl`
- `stress-search-growth-*.jsonl`

These generated files are intentionally gitignored. Keep `scripts/memory/out/.gitkeep` tracked so the folder exists by default.
