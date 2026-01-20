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

	it('findUsages ignores tokens in comments and string literals', async () => {
		const usages = await search.findUsages({
			symbol_name: 'FooBarNoiseToken',
			k: 50,
		});

		expect(usages.total_refs).toBe(0);
	});

	it('findUsages captures call refs inside template string substitutions', async () => {
		const usages = await search.findUsages({
			symbol_name: 'formatUserName',
			k: 200,
		});

		const file = usages.by_file.find(
			f => f.file_path === 'src/services/user_greeting.ts',
		);
		expect(file).toBeDefined();
		expect(
			file!.refs.some(
				r => r.ref_kind === 'call' && r.token_text === 'formatUserName',
			),
		).toBe(true);
		expect(
			file!.refs.some(
				r =>
					r.ref_kind === 'import' &&
					r.token_text === 'formatUserName' &&
					typeof r.module_name === 'string' &&
					r.module_name.includes('exported'),
			),
		).toBe(true);
	});

	it('findUsages captures refs from multi-line Python imports', async () => {
		const usages = await search.findUsages({
			symbol_name: 'sqrt',
			k: 200,
		});

		const file = usages.by_file.find(f => f.file_path === 'python_imports.py');
		expect(file).toBeDefined();
		expect(
			file!.refs.some(
				r =>
					r.ref_kind === 'import' &&
					r.token_text === 'sqrt' &&
					r.module_name === 'math',
			),
		).toBe(true);
	});

	it('findUsages captures refs from relative Python imports', async () => {
		const usages = await search.findUsages({
			symbol_name: 'LocalThing',
			k: 200,
		});

		const file = usages.by_file.find(f => f.file_path === 'python_imports.py');
		expect(file).toBeDefined();
		expect(
			file!.refs.some(
				r =>
					r.ref_kind === 'import' &&
					r.token_text === 'LocalThing' &&
					r.module_name === '.local_module',
			),
		).toBe(true);
	});

	it('findUsages does not silently truncate frequent call refs', async () => {
		const usages = await search.findUsages({
			symbol_name: 'veryUsed',
			k: 500,
		});

		const file = usages.by_file.find(
			f => f.file_path === 'src/utils/repeat_calls.ts',
		);
		expect(file).toBeDefined();

		const callRefs = file!.refs.filter(
			r => r.ref_kind === 'call' && r.token_text === 'veryUsed',
		);
		expect(callRefs.length).toBeGreaterThan(20);
	});
});
