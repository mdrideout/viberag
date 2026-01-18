/**
 * Tests for v2 search scope filters.
 *
 * V2 supports transparent, path-based filtering (plus extensions) with no
 * hidden heuristic exclusions.
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {IndexingServiceV2} from '../services/v2/indexing.js';
import {SearchEngineV2} from '../services/v2/search/engine.js';
import type {V2SearchResponse, V2HitBase} from '../services/v2/search/types.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

function allHits(res: V2SearchResponse): V2HitBase[] {
	return [
		...res.groups.definitions,
		...res.groups.usages,
		...res.groups.files,
		...res.groups.blocks,
	];
}

describe('V2 Search Scope Filters', () => {
	let ctx: TestContext;
	let search: SearchEngineV2;

	beforeAll(async () => {
		ctx = await copyFixtureToTemp('codebase');
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();
		search = new SearchEngineV2(ctx.projectRoot);
	}, 120_000);

	afterAll(async () => {
		search.close();
		await ctx.cleanup();
	});

	describe('path filters', () => {
		it('filters by path_prefix', async () => {
			const results = await search.search('user', {
				intent: 'concept',
				k: 30,
				explain: false,
				scope: {path_prefix: ['src/']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.every(h => h.file_path.startsWith('src/'))).toBe(true);
		});

		it('filters by path_prefix to a specific subdirectory', async () => {
			const results = await search.search('user', {
				intent: 'concept',
				k: 30,
				explain: false,
				scope: {path_prefix: ['src/api/']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.every(h => h.file_path.startsWith('src/api/'))).toBe(true);
		});

		it('filters by path_contains (AND)', async () => {
			const results = await search.search('authentication token login', {
				intent: 'concept',
				k: 30,
				explain: false,
				scope: {path_contains: ['services']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.every(h => h.file_path.includes('services'))).toBe(true);
		});

		it('filters by path_contains with multiple strings (AND)', async () => {
			const results = await search.search('helper', {
				intent: 'concept',
				k: 30,
				explain: false,
				scope: {path_contains: ['src', 'utils']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			hits.forEach(h => {
				expect(h.file_path.includes('src')).toBe(true);
				expect(h.file_path.includes('utils')).toBe(true);
			});
		});

		it('excludes paths with path_not_contains', async () => {
			const results = await search.search('test', {
				intent: 'concept',
				k: 50,
				explain: false,
				scope: {path_not_contains: ['__tests__']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.every(h => !h.file_path.includes('__tests__'))).toBe(true);
		});
	});

	describe('extension filters', () => {
		it('filters by .py extension', async () => {
			const results = await search.search('add_two_numbers', {
				intent: 'definition',
				k: 10,
				explain: false,
				scope: {extension: ['.py']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.every(h => h.file_path.endsWith('.py'))).toBe(true);
		});

		it('filters by multiple extensions (OR)', async () => {
			const results = await search.search('component', {
				intent: 'concept',
				k: 30,
				explain: false,
				scope: {extension: ['.ts', '.tsx']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			expect(
				hits.every(
					h => h.file_path.endsWith('.ts') || h.file_path.endsWith('.tsx'),
				),
			).toBe(true);
		});
	});

	describe('filter combinations', () => {
		it('combines path_prefix + extension', async () => {
			const results = await search.search('user', {
				intent: 'concept',
				k: 30,
				explain: false,
				scope: {path_prefix: ['src/'], extension: ['.ts']},
			});

			const hits = allHits(results);
			expect(hits.length).toBeGreaterThan(0);
			hits.forEach(h => {
				expect(h.file_path.startsWith('src/')).toBe(true);
				expect(h.file_path.endsWith('.ts')).toBe(true);
			});
		});
	});
});
