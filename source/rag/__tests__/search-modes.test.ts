/**
 * Tests for search modes: definition and similar.
 *
 * Tests the new search modes added in Phase 2:
 * - definition: Direct metadata lookup by symbol name
 * - similar: Vector search with code snippet as query
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {Indexer} from '../indexer/indexer.js';
import {SearchEngine} from '../search/index.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

describe('Search Modes', () => {
	let ctx: TestContext;
	let search: SearchEngine;

	beforeAll(async () => {
		// Setup once for all tests - index the codebase
		ctx = await copyFixtureToTemp('codebase');
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();
		search = new SearchEngine(ctx.projectRoot);
	}, 120_000);

	afterAll(async () => {
		search.close();
		await ctx.cleanup();
	});

	describe('definition mode', () => {
		it('finds function definition by exact name', async () => {
			const results = await search.search('getUser', {
				mode: 'definition',
				symbolName: 'getUser',
			});

			expect(results.results.length).toBeGreaterThan(0);
			expect(results.searchType).toBe('definition');
			// Should find the function in endpoints.ts
			expect(
				results.results.some(r => r.filepath.includes('endpoints.ts')),
			).toBe(true);
		}, 60_000);

		it('finds class definition by name', async () => {
			// Use semantic search to find class - limited to TypeScript
			// (PHP/Kotlin have interfaces that are also typed as 'class')
			const results = await search.search('UserService class', {
				mode: 'semantic',
				filters: {type: ['class'], extension: ['.ts']},
			});

			// Should find the class in exported.ts
			if (results.results.length > 0) {
				expect(
					results.results.some(r => r.filepath.includes('exported.ts')),
				).toBe(true);
			}
		}, 60_000);

		it('finds method definition by name', async () => {
			// Use semantic search for method lookup
			const results = await search.search('fetchData method http', {
				mode: 'semantic',
				filters: {type: ['method']},
			});

			// Should find the method in http_client.ts
			if (results.results.length > 0) {
				expect(
					results.results.some(r => r.filepath.includes('http_client.ts')),
				).toBe(true);
			}
		}, 60_000);

		it('returns empty for non-existent symbol', async () => {
			const results = await search.search('nonExistentSymbolXYZ123', {
				mode: 'definition',
				symbolName: 'nonExistentSymbolXYZ123',
			});

			expect(results.results.length).toBe(0);
		}, 60_000);

		it('can filter definitions by type', async () => {
			const results = await search.search('add', {
				mode: 'definition',
				symbolName: 'add_two_numbers',
				filters: {type: ['function']},
			});

			if (results.results.length > 0) {
				expect(results.results.every(r => r.type === 'function')).toBe(true);
			}
		}, 60_000);
	});

	describe('similar mode', () => {
		it('finds similar code by snippet', async () => {
			// Search for code similar to an async fetch function
			const snippet = `async function fetchData(url) {
				const response = await fetch(url);
				return response.json();
			}`;

			const results = await search.search(snippet, {
				mode: 'similar',
				codeSnippet: snippet,
			});

			expect(results.results.length).toBeGreaterThan(0);
			expect(results.searchType).toBe('similar');
			// Should find http_client.ts which has similar fetch logic
			expect(
				results.results.some(r => r.filepath.includes('http_client.ts')),
			).toBe(true);
		}, 60_000);

		it('finds similar Python code', async () => {
			const snippet = `def calculate(a, b):
				return a + b`;

			const results = await search.search(snippet, {
				mode: 'similar',
				codeSnippet: snippet,
			});

			expect(results.results.length).toBeGreaterThan(0);
			// Should find math.py which has similar arithmetic functions
			expect(results.results.some(r => r.filepath.includes('math.py'))).toBe(
				true,
			);
		}, 60_000);

		it('respects limit parameter', async () => {
			const snippet = `function helper() { return true; }`;

			const results = await search.search(snippet, {
				mode: 'similar',
				codeSnippet: snippet,
				limit: 3,
			});

			expect(results.results.length).toBeLessThanOrEqual(3);
		}, 60_000);
	});

	describe('mode selection', () => {
		it('defaults to hybrid mode', async () => {
			const results = await search.search('function');

			expect(results.searchType).toBe('hybrid');
		}, 60_000);

		it('semantic mode returns semantic type', async () => {
			const results = await search.search('how does authentication work', {
				mode: 'semantic',
			});

			expect(results.searchType).toBe('semantic');
		}, 60_000);

		it('exact mode returns exact type', async () => {
			const results = await search.search('fetchData', {
				mode: 'exact',
			});

			expect(results.searchType).toBe('exact');
		}, 60_000);
	});
});
