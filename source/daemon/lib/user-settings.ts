/**
 * Global user settings (per-machine).
 *
 * Stored under VIBERAG_HOME so it applies to CLI + daemon + MCP uniformly.
 *
 * Path: {VIBERAG_HOME}/settings.json (override via $VIBERAG_HOME)
 */

import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {getUserSettingsPath} from './constants.js';

export type TelemetryMode = 'disabled' | 'stripped' | 'default';

export type UserSettings = {
	schemaVersion: 1;
	installationId: string;
	telemetry: {
		mode: TelemetryMode;
		updatedAt: string;
	};
};

const DEFAULT_TELEMETRY_MODE: TelemetryMode = 'default';

function createDefaultUserSettings(now: string): UserSettings {
	return {
		schemaVersion: 1,
		installationId: crypto.randomUUID(),
		telemetry: {
			mode: DEFAULT_TELEMETRY_MODE,
			updatedAt: now,
		},
	};
}

export function parseTelemetryMode(value: unknown): TelemetryMode | null {
	if (value === 'disabled' || value === 'stripped' || value === 'default') {
		return value;
	}
	return null;
}

export function getTelemetryModeEnvOverride(): TelemetryMode | null {
	return parseTelemetryMode(process.env['VIBERAG_TELEMETRY']?.trim());
}

export function resolveEffectiveTelemetryMode(settings: UserSettings): {
	mode: TelemetryMode;
	source: 'env' | 'settings';
} {
	const env = getTelemetryModeEnvOverride();
	if (env) return {mode: env, source: 'env'};
	return {mode: settings.telemetry.mode, source: 'settings'};
}

function isValidSettingsShape(value: unknown): value is UserSettings {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if (v['schemaVersion'] !== 1) return false;
	if (typeof v['installationId'] !== 'string' || !v['installationId']) {
		return false;
	}
	const telemetry = v['telemetry'];
	if (typeof telemetry !== 'object' || telemetry === null) return false;
	const t = telemetry as Record<string, unknown>;
	if (!parseTelemetryMode(t['mode'])) return false;
	if (typeof t['updatedAt'] !== 'string') return false;
	return true;
}

async function writeUserSettingsFile(settings: UserSettings): Promise<void> {
	const settingsPath = getUserSettingsPath();
	const dir = path.dirname(settingsPath);
	await fs.mkdir(dir, {recursive: true});

	const tempPath = `${settingsPath}.tmp`;
	await fs.writeFile(tempPath, JSON.stringify(settings, null, '\t') + '\n');
	await fs.rename(tempPath, settingsPath);

	// Best-effort: restrict permissions (ignored on Windows)
	try {
		await fs.chmod(settingsPath, 0o600);
	} catch {
		// Ignore
	}
}

export async function loadUserSettings(): Promise<UserSettings> {
	const settingsPath = getUserSettingsPath();
	const now = new Date().toISOString();

	try {
		const raw = await fs.readFile(settingsPath, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;

		if (isValidSettingsShape(parsed)) {
			return parsed;
		}

		// Corrupt or outdated: fall back without throwing.
		return createDefaultUserSettings(now);
	} catch (error) {
		if (error instanceof Error && 'code' in error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				return createDefaultUserSettings(now);
			}
		}
		// Any other read/parse error: fall back without throwing.
		return createDefaultUserSettings(now);
	}
}

export function loadUserSettingsSync(): UserSettings {
	const settingsPath = getUserSettingsPath();
	const now = new Date().toISOString();

	try {
		const raw = fsSync.readFileSync(settingsPath, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;

		if (isValidSettingsShape(parsed)) {
			return parsed;
		}

		// Corrupt or outdated: fall back without throwing.
		return createDefaultUserSettings(now);
	} catch {
		// Any read/parse error: fall back without throwing.
		return createDefaultUserSettings(now);
	}
}

/**
 * Load settings and ensure they exist on disk (creating if missing/corrupt).
 * This is safe to call from any process.
 */
export async function ensureUserSettings(): Promise<UserSettings> {
	const settings = await loadUserSettings();
	try {
		await writeUserSettingsFile(settings);
	} catch {
		// Ignore persistence failures - settings still returned in-memory.
	}
	return settings;
}

export async function setTelemetryMode(
	mode: TelemetryMode,
): Promise<UserSettings> {
	const now = new Date().toISOString();
	const current = await loadUserSettings();
	const next: UserSettings = {
		...current,
		telemetry: {
			mode,
			updatedAt: now,
		},
	};
	await writeUserSettingsFile(next);
	return next;
}
