/**
 * Tests for v2 deterministic metadata extraction.
 *
 * V2 does not expose metadata filters in the search scope; instead, agents
 * retrieve deterministic facts via stable handles (symbol_id → getSymbol()).
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {IndexingServiceV2} from '../services/v2/indexing.js';
import {SearchEngineV2} from '../services/v2/search/engine.js';
import type {V2SearchScope} from '../services/v2/search/types.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

async function getSymbolFromDefinitionSearch(args: {
	search: SearchEngineV2;
	query: string;
	file_path: string;
	scope?: V2SearchScope;
}): Promise<Record<string, unknown>> {
	const results = await args.search.search(args.query, {
		intent: 'definition',
		k: 50,
		explain: false,
		scope: args.scope ?? {},
	});

	const needle = args.query.toLowerCase();
	const hit =
		results.groups.definitions.find(
			r =>
				r.file_path === args.file_path &&
				r.title.toLowerCase().includes(needle),
		) ?? results.groups.definitions.find(r => r.file_path === args.file_path);
	expect(hit).toBeDefined();

	const symbol = await args.search.getSymbol(hit!.id);
	expect(symbol).not.toBeNull();
	return symbol!;
}

describe('V2 Metadata Extraction', () => {
	let ctx: TestContext;
	let search: SearchEngineV2;

	beforeAll(async () => {
		ctx = await copyFixtureToTemp('codebase');
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();
		search = new SearchEngineV2(ctx.projectRoot);
	}, 180_000);

	afterAll(async () => {
		search.close();
		await ctx.cleanup();
	});

	it('extracts TypeScript function signature', async () => {
		const symbol = await getSymbolFromDefinitionSearch({
			search,
			query: 'getUser',
			file_path: 'src/api/endpoints.ts',
		});

		expect(typeof symbol['signature']).toBe('string');
		expect(String(symbol['signature'])).toContain('getUser');
	});

	it('extracts Python function signature', async () => {
		const symbol = await getSymbolFromDefinitionSearch({
			search,
			query: 'add_two_numbers',
			file_path: 'math.py',
			scope: {extension: ['.py']},
		});

		expect(typeof symbol['signature']).toBe('string');
		expect(String(symbol['signature'])).toContain('add_two_numbers');
	});

	it('detects exported vs non-exported definitions', async () => {
		const exported = await getSymbolFromDefinitionSearch({
			search,
			query: 'publicUtil',
			file_path: 'exported.ts',
		});
		expect(exported['is_exported']).toBe(true);

		const internal = await getSymbolFromDefinitionSearch({
			search,
			query: 'internalHelper',
			file_path: 'exported.ts',
		});
		expect(internal['is_exported']).toBe(false);
	});

	it('extracts docstrings and decorator names for Python', async () => {
		const symbol = await getSymbolFromDefinitionSearch({
			search,
			query: 'transform_value',
			file_path: 'decorators.py',
			scope: {extension: ['.py']},
		});

		expect(typeof symbol['docstring']).toBe('string');
		expect(String(symbol['docstring'])).toContain('multiple decorators');

		expect(Array.isArray(symbol['decorator_names'])).toBe(true);
		const decorators = symbol['decorator_names'] as string[];
		expect(decorators).toContain('log_call');
		expect(decorators).toContain('validate_input');
	});
});
