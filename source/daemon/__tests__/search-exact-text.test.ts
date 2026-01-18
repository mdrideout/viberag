/**
 * Regression tests for v2 exact-text and usage extraction.
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {IndexingServiceV2} from '../services/v2/indexing.js';
import {SearchEngineV2} from '../services/v2/search/engine.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

describe('V2 Exact Text + Usages', () => {
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

	it('exact_text finds string literals inside small symbol definitions', async () => {
		const results = await search.search('application/json', {
			intent: 'exact_text',
			k: 20,
			explain: false,
		});

		expect(results.intent_used).toBe('exact_text');
		expect(
			results.groups.blocks.some(
				r => r.table === 'symbols' && r.file_path === 'http_client.ts',
			),
		).toBe(true);
	});

	it('findUsages does not misclassify function definitions as call refs', async () => {
		const usages = await search.findUsages({
			symbol_name: 'internalHelper',
			k: 500,
		});

		const file = usages.by_file.find(f => f.file_path === 'exported.ts');
		expect(file).toBeDefined();

		const callRefs = file!.refs.filter(
			r => r.ref_kind === 'call' && r.token_text === 'internalHelper',
		);

		expect(callRefs.some(r => r.start_line === 50)).toBe(true);
		expect(callRefs.some(r => r.start_line === 41)).toBe(false);
	});
});
