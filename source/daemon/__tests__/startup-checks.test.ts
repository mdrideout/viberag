/**
 * Startup checks + index compatibility enforcement.
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {checkNpmForUpdate, compareSemver} from '../lib/update-check.js';
import {
	checkV2IndexCompatibility,
	V2ReindexRequiredError,
	V2_SCHEMA_VERSION,
} from '../services/v2/manifest.js';
import {SearchEngineV2} from '../services/v2/search/engine.js';
import {IndexingServiceV2} from '../services/v2/indexing.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

describe('Startup checks', () => {
	it('compareSemver orders basic semver triplets', () => {
		expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
		expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
		expect(compareSemver('1.2.10', '1.2.4')).toBe(1);
		expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
	});

	it('compareSemver handles v-prefix and prerelease suffixes', () => {
		expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
		expect(compareSemver('1.2.3-beta.1', '1.2.4')).toBe(-1);
		expect(compareSemver('1.2.3', '1.2.3-beta.1')).toBe(0);
	});

	it('compareSemver treats unparseable versions as equal (no false alarms)', () => {
		expect(compareSemver('dev', '1.2.3')).toBe(0);
		expect(compareSemver('1.2', '1.2.3')).toBe(0);
	});

	it('checkNpmForUpdate reports update_available on newer dist-tag', async () => {
		const result = await checkNpmForUpdate({
			packageName: 'viberag',
			currentVersion: '0.0.1',
			timeoutMs: 50,
			fetchImpl: async () =>
				({
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({version: '9.9.9'}),
				}) as unknown as Response,
		});

		expect(result.status).toBe('update_available');
		expect(result.latestVersion).toBe('9.9.9');
		expect(result.message).toContain('npm install -g');
	});

	it('checkNpmForUpdate reports timeout and does not throw', async () => {
		const result = await checkNpmForUpdate({
			packageName: 'viberag',
			currentVersion: '0.0.1',
			timeoutMs: 50,
			fetchImpl: async (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						const err = new Error('aborted');
						(err as {name?: string}).name = 'AbortError';
						reject(err);
					});
				}) as unknown as Response,
		});

		expect(result.status).toBe('timeout');
	});
});

describe('V2 index compatibility', () => {
	let ctx: TestContext;
	let manifestPath: string;

	beforeAll(async () => {
		ctx = await copyFixtureToTemp('codebase');
		manifestPath = path.join(ctx.projectRoot, '.viberag', 'manifest-v2.json');
	}, 60_000);

	afterAll(async () => {
		await ctx.cleanup();
	});

	it('reports not_indexed when manifest is missing', async () => {
		await fs.rm(manifestPath, {force: true});
		const compat = await checkV2IndexCompatibility(ctx.projectRoot);
		expect(compat.status).toBe('not_indexed');
	});

	it('reports corrupt_manifest when schemaVersion is missing', async () => {
		await fs.mkdir(path.dirname(manifestPath), {recursive: true});
		await fs.writeFile(
			manifestPath,
			JSON.stringify({version: 1}, null, '\t') + '\n',
		);
		const compat = await checkV2IndexCompatibility(ctx.projectRoot);
		expect(compat.status).toBe('corrupt_manifest');
		expect(compat.message).toContain('/reindex');
	});

	it('reports corrupt_manifest on invalid JSON', async () => {
		await fs.mkdir(path.dirname(manifestPath), {recursive: true});
		await fs.writeFile(manifestPath, '{not json}\n');
		const compat = await checkV2IndexCompatibility(ctx.projectRoot);
		expect(compat.status).toBe('corrupt_manifest');
		expect(compat.message).toContain('/reindex');
	});

	it('reports needs_reindex when manifest schemaVersion is older', async () => {
		await fs.writeFile(
			manifestPath,
			JSON.stringify({schemaVersion: V2_SCHEMA_VERSION - 1}, null, '\t') + '\n',
		);

		const compat = await checkV2IndexCompatibility(ctx.projectRoot);
		expect(compat.status).toBe('needs_reindex');
		expect(compat.requiredSchemaVersion).toBe(V2_SCHEMA_VERSION);
		expect(compat.manifestSchemaVersion).toBe(V2_SCHEMA_VERSION - 1);
		expect(compat.message).toContain('/reindex');
	});

	it('search refuses to run against incompatible schema', async () => {
		const engine = new SearchEngineV2(ctx.projectRoot);
		try {
			await expect(
				engine.search('anything', {intent: 'exact_text', k: 5, explain: false}),
			).rejects.toBeInstanceOf(V2ReindexRequiredError);
		} finally {
			engine.close();
		}
	});

	it('incremental indexing refuses to run against incompatible schema without force', async () => {
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		try {
			await expect(indexer.index({force: false})).rejects.toBeInstanceOf(
				V2ReindexRequiredError,
			);
		} finally {
			indexer.close();
		}
	});
});
