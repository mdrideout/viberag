/**
 * E2E tests for the RAG system.
 *
 * Tests system behavior, not library correctness:
 * - Merkle tree correctly detects file changes
 * - Search returns expected files for known queries
 * - Incremental indexing only reprocesses what changed
 * - Manifest persistence enables recovery
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {Indexer} from '../indexer/indexer.js';
import {SearchEngine} from '../search/index.js';
import {
	copyFixtureToTemp,
	addFile,
	modifyFile,
	deleteFile,
	waitForFs,
	type TestContext,
} from './helpers.js';

describe('RAG E2E', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('indexes codebase and finds files by semantic search', async () => {
		// Index fixture
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Search for math operations → should find math.py
		const search = new SearchEngine(ctx.projectRoot);
		const mathResults = await search.search('add two numbers calculate sum');
		expect(mathResults.results.some(r => r.filepath.includes('math.py'))).toBe(
			true,
		);

		// Search for HTTP/API → should find http_client.ts
		const httpResults = await search.search('fetch data API request');
		expect(
			httpResults.results.some(r => r.filepath.includes('http_client.ts')),
		).toBe(true);

		// Search for string/date → should find utils.js
		const utilsResults = await search.search('format string parse date');
		expect(
			utilsResults.results.some(r => r.filepath.includes('utils.js')),
		).toBe(true);

		search.close();
	}, 60_000);

	it('detects new/modified/deleted files correctly', async () => {
		// Initial index
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Add new file
		await addFile(
			ctx.projectRoot,
			'new_module.py',
			'def new_function():\n    return "new"\n',
		);

		// Modify existing file
		await modifyFile(
			ctx.projectRoot,
			'math.py',
			'# Modified file\ndef add(a, b):\n    return a + b\n',
		);

		// Delete a file
		await deleteFile(ctx.projectRoot, 'utils.js');

		await waitForFs();

		// Reindex
		const indexer2 = new Indexer(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesNew).toBe(1);
		expect(stats.filesModified).toBe(1);
		expect(stats.filesDeleted).toBe(1);
	}, 60_000);

	it('skips unchanged files on reindex', async () => {
		// Initial index
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Reindex with no changes
		const indexer2 = new Indexer(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesNew).toBe(0);
		expect(stats.filesModified).toBe(0);
		expect(stats.filesDeleted).toBe(0);
		expect(stats.chunksAdded).toBe(0);
	}, 60_000);

	it('recovers state from manifest after restart', async () => {
		// Index
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// "Restart" - create new indexer instance
		const indexer2 = new Indexer(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		// Should detect no changes (recovered from manifest)
		expect(stats.filesNew).toBe(0);
		expect(stats.filesModified).toBe(0);
		expect(stats.filesDeleted).toBe(0);
	}, 60_000);

	it('reindexes all files with force=true', async () => {
		// Initial index
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Force reindex
		const indexer2 = new Indexer(ctx.projectRoot);
		const stats = await indexer2.index({force: true});
		indexer2.close();

		// All files treated as new (5 files in fixture)
		expect(stats.filesNew).toBeGreaterThanOrEqual(4); // fixture file count (empty.py may not produce chunks)
		expect(stats.chunksAdded).toBeGreaterThan(0);
		// Embeddings should be cached from first run
		expect(stats.embeddingsCached).toBeGreaterThan(0);
	}, 60_000);

	it('removes deleted files from search results', async () => {
		// Initial index
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Verify math.py is searchable
		const search = new SearchEngine(ctx.projectRoot);
		let results = await search.search('add two numbers');
		expect(results.results.some(r => r.filepath.includes('math.py'))).toBe(
			true,
		);
		search.close();

		// Delete math.py
		await deleteFile(ctx.projectRoot, 'math.py');
		await waitForFs();

		// Reindex
		const indexer2 = new Indexer(ctx.projectRoot);
		await indexer2.index();
		indexer2.close();

		// Should no longer appear in results
		const search2 = new SearchEngine(ctx.projectRoot);
		results = await search2.search('add two numbers');
		expect(results.results.some(r => r.filepath.includes('math.py'))).toBe(
			false,
		);
		search2.close();
	}, 60_000);
});

describe('Search modes', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
		// Index the fixture
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('vector search finds semantically similar content', async () => {
		const search = new SearchEngine(ctx.projectRoot);
		// "calculate sum" should find math.py via semantic similarity
		const results = await search.searchVector('calculate sum', 5);
		expect(results.results.some(r => r.filepath.includes('math.py'))).toBe(
			true,
		);
		search.close();
	}, 60_000);

	it('FTS search finds exact keyword matches', async () => {
		const search = new SearchEngine(ctx.projectRoot);
		// "fetchData" exact match in http_client.ts
		const results = await search.searchFts('fetchData', 5);
		expect(
			results.results.some(r => r.filepath.includes('http_client.ts')),
		).toBe(true);
		search.close();
	}, 60_000);

	it('hybrid search returns results with both scores', async () => {
		const search = new SearchEngine(ctx.projectRoot);
		const results = await search.search('API request fetch');
		expect(
			results.results.some(r => r.filepath.includes('http_client.ts')),
		).toBe(true);
		// Results should have both vector and FTS scores
		if (results.results.length > 0) {
			expect(results.results[0]).toHaveProperty('vectorScore');
			expect(results.results[0]).toHaveProperty('ftsScore');
		}
		search.close();
	}, 60_000);
});

describe('Edge cases', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('handles empty files gracefully', async () => {
		// empty.py is already in fixture (0 bytes)
		const indexer = new Indexer(ctx.projectRoot);
		const stats = await indexer.index();
		indexer.close();

		// Should not crash, empty file counted but produces no chunks
		expect(stats.filesScanned).toBeGreaterThan(0);
	}, 60_000);

	it('indexes files with unicode content', async () => {
		// unicode_content.js has Korean, emoji, Chinese
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		const search = new SearchEngine(ctx.projectRoot);
		const results = await search.search('Korean greeting emoji');
		expect(
			results.results.some(r => r.filepath.includes('unicode_content')),
		).toBe(true);
		search.close();
	}, 60_000);

	it('handles files with syntax errors gracefully', async () => {
		// Add malformed file
		await addFile(ctx.projectRoot, 'broken.ts', 'function { broken syntax');
		await waitForFs();

		const indexer = new Indexer(ctx.projectRoot);
		const stats = await indexer.index();
		indexer.close();

		// Should still index (as module chunk), not crash
		expect(stats.chunksAdded).toBeGreaterThan(0);
	}, 60_000);
});

describe('Error handling', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('continues indexing when one file fails to parse', async () => {
		// Add broken file alongside good files
		await addFile(ctx.projectRoot, 'broken.ts', 'const x = {{{');
		await addFile(
			ctx.projectRoot,
			'good.ts',
			'export function works() { return 1; }',
		);
		await waitForFs();

		const indexer = new Indexer(ctx.projectRoot);
		const stats = await indexer.index();
		indexer.close();

		// Both files processed
		expect(stats.chunksAdded).toBeGreaterThan(0);

		// Good file should be searchable
		const search = new SearchEngine(ctx.projectRoot);
		const results = await search.search('works function export');
		expect(results.results.some(r => r.filepath.includes('good.ts'))).toBe(
			true,
		);
		search.close();
	}, 60_000);

	it('skips binary files without error', async () => {
		// Add binary content (PNG header bytes)
		const binaryContent = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]).toString('binary');
		await addFile(ctx.projectRoot, 'image.png', binaryContent);
		await waitForFs();

		const indexer = new Indexer(ctx.projectRoot);
		// Should not crash
		const stats = await indexer.index();
		indexer.close();

		// Index should complete successfully
		expect(stats.filesScanned).toBeGreaterThan(0);
	}, 60_000);
});

describe('Subdirectory indexing', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('indexes files in nested subdirectories', async () => {
		const indexer = new Indexer(ctx.projectRoot);
		const stats = await indexer.index();
		indexer.close();

		// Should have indexed all nested files (5 original + 10 nested = 15)
		// Note: empty.py may not produce chunks
		expect(stats.filesScanned).toBeGreaterThanOrEqual(10);

		// Should find deeply nested file via search
		const search = new SearchEngine(ctx.projectRoot);
		const results = await search.search('flatten deeply nested array');
		expect(results.results.some(r => r.filepath.includes('deep/nested'))).toBe(
			true,
		);
		search.close();
	}, 60_000);

	it('detects changes in deeply nested files', async () => {
		// Initial index
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Modify file 3 levels deep
		await modifyFile(
			ctx.projectRoot,
			'src/components/forms/LoginForm.tsx',
			'// modified login form\nexport function LoginForm() { return null; }',
		);
		await waitForFs();

		// Reindex
		const indexer2 = new Indexer(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesModified).toBe(1);
	}, 60_000);

	it('removes chunks when nested file deleted', async () => {
		// Initial index
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Verify file is searchable
		const search1 = new SearchEngine(ctx.projectRoot);
		let results = await search1.search('LoginForm authentication login');
		expect(results.results.some(r => r.filepath.includes('LoginForm'))).toBe(
			true,
		);
		search1.close();

		// Delete nested file
		await deleteFile(ctx.projectRoot, 'src/components/forms/LoginForm.tsx');
		await waitForFs();

		// Reindex
		const indexer2 = new Indexer(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesDeleted).toBe(1);

		// Should no longer be searchable
		const search2 = new SearchEngine(ctx.projectRoot);
		results = await search2.search('LoginForm authentication login');
		expect(results.results.some(r => r.filepath.includes('LoginForm'))).toBe(
			false,
		);
		search2.close();
	}, 60_000);

	it('indexes sibling files in same directory', async () => {
		const indexer = new Indexer(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		const search = new SearchEngine(ctx.projectRoot);

		// Should find both api.ts and auth.ts in services/
		const apiResults = await search.search('API request fetch endpoint');
		expect(
			apiResults.results.some(r => r.filepath.includes('services/api.ts')),
		).toBe(true);

		const authResults = await search.search('authentication token login');
		expect(
			authResults.results.some(r => r.filepath.includes('services/auth.ts')),
		).toBe(true);

		search.close();
	}, 60_000);
});
