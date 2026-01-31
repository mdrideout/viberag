# ADR-015: Startup Checks — npm Updates + V2 Index Compatibility

## Status

Accepted

## Context

VibeRAG is used via an interactive CLI and as an MCP server. Both are long-lived entrypoints where users and agents benefit from early feedback about:

- **New releases** (to pick up bug fixes and search improvements).
- **Breaking index changes** (schema updates that require a full reindex instead of incremental updates).

The checks must be:

- **Non-blocking** and **fast** (especially for MCP handshake performance).
- **Actionable**: provide clear instructions (upgrade command / reindex command).
- **Deterministic**: reindex requirements should be driven by explicit versioning, not inferred from package version strings.

## Decision

### 1) npm Release Check (Best Effort, 3s Timeout)

At startup, viberag performs a best-effort version check against the npm registry:

- Endpoint: `https://registry.npmjs.org/<package>/latest`
- Timeout: **3 seconds**
- On newer release: surface an actionable message:
  - `npm install -g viberag`
- If the registry cannot be reached within the timeout, the check is treated as **skipped/timeout** (no hard failure).
- The check is disabled in tests via `NODE_ENV=test` and can be disabled by `VIBERAG_SKIP_UPDATE_CHECK=1|true`.

Surfaces:

- CLI: emits a startup message when an update is available and includes it in `/status`.
- MCP: includes the check result in the `get_status` tool payload (`startup_checks.npm_update`) and starts the check after MCP connect to avoid handshake delays (ADR-009).

Implementation reference: `source/daemon/lib/update-check.ts`

### 2) V2 Index Compatibility (Schema Version Driven)

Reindex requirements are driven by the v2 manifest field:

- `~/.local/share/viberag/projects/<projectId>/manifest-v2.json` → `schemaVersion` (override via `VIBERAG_HOME`)
- Code requirement: `V2_SCHEMA_VERSION` in `source/daemon/services/v2/manifest.ts`

Rules:

- If the manifest is **missing**: `not_indexed` (no schema mismatch).
- If the manifest is **unreadable/corrupt**: treat as `corrupt_manifest` and require a full reindex.
- If `manifest.schemaVersion !== V2_SCHEMA_VERSION`: treat as `needs_reindex` and require a full reindex.

Enforcement:

- Search/navigation operations refuse to run against an incompatible index and throw `V2ReindexRequiredError`.
- Incremental indexing (`force=false`) refuses to run against an incompatible index and throws `V2ReindexRequiredError`.
- Full rebuild (`force=true`) is the recovery path.

Surfaces:

- CLI: `/status` prints an explicit “Reindex required” section when applicable and the CLI emits a startup warning.
- MCP: `get_status` includes `startup_checks.index` with `status`, `requiredSchemaVersion`, and `message`.

Implementation references:

- Compatibility check + error type: `source/daemon/services/v2/manifest.ts`
- Enforcement:
  - `source/daemon/services/v2/search/engine.ts`
  - `source/daemon/services/v2/indexing.ts`

## Consequences

### Positive

- Users and agents get early, actionable diagnostics (update + reindex).
- Breaking index changes are explicit, deterministic, and easy to recover from.
- MCP startup remains fast: update check is deferred until after connect.

### Tradeoffs

- The npm registry check can be noisy in restricted environments (handled by short timeout and opt-out env var).
- Reindex enforcement is schema-version driven; developers must bump `V2_SCHEMA_VERSION` whenever a change requires a rebuild.
