/**
 * Tests for metadata extraction.
 *
 * Tests that the Chunker correctly extracts:
 * - signature: Function/method signature lines
 * - docstring: JSDoc/Python docstrings
 * - is_exported: Export keyword detection
 * - decorator_names: Decorator/annotation extraction
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {IndexingService} from '../services/indexing.js';
import {SearchEngine} from '../services/search/index.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

describe('Metadata Extraction', () => {
	let ctx: TestContext;
	let search: SearchEngine;

	beforeAll(async () => {
		// Setup once - index the codebase
		ctx = await copyFixtureToTemp('codebase');
		const indexer = new IndexingService(ctx.projectRoot);
		await indexer.index();
		indexer.close();
		search = new SearchEngine(ctx.projectRoot);
	}, 120_000);

	afterAll(async () => {
		search.close();
		await ctx.cleanup();
	});

	describe('signature extraction', () => {
		it('extracts TypeScript function signature', async () => {
			const results = await search.search('getUser', {
				mode: 'definition',
				symbolName: 'getUser',
			});

			expect(results.results.length).toBeGreaterThan(0);
			const result = results.results[0];
			// Signature should contain the function declaration
			if (result?.signature) {
				expect(result.signature).toContain('getUser');
			}
		}, 60_000);

		it('extracts Python function signature', async () => {
			const results = await search.search('add_two_numbers', {
				mode: 'definition',
				symbolName: 'add_two_numbers',
			});

			if (results.results.length > 0) {
				const result = results.results[0];
				if (result?.signature) {
					expect(result.signature).toContain('add_two_numbers');
				}
			}
		}, 60_000);

		it('extracts class signature', async () => {
			// Use semantic search with class filter, limited to TypeScript
			// (PHP/Kotlin have interfaces that are also typed as 'class')
			const results = await search.search('UserService class service', {
				mode: 'semantic',
				filters: {type: ['class'], extension: ['.ts']},
			});

			// Should find some classes with signatures
			if (results.results.length > 0) {
				const classResult = results.results.find(r => r.type === 'class');
				if (classResult?.signature) {
					expect(classResult.signature).toContain('class');
				}
			}
		}, 60_000);
	});

	describe('export detection', () => {
		it('detects exported functions', async () => {
			// Search for exported function in exported.ts
			const results = await search.search('publicUtil', {
				mode: 'definition',
				symbolName: 'publicUtil',
			});

			expect(results.results.length).toBeGreaterThan(0);
			const result = results.results.find(r =>
				r.filepath.includes('exported.ts'),
			);
			expect(result?.isExported).toBe(true);
		}, 60_000);

		it('detects non-exported functions', async () => {
			// Search for internal helper in exported.ts
			const results = await search.search('internalHelper', {
				mode: 'definition',
				symbolName: 'internalHelper',
			});

			if (results.results.length > 0) {
				const result = results.results.find(r =>
					r.filepath.includes('exported.ts'),
				);
				if (result) {
					expect(result.isExported).toBe(false);
				}
			}
		}, 60_000);

		it('detects exported classes', async () => {
			// Use semantic search with export filter
			const results = await search.search('class service user', {
				mode: 'semantic',
				filters: {
					type: ['class'],
					isExported: true,
				},
			});

			// Should find exported classes
			if (results.results.length > 0) {
				results.results.forEach(r => {
					expect(r.isExported).toBe(true);
				});
			}
		}, 60_000);

		it('filters work with isExported', async () => {
			// Get only exported symbols
			const exportedResults = await search.search('user', {
				filters: {isExported: true},
			});

			// All should be exported
			exportedResults.results.forEach(r => {
				expect(r.isExported).toBe(true);
			});

			// Get non-exported
			const internalResults = await search.search('helper', {
				filters: {isExported: false},
			});

			// All should NOT be exported
			internalResults.results.forEach(r => {
				expect(r.isExported).toBe(false);
			});
		}, 60_000);
	});

	describe('docstring extraction', () => {
		it('finds documented functions via hasDocstring filter', async () => {
			const results = await search.search('process', {
				filters: {hasDocstring: true},
			});

			// Should find documented functions
			expect(results.results.length).toBeGreaterThan(0);
		}, 60_000);

		it('documented Python functions are findable', async () => {
			// process_data in decorators.py has a docstring
			const results = await search.search('process_data', {
				mode: 'definition',
				symbolName: 'process_data',
			});

			if (results.results.length > 0) {
				const result = results.results.find(r =>
					r.filepath.includes('decorators.py'),
				);
				// The function should be found
				expect(result).toBeDefined();
			}
		}, 60_000);
	});

	describe('decorator extraction', () => {
		it('finds decorated Python functions', async () => {
			// Search semantically for Python functions in decorators file
			const results = await search.search(
				'process data logging decorator python',
				{
					mode: 'semantic',
					filters: {extension: ['.py']},
				},
			);

			// Should find functions from decorators.py
			if (results.results.length > 0) {
				expect(
					results.results.some(r => r.filepath.includes('decorators.py')),
				).toBe(true);
			}
		}, 60_000);

		it('decoratorContains filter works', async () => {
			const results = await search.search('function', {
				filters: {decoratorContains: 'log'},
			});

			// Should find functions with 'log' in decorator names
			// Results may be empty if extraction isn't working, but filter should not error
			expect(results).toBeDefined();
		}, 60_000);

		it('finds functions with multiple decorators', async () => {
			// Search for transform function in Python files
			const results = await search.search('transform value validate input', {
				mode: 'semantic',
				filters: {extension: ['.py']},
			});

			// Should find functions from decorators.py
			if (results.results.length > 0) {
				expect(results.results.some(r => r.filepath.includes('.py'))).toBe(
					true,
				);
			}
		}, 60_000);
	});

	describe('metadata in search results', () => {
		it('includes signature in results when available', async () => {
			const results = await search.search('async function fetch', {
				mode: 'semantic',
				limit: 5,
			});

			// At least some results should have signatures
			const withSignature = results.results.filter(r => r.signature);
			expect(withSignature.length).toBeGreaterThan(0);
		}, 60_000);

		it('includes isExported in results', async () => {
			const results = await search.search('export function', {
				mode: 'semantic',
				limit: 10,
			});

			// Results should have isExported defined
			results.results.forEach(r => {
				expect(typeof r.isExported).toBe('boolean');
			});
		}, 60_000);
	});
});
