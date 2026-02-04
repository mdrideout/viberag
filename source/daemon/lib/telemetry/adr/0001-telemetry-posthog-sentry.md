# ADR 0001: Telemetry + Error Reporting (PostHog + Sentry)

Date: 2026-02-01

## Context

VibeRAG runs as three processes:

- `viberag` (React Ink CLI)
- `viberag-daemon` (long-lived daemon; JSON-RPC over local socket)
- `viberag-mcp` (stdio MCP server; short-lived in some clients)

We want:

- Product telemetry (usage + performance + “helpfulness” surveys) → PostHog
- Exception tracking → Sentry
- Telemetry enabled by default, with a global opt-out control
- Collect operation inputs/outputs, but **never** send raw file contents / code text

## Decision

### Providers

- Telemetry: PostHog (Project API key / ingest key)
- Exceptions: Sentry (DSN)

### Global settings + opt-out

- Settings live under `VIBERAG_HOME/settings.json` so they apply to CLI + daemon + MCP.
- Telemetry mode is one of:
  - `default` (includes query text with best-effort redaction)
  - `stripped` (privacy-preserving; query/notes hashed)
  - `disabled` (no telemetry **and** no error reporting)

### Data minimization

- We capture inputs/outputs for operations, but we strip fields that contain file contents / code text.
- “Code-ish” fields are summarized as `{sha256, byte_count, line_count}` (e.g. `snippet`, `code_text`, `text`, `lines`, `content`, `docstring`, etc.).
- We size-bound events (depth, array length, string length) to avoid oversized payloads.

### Instrumentation points

- Daemon: wrap JSON-RPC dispatch in one place (all methods covered).
- MCP: wrap tool execution in one place (adds tool-level context and request ids).
- CLI: instrument slash commands that control telemetry + policy view.
- MCP tool: `feedback_survey` for model-reported “helpful / as expected” feedback.

### Key management (baked-only)

We do not support runtime `.env` / env-var configuration for telemetry keys or DSN.

Instead:

- Source code contains placeholders in `source/daemon/lib/telemetry/keys.ts`.
- Keys are **baked into `dist/` at publish time** via `npm prepack` (runs `scripts/bake-telemetry-keys.js`).
- If keys are missing, `prepack` fails to prevent shipping placeholders.

Rationale:

- Aligns with the product requirement that telemetry is “built-in” and enabled by default.
- Avoids runtime configuration drift between services.
- Avoids accidental “works locally but not in prod” situations.

## Local development workflow

Local testing still needs real keys, but we keep runtime behavior baked-only.

1. Copy the example file:
   - `cp .env.telemetry.local.example .env.telemetry.local`
2. Fill in:
   - `VIBERAG_BAKE_POSTHOG_KEY`
   - `VIBERAG_BAKE_SENTRY_DSN`
3. Bake into `dist/`:
   - `npm run build:telemetry`

`.env.telemetry.local` is gitignored. Only `.env.telemetry.local.example` is committed.

## Consequences

- Users cannot redirect telemetry to a different PostHog host at runtime.
  - If we ever need EU region / self-host support, we should bake the host too (or introduce a second placeholder).
- Shipping requires publish-time secrets (local publish or CI).
- Telemetry opt-out is global and affects both PostHog + Sentry (privacy expectation is consistent).
