export const VIBERAG_PRIVACY_POLICY = `VibeRAG Privacy Policy (Telemetry + Error Reporting)

Effective date: 2026-01-31

VibeRAG is a local developer tool. Some features send telemetry and error reports to help improve performance, reliability, and usability.

This policy describes what VibeRAG collects and how to opt out. This is not legal advice.

1) Where data is sent

- Telemetry and survey events are sent to PostHog.
- Error reports (exceptions and stack traces) are sent to Sentry.

2) Telemetry modes

VibeRAG supports three telemetry modes:

- disabled: no telemetry events or error reports are sent.
- stripped: privacy-preserving telemetry (no query text; minimal metadata).
- default: includes query text (with best-effort redaction) and richer structured metadata.

Telemetry is enabled by default. You can change this at any time:

- Run /telemetry disabled|stripped|default in the VibeRAG CLI.
- Or set VIBERAG_TELEMETRY=disabled|stripped|default as an environment variable.

3) What telemetry data we collect

Depending on telemetry mode, VibeRAG may collect:

- Tool/method names (e.g. codebase_search, get_symbol_details)
- Timing and performance metrics (durations, counts, success/failure)
- Inputs and outputs for operations, with important limitations below
- Software/runtime info (VibeRAG version, Node version, OS platform, architecture)
- A random installation identifier (UUID) to understand usage over time
- A per-project identifier derived from a one-way hash of the project path

File contents / code text

VibeRAG performs code search and navigation. Some tool outputs naturally contain code snippets or file lines.

VibeRAG does not intentionally collect file contents or raw code text in telemetry. Before sending telemetry, VibeRAG strips fields that contain file contents/code text and replaces them with summaries (hashes, byte counts, line counts) plus structural metadata (IDs, file paths, line ranges, scores).

Query text

In default mode, VibeRAG may collect search query text. VibeRAG applies best-effort redaction of common secret patterns and truncates long strings, but cannot guarantee that all sensitive data is removed. If you work with sensitive data, use stripped or disabled.

4) What error reporting data we collect (Sentry)

When enabled, error reports may include:

- exception type/message
- stack traces
- basic runtime metadata (OS, Node version, VibeRAG version, service name)

VibeRAG does not intentionally include file contents or code text in error reports.

5) How to opt out

- Disable telemetry and error reporting: /telemetry disabled or VIBERAG_TELEMETRY=disabled
- You can reset your installation identifier by deleting VibeRAG’s global settings file under VIBERAG_HOME (default: ~/.local/share/viberag/settings.json).

6) Contact

For questions about telemetry and privacy, open an issue in the VibeRAG repository.
`;
