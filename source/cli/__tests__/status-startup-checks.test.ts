/**
 * CLI status output should surface startup checks (reindex required).
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {getStatus} from '../commands/handlers.js';
import {getRunDir, getViberagDir} from '../../daemon/lib/constants.js';
import {
	getV2ManifestPath,
	V2_SCHEMA_VERSION,
} from '../../daemon/services/v2/manifest.js';

describe('CLI /status startup checks', () => {
	let projectRoot: string;
	let projectDataDir: string;
	let runDir: string;

	beforeEach(async () => {
		projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-cli-test-'));
		projectDataDir = getViberagDir(projectRoot);
		runDir = getRunDir(projectRoot);
		await fs.mkdir(projectDataDir, {recursive: true});
	});

	afterEach(async () => {
		await fs.rm(projectDataDir, {recursive: true, force: true});
		await fs.rm(runDir, {recursive: true, force: true});
		await fs.rm(projectRoot, {recursive: true, force: true});
	});

	it('includes a reindex-required warning when manifest schemaVersion is incompatible', async () => {
		await fs.writeFile(
			getV2ManifestPath(projectRoot),
			JSON.stringify({schemaVersion: V2_SCHEMA_VERSION - 1}, null, '\t') + '\n',
		);

		const status = await getStatus(projectRoot);
		expect(status).toContain('Reindex required');
		expect(status).toContain('/reindex');
	});
});
