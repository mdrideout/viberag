/**
 * Sentry wrapper for VibeRAG.
 *
 * Goal: capture exceptions reliably from CLI/daemon/MCP without leaking file contents.
 */

import * as Sentry from '@sentry/node';
import {DEFAULT_SENTRY_DSN} from './keys.js';
import {
	getTelemetryModeEnvOverride,
	loadUserSettingsSync,
} from '../user-settings.js';

export type SentryServiceName = 'cli' | 'daemon' | 'mcp';
export type SentryEventLevel =
	| 'fatal'
	| 'error'
	| 'warning'
	| 'log'
	| 'info'
	| 'debug';

export interface SentryCaptureContext {
	tags?: Record<string, string>;
	extra?: Record<string, unknown>;
	contexts?: Record<string, Record<string, unknown>>;
	fingerprint?: string[];
	level?: SentryEventLevel;
}

function isPlaceholder(value: string): boolean {
	return value.startsWith('__VIBERAG_') && value.endsWith('__');
}

function scrubSensitiveText(value: string): string {
	let v = value;
	v = v.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
	v = v.replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_SECRET]');
	v = v.replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_SECRET]');
	v = v.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_SECRET]');
	v = v.replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SECRET]');
	v = v.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '[REDACTED_SECRET]');
	v = v.replace(/[a-f0-9]{64,}/gi, '[REDACTED_SECRET]');
	return v;
}

function applyContextToScope(
	scope: Sentry.Scope,
	context?: SentryCaptureContext,
): void {
	if (!context) return;
	if (context.tags) {
		for (const [key, value] of Object.entries(context.tags)) {
			scope.setTag(key, value);
		}
	}
	if (context.extra) {
		for (const [key, value] of Object.entries(context.extra)) {
			scope.setExtra(key, value);
		}
	}
	if (context.contexts) {
		for (const [key, value] of Object.entries(context.contexts)) {
			scope.setContext(key, value);
		}
	}
	if (context.fingerprint && context.fingerprint.length > 0) {
		scope.setFingerprint(context.fingerprint);
	}
	if (context.level) {
		scope.setLevel(context.level);
	}
}

function withScopedContext(
	context: SentryCaptureContext | undefined,
	fn: () => void,
): void {
	if (!context) {
		fn();
		return;
	}
	Sentry.withScope(scope => {
		applyContextToScope(scope, context);
		fn();
	});
}

export function initSentry(args: {
	service: SentryServiceName;
	version: string;
}): {enabled: boolean; shutdown: () => Promise<void>} {
	const envMode = getTelemetryModeEnvOverride();
	const effectiveMode = envMode ?? loadUserSettingsSync().telemetry.mode;
	if (effectiveMode === 'disabled') {
		return {enabled: false, shutdown: async () => {}};
	}

	// DSN is baked into dist/ at publish time.
	// No runtime env var override.
	const dsn = DEFAULT_SENTRY_DSN;
	if (!dsn || isPlaceholder(dsn)) {
		return {enabled: false, shutdown: async () => {}};
	}

	Sentry.init({
		dsn,
		release: args.version,
		environment: args.service,
		sendDefaultPii: false,
		includeLocalVariables: false,
		beforeSend(event) {
			// Respect telemetry opt-out even if the process is already running.
			const mode =
				getTelemetryModeEnvOverride() ?? loadUserSettingsSync().telemetry.mode;
			if (mode === 'disabled') return null;

			// Best-effort: remove any request-like context that could contain data.
			delete (event as {request?: unknown}).request;

			// Scrub exception messages.
			const ex = event.exception?.values;
			if (ex) {
				for (const entry of ex) {
					if (entry.value) entry.value = scrubSensitiveText(entry.value);
				}
			}
			if (event.message) {
				event.message = scrubSensitiveText(event.message);
			}
			if (event.logentry?.message) {
				event.logentry.message = scrubSensitiveText(event.logentry.message);
			}

			return event;
		},
	});

	return {
		enabled: true,
		shutdown: async () => {
			try {
				await Sentry.close(2000);
			} catch {
				// Ignore
			}
		},
	};
}

export function captureException(
	error: unknown,
	context?: SentryCaptureContext,
): void {
	try {
		withScopedContext(context, () => {
			Sentry.captureException(error);
		});
	} catch {
		// Ignore
	}
}

export function captureMessage(
	message: string,
	context?: SentryCaptureContext,
): void {
	try {
		withScopedContext(context, () => {
			Sentry.captureMessage(message, context?.level ?? 'error');
		});
	} catch {
		// Ignore
	}
}

export async function flushSentry(timeoutMs: number): Promise<boolean> {
	try {
		return await Sentry.flush(timeoutMs);
	} catch {
		return false;
	}
}
