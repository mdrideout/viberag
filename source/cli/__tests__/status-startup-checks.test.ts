/**
 * CLI status output should surface startup checks (reindex required).
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {getStatus} from '../commands/handlers.js';
import {V2_SCHEMA_VERSION} from '../../daemon/services/v2/manifest.js';

describe('CLI /status startup checks', () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-cli-test-'));
		await fs.mkdir(path.join(projectRoot, '.viberag'), {recursive: true});
	});

	afterEach(async () => {
		await fs.rm(projectRoot, {recursive: true, force: true});
	});

	it('includes a reindex-required warning when manifest schemaVersion is incompatible', async () => {
		await fs.writeFile(
			path.join(projectRoot, '.viberag', 'manifest-v2.json'),
			JSON.stringify({schemaVersion: V2_SCHEMA_VERSION - 1}, null, '\t') + '\n',
		);

		const status = await getStatus(projectRoot);
		expect(status).toContain('Reindex required');
		expect(status).toContain('/reindex');
	});
});
