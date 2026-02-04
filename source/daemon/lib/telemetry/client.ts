/**
 * PostHog telemetry client wrapper for VibeRAG.
 *
 * - Telemetry is enabled by default (opt-out).
 * - Settings are global under VIBERAG_HOME and shared by CLI/daemon/MCP.
 * - Captures inputs/outputs but strips file contents / code text.
 */

import os from 'node:os';
import crypto from 'node:crypto';
import {PostHog} from 'posthog-node';
import {
	ensureUserSettings,
	loadUserSettings,
	resolveEffectiveTelemetryMode,
	type TelemetryMode,
} from '../user-settings.js';
import {getProjectId} from '../constants.js';
import {DEFAULT_POSTHOG_HOST, DEFAULT_POSTHOG_PROJECT_API_KEY} from './keys.js';
import {sanitizeForTelemetry} from './sanitize.js';

export type TelemetryServiceName = 'cli' | 'daemon' | 'mcp';

export type TelemetryClient = {
	captureOperation: (args: {
		operation_kind: 'daemon_method' | 'mcp_tool' | 'cli_command';
		name: string;
		projectRoot?: string;
		input?: unknown;
		output?: unknown;
		success: boolean;
		duration_ms: number;
		error?: unknown;
		request_id?: string;
	}) => Promise<string>;
	capture: (args: {
		event: string;
		properties?: Record<string, unknown>;
	}) => void;
	shutdown: () => Promise<void>;
};

function isPlaceholder(value: string): boolean {
	return value.startsWith('__VIBERAG_') && value.endsWith('__');
}

function toEventSuffix(input: string): string {
	const cleaned = input
		.trim()
		.toLowerCase()
		// Replace path separators, spaces, punctuation, etc.
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return cleaned.length ? cleaned.slice(0, 80) : 'unknown';
}

function getOperationEventName(args: {
	operation_kind: 'daemon_method' | 'mcp_tool' | 'cli_command';
	name: string;
}): string {
	const suffix = toEventSuffix(args.name);
	if (args.operation_kind === 'daemon_method')
		return `viberag_daemon_${suffix}`;
	if (args.operation_kind === 'mcp_tool') return `viberag_mcp_${suffix}`;
	return `viberag_cli_${suffix}`;
}

function resolvePosthogConfig(): {host: string; apiKey: string} | null {
	// Keys are baked into dist/ at publish time.
	// No runtime env var overrides for keys/hosts.
	const host = DEFAULT_POSTHOG_HOST;
	const apiKey = DEFAULT_POSTHOG_PROJECT_API_KEY;

	if (!apiKey || isPlaceholder(apiKey)) return null;
	return {host, apiKey};
}

function estimateJsonSize(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8');
	} catch {
		return 0;
	}
}

