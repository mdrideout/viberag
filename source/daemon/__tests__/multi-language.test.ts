/**
 * Multi-language support tests for v2.
 *
 * V2 must be able to index and retrieve across multiple languages. Some
 * languages may fall back to module-level chunking when the grammar is not
 * available (e.g., Dart currently).
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

describe('Multi-Language Support (v2)', () => {
	let ctx: TestContext;
	let search: SearchEngineV2;

	beforeAll(async () => {
		ctx = await copyFixtureToTemp('codebase');
		const indexer = new IndexingServiceV2(ctx.projectRoot);
		await indexer.index();
		indexer.close();
		search = new SearchEngineV2(ctx.projectRoot);
	}, 240_000);

	afterAll(async () => {
		search.close();
		await ctx.cleanup();
	});

	it('Go: exported vs unexported symbols', async () => {
		const exported = await getSymbolFromDefinitionSearch({
			search,
			query: 'NewGreeter',
			file_path: 'sample.go',
			scope: {extension: ['.go']},
		});
		expect(exported['is_exported']).toBe(true);

		const unexported = await getSymbolFromDefinitionSearch({
			search,
			query: 'privateHelper',
			file_path: 'sample.go',
			scope: {extension: ['.go']},
		});
		expect(unexported['is_exported']).toBe(false);
	});

	it('Rust: exported vs unexported symbols', async () => {
		const exported = await getSymbolFromDefinitionSearch({
			search,
			query: 'add',
			file_path: 'sample.rs',
			scope: {extension: ['.rs']},
		});
		expect(exported['is_exported']).toBe(true);

		const unexported = await getSymbolFromDefinitionSearch({
			search,
			query: 'private_function',
			file_path: 'sample.rs',
			scope: {extension: ['.rs']},
		});
		expect(unexported['is_exported']).toBe(false);
	});

	it('Java/C#/Kotlin/Swift/PHP: indexes public Greeter definitions', async () => {
		const cases: Array<{ext: string; file: string}> = [
			{ext: '.java', file: 'Sample.java'},
			{ext: '.cs', file: 'Sample.cs'},
			{ext: '.kt', file: 'Sample.kt'},
			{ext: '.swift', file: 'Sample.swift'},
			{ext: '.php', file: 'sample.php'},
		];

		for (const c of cases) {
			const symbol = await getSymbolFromDefinitionSearch({
				search,
				query: 'Greeter',
				file_path: c.file,
				scope: {extension: [c.ext]},
			});
			expect(symbol['is_exported']).toBe(true);
		}
	});

	it('Dart: indexes file row even when grammar is unavailable', async () => {
		const results = await search.search('Sample Dart library', {
			intent: 'concept',
			k: 10,
			explain: false,
			scope: {extension: ['.dart']},
		});

		const hits = [
			...results.groups.files,
			...results.groups.definitions,
			...results.groups.blocks,
		];
		expect(hits.some(h => h.file_path === 'sample.dart')).toBe(true);
	});
});
