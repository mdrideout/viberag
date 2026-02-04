import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {getUserSettingsPath} from '../lib/constants.js';
import {
	ensureUserSettings,
	loadUserSettings,
	resolveEffectiveTelemetryMode,
	setTelemetryMode,
} from '../lib/user-settings.js';

describe('user settings (global)', () => {
	let tempHomeDir: string | null = null;
	const originalHome = process.env['VIBERAG_HOME'];
	const originalXdg = process.env['XDG_DATA_HOME'];
	const originalTelemetry = process.env['VIBERAG_TELEMETRY'];

	beforeEach(async () => {
		tempHomeDir = await fs.mkdtemp(
			path.join(os.tmpdir(), 'viberag-home-test-'),
		);
		process.env['VIBERAG_HOME'] = tempHomeDir;
		delete process.env['XDG_DATA_HOME'];
		delete process.env['VIBERAG_TELEMETRY'];
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env['VIBERAG_HOME'];
		else process.env['VIBERAG_HOME'] = originalHome;

		if (originalXdg === undefined) delete process.env['XDG_DATA_HOME'];
		else process.env['XDG_DATA_HOME'] = originalXdg;

		if (originalTelemetry === undefined)
			delete process.env['VIBERAG_TELEMETRY'];
		else process.env['VIBERAG_TELEMETRY'] = originalTelemetry;

		if (tempHomeDir) {
			await fs.rm(tempHomeDir, {recursive: true, force: true});
			tempHomeDir = null;
		}
	});

	it('creates settings.json and persists installationId', async () => {
		const settings = await ensureUserSettings();
		const settingsPath = getUserSettingsPath();

		const raw = await fs.readFile(settingsPath, 'utf8');
		const onDisk = JSON.parse(raw) as {installationId?: string};

		expect(settings.installationId).toBeTruthy();
		expect(onDisk.installationId).toBe(settings.installationId);
		expect(settings.telemetry.mode).toBe('default');
	});

	it('updates telemetry mode without changing installationId', async () => {
		const initial = await ensureUserSettings();
		const updated = await setTelemetryMode('disabled');
		const reloaded = await loadUserSettings();

		expect(updated.installationId).toBe(initial.installationId);
		expect(updated.telemetry.mode).toBe('disabled');
		expect(reloaded.telemetry.mode).toBe('disabled');
	});

	it('respects VIBERAG_TELEMETRY env override', async () => {
		const settings = await ensureUserSettings();
		process.env['VIBERAG_TELEMETRY'] = 'stripped';

		expect(resolveEffectiveTelemetryMode(settings)).toEqual({
			mode: 'stripped',
			source: 'env',
		});
	});
});