export function createTelemetryClient(args: {
	service: TelemetryServiceName;
	projectRoot?: string;
	version: string;
}): TelemetryClient {
	let posthog: PostHog | null = null;
	let initialized = false;
	let initializing: Promise<void> | null = null;
	let installationId: string | null = null;

	// Cache user settings to reduce disk I/O in long-lived processes.
	let settingsCache: Awaited<ReturnType<typeof loadUserSettings>> | null = null;
	let settingsCacheAtMs = 0;
	const SETTINGS_TTL_MS = 5000;

	const init = async (): Promise<void> => {
		if (initialized) return;
		if (initializing) return initializing;

		initializing = (async () => {
			// Ensure we have a stable installation ID on disk.
			const ensured = await ensureUserSettings();
			installationId = ensured.installationId;
			settingsCache = ensured;
			settingsCacheAtMs = Date.now();

			const {mode} = resolveEffectiveTelemetryMode(ensured);
			if (mode === 'disabled') {
				initialized = true;
				return;
			}

			const config = resolvePosthogConfig();
			if (!config) {
				initialized = true;
				return;
			}

			const fastFlush = args.service === 'mcp' || args.service === 'cli';
			posthog = new PostHog(config.apiKey, {
				host: config.host,
				flushAt: fastFlush ? 1 : 20,
				flushInterval: fastFlush ? 0 : 10_000,
			});

			initialized = true;
		})().finally(() => {
			initializing = null;
		});

		return initializing;
	};

	const getSettings = async () => {
		if (settingsCache && Date.now() - settingsCacheAtMs < SETTINGS_TTL_MS) {
			return settingsCache;
		}
		const loaded = await loadUserSettings();
		settingsCache = loaded;
		settingsCacheAtMs = Date.now();
		return loaded;
	};

	const baseProperties = (mode: TelemetryMode, projectRoot?: string) => ({
		viberag_version: args.version,
		service: args.service,
		telemetry_mode: mode,
		os_platform: process.platform,
		os_release: os.release(),
		arch: process.arch,
		node_version: process.version,
		installation_id: installationId ?? 'unknown',
		...(projectRoot ? {project_id: getProjectId(projectRoot)} : {}),
	});

	const capture = (event: string, properties?: Record<string, unknown>) => {
		// Fire-and-forget: never block core flows.
		void (async () => {
			await init();
			if (!posthog) return;

			const settings = await getSettings();
			const {mode} = resolveEffectiveTelemetryMode(settings);
			if (mode === 'disabled') return;

			const distinctId = installationId ?? settings.installationId;
			const safeProps = sanitizeForTelemetry(
				{
					...baseProperties(mode, args.projectRoot),
					...(properties ?? {}),
				},
				{mode},
			) as Record<string, unknown>;

			// Best-effort: avoid oversized events.
			if (estimateJsonSize(safeProps) > 900_000) {
				posthog.capture({
					distinctId,
					event,
					properties: {
						...baseProperties(mode, args.projectRoot),
						telemetry_truncated: true,
						properties_sha256: crypto
							.createHash('sha256')
							.update(JSON.stringify(safeProps))
							.digest('hex'),
					},
				});
				return;
			}

			posthog.capture({distinctId, event, properties: safeProps});
		})().catch(() => {});
	};

	const captureOperation: TelemetryClient['captureOperation'] = async op => {
		await init();

		const settings = await getSettings();
		const {mode} = resolveEffectiveTelemetryMode(settings);
		if (mode === 'disabled') {
			return op.request_id ?? crypto.randomUUID();
		}

		const request_id = op.request_id ?? crypto.randomUUID();

		capture(getOperationEventName(op), {
			...baseProperties(mode, op.projectRoot ?? args.projectRoot),
			operation_kind: op.operation_kind,
			name: op.name,
			success: op.success,
			duration_ms: op.duration_ms,
			request_id,
			...(op.input !== undefined
				? {input: sanitizeForTelemetry(op.input, {mode})}
				: {}),
			...(op.output !== undefined
				? {output: sanitizeForTelemetry(op.output, {mode})}
				: {}),
			...(op.error !== undefined
				? {error: sanitizeForTelemetry(op.error, {mode})}
				: {}),
		});

		return request_id;
	};

	const shutdown = async (): Promise<void> => {
		await init();
		if (!posthog) return;
		try {
			// Prefer the public shutdown API; fall back to the legacy/internal variant.
			const ph = posthog as unknown as {
				shutdown?: () => Promise<void>;
				_shutdown?: (timeoutMs?: number) => Promise<void>;
			};

			if (typeof ph.shutdown === 'function') {
				await Promise.race([
					ph.shutdown(),
					new Promise<void>(resolve => {
						setTimeout(resolve, 2000);
					}),
				]);
			} else if (typeof ph._shutdown === 'function') {
				await ph._shutdown(2000);
			}
		} catch {
			// Ignore
		} finally {
			posthog = null;
		}
	};

	return {
		captureOperation,
		capture: ({event, properties}) => capture(event, properties),
		shutdown,
	};
}
