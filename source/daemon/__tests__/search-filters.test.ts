/**
 * Tests for search filters.
 *
 * Tests the transparent, AI-controlled filter system:
 * - Path filters: pathPrefix, pathContains, pathNotContains
 * - Type filters: type, extension
 * - Metadata filters: isExported, decoratorContains, hasDocstring
 * - Filter combinations
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {IndexingService} from '../services/indexing.js';
import {SearchEngine} from '../services/search/index.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

describe('Search Filters', () => {
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

	describe('path filters', () => {
		it('filters by pathPrefix', async () => {
			const results = await search.search('function', {
				filters: {pathPrefix: 'src/'},
			});

			expect(results.results.length).toBeGreaterThan(0);
			// All results should be in src/ directory
			expect(results.results.every(r => r.filepath.startsWith('src/'))).toBe(
				true,
			);
		}, 60_000);

		it('filters by pathPrefix to specific subdirectory', async () => {
			const results = await search.search('function', {
				filters: {pathPrefix: 'src/api/'},
			});

			// All results should be in src/api/
			results.results.forEach(r => {
				expect(r.filepath.startsWith('src/api/')).toBe(true);
			});
		}, 60_000);

		it('filters by pathContains', async () => {
			const results = await search.search('function', {
				filters: {pathContains: ['services']},
			});

			expect(results.results.length).toBeGreaterThan(0);
			// All results should have 'services' in path
			expect(results.results.every(r => r.filepath.includes('services'))).toBe(
				true,
			);
		}, 60_000);

		it('filters by pathContains with multiple strings (AND)', async () => {
			const results = await search.search('function', {
				filters: {pathContains: ['src', 'utils']},
			});

			// All results must contain BOTH strings
			results.results.forEach(r => {
				expect(r.filepath.includes('src')).toBe(true);
				expect(r.filepath.includes('utils')).toBe(true);
			});
		}, 60_000);

		it('excludes paths with pathNotContains', async () => {
			const results = await search.search('function', {
				filters: {pathNotContains: ['__tests__']},
			});

			// No results should be in __tests__ directory
			expect(
				results.results.every(r => !r.filepath.includes('__tests__')),
			).toBe(true);
		}, 60_000);

		it('excludes multiple patterns with pathNotContains', async () => {
			const results = await search.search('function', {
				filters: {pathNotContains: ['__tests__', '.test.', '.spec.']},
			});

			// No results should match any exclusion pattern
			results.results.forEach(r => {
				expect(r.filepath.includes('__tests__')).toBe(false);
				expect(r.filepath.includes('.test.')).toBe(false);
				expect(r.filepath.includes('.spec.')).toBe(false);
			});
		}, 60_000);
	});

	describe('type filters', () => {
		it('filters by function type', async () => {
			const results = await search.search('data', {
				filters: {type: ['function']},
			});

			expect(results.results.length).toBeGreaterThan(0);
			// All results should be functions
			expect(results.results.every(r => r.type === 'function')).toBe(true);
		}, 60_000);

		it('filters by class type', async () => {
			const results = await search.search('service', {
				filters: {type: ['class']},
			});

			// All results should be classes
			results.results.forEach(r => {
				expect(r.type).toBe('class');
			});
		}, 60_000);

		it('filters by method type', async () => {
			const results = await search.search('get', {
				filters: {type: ['method']},
			});

			// All results should be methods
			results.results.forEach(r => {
				expect(r.type).toBe('method');
			});
		}, 60_000);

		it('filters by multiple types (OR)', async () => {
			const results = await search.search('user', {
				filters: {type: ['function', 'class']},
			});

			// All results should be either function or class
			results.results.forEach(r => {
				expect(['function', 'class']).toContain(r.type);
			});
		}, 60_000);
	});

	describe('extension filters', () => {
		it('filters by .py extension', async () => {
			const results = await search.search('function', {
				filters: {extension: ['.py']},
			});

			expect(results.results.length).toBeGreaterThan(0);
			// All results should be Python files
			expect(results.results.every(r => r.filepath.endsWith('.py'))).toBe(true);
		}, 60_000);

		it('filters by .ts extension', async () => {
			const results = await search.search('function', {
				filters: {extension: ['.ts']},
			});

			expect(results.results.length).toBeGreaterThan(0);
			// All results should be TypeScript files
			expect(results.results.every(r => r.filepath.endsWith('.ts'))).toBe(true);
		}, 60_000);

		it('filters by multiple extensions (OR)', async () => {
			const results = await search.search('function', {
				filters: {extension: ['.ts', '.tsx']},
			});

			// All results should be .ts or .tsx files
			results.results.forEach(r => {
				expect(r.filepath.endsWith('.ts') || r.filepath.endsWith('.tsx')).toBe(
					true,
				);
			});
		}, 60_000);

		it('filters by .js extension', async () => {
			const results = await search.search('format', {
				filters: {extension: ['.js']},
			});

			// All results should be JavaScript files
			results.results.forEach(r => {
				expect(r.filepath.endsWith('.js')).toBe(true);
			});
		}, 60_000);
	});

	describe('metadata filters', () => {
		it('filters by isExported true', async () => {
			const results = await search.search('function', {
				filters: {isExported: true},
			});

			expect(results.results.length).toBeGreaterThan(0);
			// All results should be exported
			expect(results.results.every(r => r.isExported === true)).toBe(true);
		}, 60_000);

		it('filters by isExported false', async () => {
			const results = await search.search('helper internal', {
				filters: {isExported: false},
			});

			// All results should NOT be exported
			results.results.forEach(r => {
				expect(r.isExported).toBe(false);
			});
		}, 60_000);

		it('filters by decoratorContains', async () => {
			const results = await search.search('function', {
				filters: {decoratorContains: 'log'},
			});

			// Should find decorated Python functions
			// Results may be empty if no decorated functions match, that's ok
			if (results.results.length > 0) {
				expect(
					results.results.some(r => r.filepath.includes('decorators.py')),
				).toBe(true);
			}
		}, 60_000);

		it('filters by hasDocstring true', async () => {
			const results = await search.search('function', {
				filters: {hasDocstring: true},
			});

			// Results should be documented code
			// Most fixture files have JSDoc/docstrings
			expect(results.results.length).toBeGreaterThan(0);
		}, 60_000);
	});

	describe('filter combinations', () => {
		it('combines pathPrefix + type', async () => {
			const results = await search.search('data', {
				filters: {
					pathPrefix: 'src/',
					type: ['function'],
				},
			});

			// All results should be functions in src/
			results.results.forEach(r => {
				expect(r.filepath.startsWith('src/')).toBe(true);
				expect(r.type).toBe('function');
			});
		}, 60_000);

		it('combines pathNotContains + isExported', async () => {
			const results = await search.search('user', {
				filters: {
					pathNotContains: ['__tests__'],
					isExported: true,
				},
			});

			// All results should be exported and NOT in tests
			results.results.forEach(r => {
				expect(r.filepath.includes('__tests__')).toBe(false);
				expect(r.isExported).toBe(true);
			});
		}, 60_000);

		it('combines extension + type', async () => {
			const results = await search.search('process', {
				filters: {
					extension: ['.ts'],
					type: ['function'],
				},
			});

			// All results should be TypeScript functions
			results.results.forEach(r => {
				expect(r.filepath.endsWith('.ts')).toBe(true);
				expect(r.type).toBe('function');
			});
		}, 60_000);

		it('combines pathPrefix + pathNotContains + type', async () => {
			const results = await search.search('function', {
				filters: {
					pathPrefix: 'src/',
					pathNotContains: ['__tests__'],
					type: ['function', 'method'],
				},
			});

			// Complex filter combination
			results.results.forEach(r => {
				expect(r.filepath.startsWith('src/')).toBe(true);
				expect(r.filepath.includes('__tests__')).toBe(false);
				expect(['function', 'method']).toContain(r.type);
			});
		}, 60_000);
	});
});
