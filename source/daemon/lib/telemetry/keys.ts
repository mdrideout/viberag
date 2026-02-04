/**
 * Telemetry provider defaults.
 *
 * NOTE: These are intentionally placeholders so we don't commit vendor keys to git.
 * For production releases, bake real values into dist at publish time.
 */

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * PostHog Project API key (write-only ingest key).
 * Should start with `phc_` for PostHog Cloud.
 */
export const DEFAULT_POSTHOG_PROJECT_API_KEY =
	'__VIBERAG_POSTHOG_PROJECT_API_KEY__';

/**
 * Sentry DSN for error reporting.
 */
export const DEFAULT_SENTRY_DSN = '__VIBERAG_SENTRY_DSN__';
