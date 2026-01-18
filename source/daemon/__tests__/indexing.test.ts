/**
 * E2E tests for the v2 indexing pipeline.
 *
 * Tests system behavior (not library correctness):
 * - Merkle tree correctly detects file changes
 * - v2 tables + manifest persist across runs
 * - SearchEngineV2 retrieves expected definitions/files/blocks
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type {V2SearchResponse, V2HitBase} from '../services/v2/search/types.js';
import {IndexingServiceV2} from '../services/v2/indexing.js';
import {SearchEngineV2} from '../services/v2/search/engine.js';
import {loadV2Manifest} from '../services/v2/manifest.js';
import {
	copyFixtureToTemp,
	addFile,
	modifyFile,
	deleteFile,
	waitForFs,
	type TestContext,
} from './helpers.js';

function allHits(res: V2SearchResponse): V2HitBase[] {
	return [
		...res.groups.definitions,
		...res.groups.usages,
		...res.groups.files,
		...res.groups.blocks,
	];
}

function hasFileHit(res: V2SearchResponse, needle: string): boolean {
	return allHits(res).some(h => h.file_path.includes(needle));
}

describe('Indexing v2 E2E', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('indexes codebase and supports concept retrieval across entities', async () => {
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		const search = new SearchEngineV2(ctx.projectRoot);

		const mathResults = await search.search(
			'Add two numbers together and return the sum',
			{intent: 'concept', k: 20, explain: false},
		);
		expect(hasFileHit(mathResults, 'math.py')).toBe(true);

		const httpResults = await search.search('Fetch data from an API endpoint', {
			intent: 'concept',
			k: 20,
			explain: false,
		});
		expect(hasFileHit(httpResults, 'http_client.ts')).toBe(true);

		const utilsResults = await search.search(
			'Format a date as a human-readable string',
			{intent: 'concept', k: 20, explain: false},
		);
		expect(hasFileHit(utilsResults, 'utils.js')).toBe(true);

		// File-level orientation: exported name should surface the file row.
		const unicodeResults = await search.search('emoji', {
			intent: 'concept',
			k: 10,
			explain: false,
		});
		expect(hasFileHit(unicodeResults, 'unicode_content.js')).toBe(true);

		search.close();
	}, 180_000);

	it('detects new/modified/deleted files correctly', async () => {
		// Initial index
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Add new file
		await addFile(
			ctx.projectRoot,
			'new_module.py',
			'def new_function():\n    return "new"\n',
		);

		// Modify existing file
		await modifyFile(
			ctx.projectRoot,
			'math.py',
			'# Modified file\ndef add(a, b):\n    return a + b\n',
		);

		// Delete a file
		await deleteFile(ctx.projectRoot, 'utils.js');

		await waitForFs();

		// Reindex
		const indexer2 = new IndexingServiceV2(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesNew).toBe(1);
		expect(stats.filesModified).toBe(1);
		expect(stats.filesDeleted).toBe(1);
	}, 60_000);

	it('skips unchanged files on reindex', async () => {
		// Initial index
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Reindex with no changes
		const indexer2 = new IndexingServiceV2(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesNew).toBe(0);
		expect(stats.filesModified).toBe(0);
		expect(stats.filesDeleted).toBe(0);
		expect(stats.symbolRowsUpserted).toBe(0);
		expect(stats.chunkRowsUpserted).toBe(0);
	}, 180_000);

	it('persists and reloads v2 manifest', async () => {
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		const manifest = await loadV2Manifest(ctx.projectRoot, {
			repoId: 'test',
			revision: 'working',
		});
		expect(manifest.tree).not.toBe(null);
		expect(manifest.stats.totalFiles).toBeGreaterThan(0);
		expect(manifest.stats.totalSymbols).toBeGreaterThan(0);

		// "Restart" - create new indexer instance and re-run.
		const indexer2 = new IndexingServiceV2(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		// Should detect no changes (recovered from manifest)
		expect(stats.filesNew).toBe(0);
		expect(stats.filesModified).toBe(0);
		expect(stats.filesDeleted).toBe(0);
	}, 60_000);

	it('reindexes all files with force=true (embedding cache reused)', async () => {
		// Initial index
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Force reindex
		const indexer2 = new IndexingServiceV2(ctx.projectRoot);
		const stats = await indexer2.index({force: true});
		indexer2.close();

		expect(stats.filesIndexed).toBeGreaterThan(0);
		expect(stats.filesNew).toBe(stats.filesIndexed);
		expect(stats.embeddingsCached).toBeGreaterThan(0);
	}, 180_000);

	it('removes deleted files from search results', async () => {
		// Initial index
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Verify math.py is searchable
		const search = new SearchEngineV2(ctx.projectRoot);
		let results = await search.search('add_two_numbers', {
			intent: 'definition',
			k: 10,
			explain: false,
		});
		expect(hasFileHit(results, 'math.py')).toBe(true);
		search.close();

		// Delete math.py
		await deleteFile(ctx.projectRoot, 'math.py');
		await waitForFs();

		// Reindex
		const indexer2 = new IndexingServiceV2(ctx.projectRoot);
		await indexer2.index();
		indexer2.close();

		// Should no longer appear in results
		const search2 = new SearchEngineV2(ctx.projectRoot);
		results = await search2.search('add_two_numbers', {
			intent: 'definition',
			k: 10,
			explain: false,
		});
		expect(hasFileHit(results, 'math.py')).toBe(false);
		search2.close();
	}, 180_000);

	it('continues indexing when a file fails to parse', async () => {
		await addFile(ctx.projectRoot, 'broken.ts', 'const x = {{{');
		await addFile(
			ctx.projectRoot,
			'good.ts',
			'export function works() { return 1; }',
		);
		await waitForFs();

		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		const search = new SearchEngineV2(ctx.projectRoot);
		const results = await search.search('works', {
			intent: 'definition',
			k: 10,
			explain: false,
			scope: {extension: ['.ts']},
		});
		expect(hasFileHit(results, 'good.ts')).toBe(true);
		search.close();
	}, 180_000);
});
