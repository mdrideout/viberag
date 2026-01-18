/**
 * Tests for v2 search intents.
 *
 * V2 removes v1 "modes" in favor of intent routing:
 * - definition: symbol lookup (lexical + vector fallback)
 * - similar_code: vector search over code blocks
 * - usage: refs lookup (find where a token is used)
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {IndexingServiceV2} from '../services/v2/indexing.js';
import {SearchEngineV2} from '../services/v2/search/engine.js';
import {copyFixtureToTemp, type TestContext} from './helpers.js';

describe('V2 Search Intents', () => {
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

	it('definition intent finds function definitions by name', async () => {
		const results = await search.search('getUser', {
			intent: 'definition',
			k: 20,
			explain: false,
		});

		expect(results.intent_used).toBe('definition');
		expect(
			results.groups.definitions.some(
				r =>
					r.file_path === 'src/api/endpoints.ts' && r.title.includes('getUser'),
			),
		).toBe(true);
	});

	it('does not return an exact match for a non-existent symbol', async () => {
		const query = 'nonExistentSymbolXYZ123';
		const results = await search.search(query, {
			intent: 'definition',
			k: 10,
			explain: false,
		});
		const needle = query.toLowerCase();
		expect(
			results.groups.definitions.some(r =>
				r.title.toLowerCase().includes(needle),
			),
		).toBe(false);
	});

	it('similar_code intent finds similar code by snippet', async () => {
		const snippet = `async function fetchData(url) {
  const response = await fetch(url);
  return response.json();
}`;

		const results = await search.search(snippet, {
			intent: 'similar_code',
			k: 10,
			explain: false,
		});

		expect(results.intent_used).toBe('similar_code');
		expect(
			results.groups.blocks.some(r => r.file_path.includes('http_client.ts')),
		).toBe(true);
	});

	it('auto routes usage-shaped queries to usage intent', async () => {
		const results = await search.search('where is login used', {
			intent: 'auto',
			k: 50,
			explain: false,
		});

		expect(results.intent_used).toBe('usage');
		expect(results.groups.usages.length).toBeGreaterThan(0);
		expect(
			results.groups.usages.some(r =>
				r.file_path.includes('src/services/auth.ts'),
			),
		).toBe(true);
	});
});
