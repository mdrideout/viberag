/**
 * Search module for code search.
 */

import type {Table} from '@lancedb/lancedb';
import {loadConfig} from '../config/index.js';
import {
	LocalEmbeddingProvider,
	type EmbeddingProvider,
} from '../embeddings/index.js';
import type {Logger} from '../logger/index.js';
import {Storage} from '../storage/index.js';
import {ftsSearch} from './fts.js';
import {hybridRerank} from './hybrid.js';
import type {SearchOptions, SearchResults} from './types.js';
import {vectorSearch} from './vector.js';

export type {SearchOptions, SearchResult, SearchResults} from './types.js';
export {vectorSearch} from './vector.js';
export {ftsSearch, ensureFtsIndex} from './fts.js';
export {hybridRerank} from './hybrid.js';

/** Default search limit */
const DEFAULT_LIMIT = 10;

/** Default BM25 weight for hybrid search */
const DEFAULT_BM25_WEIGHT = 0.3;

/**
 * Search engine for code search.
 * Supports vector, FTS, and hybrid search.
 */
export class SearchEngine {
	private readonly projectRoot: string;
	private storage: Storage | null = null;
	private embeddings: EmbeddingProvider | null = null;
	private logger: Logger | null = null;
	private initialized = false;

	constructor(projectRoot: string, logger?: Logger) {
		this.projectRoot = projectRoot;
		this.logger = logger ?? null;
	}

	/**
	 * Perform hybrid search (vector + FTS with RRF reranking).
	 * This is the default search method.
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResults> {
		const start = Date.now();
		const limit = options.limit ?? DEFAULT_LIMIT;
		const bm25Weight = options.bm25Weight ?? DEFAULT_BM25_WEIGHT;

		await this.ensureInitialized();

		const table = await this.getTable();

		// Run vector and FTS search in parallel
		const queryVector = await this.embeddings!.embedSingle(query);
		const [vectorResults, ftsResults] = await Promise.all([
			vectorSearch(table, queryVector, limit * 2),
			ftsSearch(table, query, limit * 2),
		]);

		// Combine with RRF
		const vectorWeight = 1 - bm25Weight;
		const results = hybridRerank(
			vectorResults,
			ftsResults,
			limit,
			vectorWeight,
		);

		return {
			results,
			query,
			searchType: 'hybrid',
			elapsedMs: Date.now() - start,
		};
	}

	/**
	 * Perform vector-only search.
	 */
	async searchVector(
		query: string,
		limit: number = DEFAULT_LIMIT,
	): Promise<SearchResults> {
		const start = Date.now();

		await this.ensureInitialized();

		const table = await this.getTable();
		const queryVector = await this.embeddings!.embedSingle(query);
		const results = await vectorSearch(table, queryVector, limit);

		return {
			results,
			query,
			searchType: 'vector',
			elapsedMs: Date.now() - start,
		};
	}

	/**
	 * Perform FTS-only search.
	 */
	async searchFts(
		query: string,
		limit: number = DEFAULT_LIMIT,
	): Promise<SearchResults> {
		const start = Date.now();

		await this.ensureInitialized();

		const table = await this.getTable();
		const results = await ftsSearch(table, query, limit);

		return {
			results,
			query,
			searchType: 'fts',
			elapsedMs: Date.now() - start,
		};
	}

	/**
	 * Initialize the search engine.
	 */
	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;

		const config = await loadConfig(this.projectRoot);

		// Initialize storage
		this.storage = new Storage(this.projectRoot, config.embeddingDimensions);
		await this.storage.connect();

		// Initialize embeddings
		this.embeddings = new LocalEmbeddingProvider();
		await this.embeddings.initialize();

		this.initialized = true;
		this.log('info', 'SearchEngine initialized');
	}

	/**
	 * Get the code chunks table.
	 */
	private async getTable(): Promise<Table> {
		return this.storage!.getChunksTable();
	}

	/**
	 * Log a message.
	 */
	private log(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
	): void {
		if (!this.logger) return;
		this.logger[level]('Search', message);
	}

	/**
	 * Close the search engine and free resources.
	 */
	close(): void {
		this.storage?.close();
		this.embeddings?.close();
		this.initialized = false;
		this.log('info', 'SearchEngine closed');
	}
}
