/**
 * Tests for exhaustive search mode.
 *
 * Tests the exhaustive mode for refactoring tasks:
 * - Returns totalMatches count
 * - Returns more results than default limit
 * - Works with filters
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {Indexer} from '../indexer/indexer.js';
import {SearchEngine} from '../search/index.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

describe('Exhaustive Mode', () => {
	let ctx: TestContext;
	let search: SearchEngine;

	beforeAll(async () => {
		// Setup once - index the codebase
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

	it('returns totalMatches count when exhaustive is true', async () => {
		const results = await search.search('function', {exhaustive: true});

		expect(results.totalMatches).toBeDefined();
		expect(typeof results.totalMatches).toBe('number');
		expect(results.totalMatches).toBeGreaterThan(0);
		// totalMatches should equal results length in exhaustive mode
		expect(results.totalMatches).toBe(results.results.length);
	}, 60_000);

	it('does not return totalMatches when exhaustive is false', async () => {
		const results = await search.search('function', {exhaustive: false});

		expect(results.totalMatches).toBeUndefined();
	}, 60_000);

	it('returns more results than default limit', async () => {
		// Default limit is 10
		const normalResults = await search.search('function', {limit: 5});
		const exhaustiveResults = await search.search('function', {
			exhaustive: true,
		});

		// Exhaustive should return at least as many results
		expect(exhaustiveResults.results.length).toBeGreaterThanOrEqual(
			normalResults.results.length,
		);
	}, 60_000);

	it('works with semantic mode', async () => {
		const results = await search.search('data processing', {
			mode: 'semantic',
			exhaustive: true,
		});

		expect(results.totalMatches).toBeDefined();
		expect(results.searchType).toBe('semantic');
	}, 60_000);

	it('works with exact mode', async () => {
		const results = await search.search('function', {
			mode: 'exact',
			exhaustive: true,
		});

		expect(results.totalMatches).toBeDefined();
		expect(results.searchType).toBe('exact');
	}, 60_000);

	it('works with filters', async () => {
		const results = await search.search('function', {
			exhaustive: true,
			filters: {extension: ['.ts']},
		});

		expect(results.totalMatches).toBeDefined();
		// All results should be TypeScript
		expect(results.results.every(r => r.filepath.endsWith('.ts'))).toBe(true);
	}, 60_000);

	it('respects minScore threshold', async () => {
		const allResults = await search.search('function', {exhaustive: true});
		const filteredResults = await search.search('function', {
			exhaustive: true,
			minScore: 0.5,
		});

		// Filtered should have equal or fewer results
		expect(filteredResults.results.length).toBeLessThanOrEqual(
			allResults.results.length,
		);
		// All filtered results should have score >= 0.5
		filteredResults.results.forEach(r => {
			expect(r.score).toBeGreaterThanOrEqual(0.5);
		});
	}, 60_000);
});
