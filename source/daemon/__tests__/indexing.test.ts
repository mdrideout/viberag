/**
 * E2E tests for the indexing service.
 *
 * Tests system behavior, not library correctness:
 * - Merkle tree correctly detects file changes
 * - Search returns expected files for known queries
 * - Incremental indexing only reprocesses what changed
 * - Manifest persistence enables recovery
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {IndexingService} from '../services/indexing.js';
import {SearchEngine} from '../services/search/index.js';
import {loadManifest} from '../lib/manifest.js';
import {LocalEmbeddingProvider} from '../providers/local.js';
import {chunk, processBatchesWithLimit} from '../providers/api-utils.js';
import type {
	EmbedOptions,
	EmbeddingProvider,
	ModelProgressCallback,
} from '../providers/types.js';
import {
	copyFixtureToTemp,
	addFile,
	modifyFile,
	deleteFile,
	waitForFs,
	type TestContext,
} from './helpers.js';

class FlakyBatchEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions: number;
	onBatchProgress?: (processed: number, total: number) => void;
	onSlotProcessing?: (index: number, batchInfo: string) => void;
	onSlotRateLimited?: (
		index: number,
		batchInfo: string,
		retryInfo: string,
	) => void;
	onSlotIdle?: (index: number) => void;
	onSlotFailure?: (data: {
		batchInfo: string;
		files: string[];
		chunkCount: number;
		error: string;
		timestamp: string;
	}) => void;
	onResetSlots?: () => void;
	onThrottle?: (message: string | null) => void;

	private readonly delegate: LocalEmbeddingProvider;
	private readonly failFile: string | null;
	private readonly batchSize: number;

	constructor(failFile: string | null, batchSize: number = 1) {
		this.delegate = new LocalEmbeddingProvider();
		this.dimensions = this.delegate.dimensions;
		this.failFile = failFile;
		this.batchSize = batchSize;
	}

	async initialize(onProgress?: ModelProgressCallback): Promise<void> {
		await this.delegate.initialize(onProgress);
	}

	async embed(
		texts: string[],
		options?: EmbedOptions,
	): Promise<Array<number[] | null>> {
		if (texts.length === 0) {
			return [];
		}

		const batches = chunk(texts, this.batchSize);
		const batchIndexLookup = new Map(
			batches.map((batch, index) => [batch, index]),
		);
		const metadata = options?.chunkMetadata ?? [];
		const metadataBatches = chunk(metadata, this.batchSize).map(batch => ({
			filepaths: batch.map(item => item.filepath),
			lineRanges: batch.map(item => ({
				start: item.startLine,
				end: item.endLine,
			})),
			sizes: batch.map(item => item.size),
		}));

		return processBatchesWithLimit(
			batches,
			async batch => {
				const batchIndex = batchIndexLookup.get(batch) ?? 0;
				const batchMeta = metadataBatches[batchIndex];
				if (this.failFile && batchMeta?.filepaths.includes(this.failFile)) {
					throw new Error('Simulated embedding failure');
				}

				const vectors = await this.delegate.embed(batch);
				return vectors as number[][];
			},
			{
				onBatchProgress: this.onBatchProgress,
				onSlotProcessing: this.onSlotProcessing,
				onSlotRateLimited: this.onSlotRateLimited,
				onSlotIdle: this.onSlotIdle,
				onSlotFailure: this.onSlotFailure,
				onResetSlots: this.onResetSlots,
				onThrottle: this.onThrottle,
			},
			this.batchSize,
			metadataBatches,
			options?.logger,
			options?.chunkOffset ?? 0,
		);
	}

	async embedSingle(text: string): Promise<number[]> {
		return this.delegate.embedSingle(text);
	}

	close(): void {
		this.delegate.close();
	}
}

describe('Indexing E2E', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('indexes codebase and finds files by semantic search', async () => {
		// Index fixture
		const indexer = new IndexingService(ctx.projectRoot);
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
		const indexer = new IndexingService(ctx.projectRoot);
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
		const indexer2 = new IndexingService(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesNew).toBe(1);
		expect(stats.filesModified).toBe(1);
		expect(stats.filesDeleted).toBe(1);
	}, 60_000);

	it('skips unchanged files on reindex', async () => {
		// Initial index
		const indexer = new IndexingService(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Reindex with no changes
		const indexer2 = new IndexingService(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesNew).toBe(0);
		expect(stats.filesModified).toBe(0);
		expect(stats.filesDeleted).toBe(0);
		expect(stats.chunksAdded).toBe(0);
	}, 60_000);

	it('recovers state from manifest after restart', async () => {
		// Index
		const indexer = new IndexingService(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// "Restart" - create new indexer instance
		const indexer2 = new IndexingService(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		// Should detect no changes (recovered from manifest)
		expect(stats.filesNew).toBe(0);
		expect(stats.filesModified).toBe(0);
		expect(stats.filesDeleted).toBe(0);
	}, 60_000);

	it('reindexes all files with force=true', async () => {
		// Initial index
		const indexer = new IndexingService(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Force reindex
		const indexer2 = new IndexingService(ctx.projectRoot);
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
		const indexer = new IndexingService(ctx.projectRoot);
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
		const indexer2 = new IndexingService(ctx.projectRoot);
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
		const indexer = new IndexingService(ctx.projectRoot);
		await indexer.index();
		indexer.close();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('vector search finds semantically similar content', async () => {
		const search = new SearchEngine(ctx.projectRoot);
		// "add two numbers" should find math.py via semantic similarity
		// Use a more specific query to reduce competition with other files
		const results = await search.searchVector('add two numbers python', 10);
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
		// Use a specific query with exact match to ensure http_client.ts ranks high
		// Search for 'fetchData' which is a unique symbol in http_client.ts
		const results = await search.search('fetchData http client', {limit: 10});
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
		const indexer = new IndexingService(ctx.projectRoot);
		const stats = await indexer.index();
		indexer.close();

		// Should not crash, empty file counted but produces no chunks
		expect(stats.filesScanned).toBeGreaterThan(0);
	}, 60_000);

	it('indexes files with unicode content', async () => {
		// unicode_content.js has Korean, emoji, Chinese
		const indexer = new IndexingService(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		const search = new SearchEngine(ctx.projectRoot);
		// Search for actual text in the file - 'rocket' is in '🚀 rocket launch 🎉'
		const results = await search.search('rocket launch sparkles', {limit: 10});
		expect(
			results.results.some(r => r.filepath.includes('unicode_content')),
		).toBe(true);
		search.close();
	}, 60_000);

	it('handles files with syntax errors gracefully', async () => {
		// Add malformed file
		await addFile(ctx.projectRoot, 'broken.ts', 'function { broken syntax');
		await waitForFs();

		const indexer = new IndexingService(ctx.projectRoot);
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

		const indexer = new IndexingService(ctx.projectRoot);
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

		const indexer = new IndexingService(ctx.projectRoot);
		// Should not crash
		const stats = await indexer.index();
		indexer.close();

		// Index should complete successfully
		expect(stats.filesScanned).toBeGreaterThan(0);
	}, 60_000);

	it('records failed batches and clears them after a successful reindex', async () => {
		const failingProvider = new FlakyBatchEmbeddingProvider('math.py');
		const indexer = new IndexingService(ctx.projectRoot, {
			embeddings: failingProvider,
		});
		await indexer.index();
		indexer.close();

		const manifest = await loadManifest(ctx.projectRoot);
		expect(manifest.failedBatches.length).toBeGreaterThan(0);
		expect(manifest.failedFiles).toContain('math.py');

		const search = new SearchEngine(ctx.projectRoot);
		const results = await search.search('fetch data API request');
		expect(
			results.results.some(r => r.filepath.includes('http_client.ts')),
		).toBe(true);
		search.close();

		const healthyProvider = new FlakyBatchEmbeddingProvider(null);
		const indexer2 = new IndexingService(ctx.projectRoot, {
			embeddings: healthyProvider,
		});
		await indexer2.index();
		indexer2.close();

		const clearedManifest = await loadManifest(ctx.projectRoot);
		expect(clearedManifest.failedBatches.length).toBe(0);
		expect(clearedManifest.failedFiles.length).toBe(0);
	}, 60_000);

	it('drops failed file entries when the file is deleted', async () => {
		const failingProvider = new FlakyBatchEmbeddingProvider('math.py');
		const indexer = new IndexingService(ctx.projectRoot, {
			embeddings: failingProvider,
		});
		await indexer.index();
		indexer.close();

		let manifest = await loadManifest(ctx.projectRoot);
		expect(manifest.failedFiles).toContain('math.py');

		await deleteFile(ctx.projectRoot, 'math.py');
		await waitForFs();

		const healthyProvider = new FlakyBatchEmbeddingProvider(null);
		const indexer2 = new IndexingService(ctx.projectRoot, {
			embeddings: healthyProvider,
		});
		await indexer2.index();
		indexer2.close();

		manifest = await loadManifest(ctx.projectRoot);
		expect(manifest.failedFiles).not.toContain('math.py');
		expect(manifest.failedBatches.length).toBe(0);
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
		const indexer = new IndexingService(ctx.projectRoot);
		const stats = await indexer.index();
		indexer.close();

		// Should have indexed all nested files (5 original + 10 nested = 15)
		// Note: empty.py may not produce chunks
		expect(stats.filesScanned).toBeGreaterThanOrEqual(10);

		// Should find deeply nested file via definition mode (exact symbol lookup)
		const search = new SearchEngine(ctx.projectRoot);
		const results = await search.search('flattenDeep', {
			mode: 'definition',
			symbolName: 'flattenDeep',
		});
		expect(results.results.some(r => r.filepath.includes('deep/nested'))).toBe(
			true,
		);
		search.close();
	}, 60_000);

	it('detects changes in deeply nested files', async () => {
		// Initial index
		const indexer = new IndexingService(ctx.projectRoot);
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
		const indexer2 = new IndexingService(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesModified).toBe(1);
	}, 60_000);

	it('removes chunks when nested file deleted', async () => {
		// Initial index
		const indexer = new IndexingService(ctx.projectRoot);
		await indexer.index();
		indexer.close();

		// Verify file is searchable via definition mode (exact symbol lookup)
		const search1 = new SearchEngine(ctx.projectRoot);
		let results = await search1.search('LoginForm', {
			mode: 'definition',
			symbolName: 'LoginForm',
		});
		expect(results.results.some(r => r.filepath.includes('LoginForm'))).toBe(
			true,
		);
		search1.close();

		// Delete nested file
		await deleteFile(ctx.projectRoot, 'src/components/forms/LoginForm.tsx');
		await waitForFs();

		// Reindex
		const indexer2 = new IndexingService(ctx.projectRoot);
		const stats = await indexer2.index();
		indexer2.close();

		expect(stats.filesDeleted).toBe(1);

		// Should no longer be searchable
		const search2 = new SearchEngine(ctx.projectRoot);
		results = await search2.search('LoginForm', {
			mode: 'definition',
			symbolName: 'LoginForm',
		});
		expect(results.results.some(r => r.filepath.includes('LoginForm'))).toBe(
			false,
		);
		search2.close();
	}, 60_000);

	it('indexes sibling files in same directory', async () => {
		const indexer = new IndexingService(ctx.projectRoot);
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
