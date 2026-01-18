/**
 * Search service for code search.
 *
 * Supports multiple search modes:
 * - semantic: Dense vector search for conceptual queries
 * - exact: BM25/FTS for symbol names and exact matches
 * - hybrid: Combined vector + BM25 with RRF (default)
 * - definition: Direct metadata lookup for symbol definitions
 * - similar: Vector search with code snippet as query
 */

import type {Table} from '@lancedb/lancedb';
import {loadConfig, type EmbeddingProviderType} from '../../lib/config.js';
import {GeminiEmbeddingProvider} from '../../providers/gemini.js';
import {LocalEmbeddingProvider} from '../../providers/local.js';
import {MistralEmbeddingProvider} from '../../providers/mistral.js';
import {OpenAIEmbeddingProvider} from '../../providers/openai.js';
import type {EmbeddingProvider} from '../../providers/types.js';
import type {Logger} from '../../lib/logger.js';
import {isAbortError, throwIfAborted} from '../../lib/abort.js';
import {Storage} from '../storage/index.js';
import {buildDefinitionFilter, buildFilterClause} from './filters.js';
import {ftsSearch} from './fts.js';
import {hybridRerank} from './hybrid.js';
import type {
	SearchDebugInfo,
	SearchMode,
	SearchOptions,
	SearchResults,
} from './types.js';
import {vectorSearch} from './vector.js';

/** Default search limit */
const DEFAULT_LIMIT = 10;

/** Default BM25 weight for hybrid search */
const DEFAULT_BM25_WEIGHT = 0.3;

/** Default oversample multiplier for hybrid search */
const DEFAULT_OVERSAMPLE_MULTIPLIER = 2;

/** Maximum oversample multiplier (for low vector confidence) */
const MAX_OVERSAMPLE_MULTIPLIER = 4;

/**
 * Options for SearchEngine constructor.
 */
export interface SearchEngineOptions {
	/** Logger for debug output */
	logger?: Logger;
	/** External Storage instance (if provided, SearchEngine won't create or close it) */
	storage?: Storage;
}

/**
 * Search engine for code search.
 * Supports vector, FTS, hybrid, definition, and similar search modes.
 */
export class SearchEngine {
	private readonly projectRoot: string;
	private storage: Storage | null = null;
	private embeddings: EmbeddingProvider | null = null;
	private logger: Logger | null = null;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private readonly externalStorage: boolean;

	constructor(projectRoot: string, options?: SearchEngineOptions | Logger) {
		this.projectRoot = projectRoot;

		// Handle both old (logger) and new (options) signatures for backward compatibility
		if (options && typeof options === 'object' && 'logger' in options) {
			this.logger = options.logger ?? null;
			if (options.storage) {
				this.storage = options.storage;
				this.externalStorage = true;
			} else {
				this.externalStorage = false;
			}
		} else {
			// Old signature: second param is Logger directly
			this.logger = (options as Logger | undefined) ?? null;
			this.externalStorage = false;
		}
	}

	/**
	 * Primary search method. Dispatches to appropriate search mode.
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResults> {
		const start = Date.now();
		const mode: SearchMode = options.mode ?? 'hybrid';
		const limit = options.limit ?? DEFAULT_LIMIT;
		const filterClause = buildFilterClause(options.filters);

		await this.ensureInitialized();
		const table = await this.getTable();

		let results: SearchResults;

		switch (mode) {
			case 'semantic':
				results = await this.searchSemantic(
					table,
					query,
					limit,
					filterClause,
					options.minScore,
				);
				break;

			case 'exact':
				results = await this.searchExact(
					table,
					query,
					limit,
					filterClause,
					options.minScore,
				);
				break;

			case 'definition':
				results = await this.searchDefinition(
					table,
					options.symbolName ?? query,
					limit,
					options.filters?.type,
					filterClause,
				);
				break;

			case 'similar':
				results = await this.searchSimilar(
					table,
					options.codeSnippet ?? query,
					limit,
					filterClause,
					options.minScore,
				);
				break;

			case 'hybrid':
			default:
				results = await this.searchHybrid(
					table,
					query,
					limit,
					options.bm25Weight ?? DEFAULT_BM25_WEIGHT,
					filterClause,
					options.minScore,
					options.autoBoost ?? true,
					options.autoBoostThreshold ?? 0.3,
					options.returnDebug ?? false,
				);
				break;
		}

		results.elapsedMs = Date.now() - start;
		return results;
	}

	/**
	 * Semantic search: Dense vector search only.
	 * Best for conceptual queries like "how does auth work?"
	 */
	private async searchSemantic(
		table: Table,
		query: string,
		limit: number,
		filterClause?: string,
		minScore?: number,
	): Promise<SearchResults> {
		const queryVector = await this.embeddings!.embedSingle(query);
		const results = await vectorSearch(table, queryVector, {
			limit,
			filterClause,
			minScore,
		});

		return {
			results,
			query,
			searchType: 'semantic',
			elapsedMs: 0,
		};
	}

	/**
	 * Exact search: BM25/FTS only.
	 * Best for symbol names and exact string matches.
	 */
	private async searchExact(
		table: Table,
		query: string,
		limit: number,
		filterClause?: string,
		minScore?: number,
	): Promise<SearchResults> {
		const results = await ftsSearch(table, query, {
			limit,
			filterClause,
			minScore,
		});

		return {
			results,
			query,
			searchType: 'exact',
			elapsedMs: 0,
		};
	}

	/**
	 * Hybrid search: Vector + BM25 with RRF reranking.
	 * Good general-purpose search.
	 *
	 * @param autoBoost - When true, increase BM25 weight and oversample if vector scores are low
	 * @param autoBoostThreshold - Vector score threshold below which auto-boost activates
	 * @param returnDebug - Include debug info in results for AI evaluation
	 */
	private async searchHybrid(
		table: Table,
		query: string,
		limit: number,
		bm25Weight: number,
		filterClause?: string,
		minScore?: number,
		autoBoost: boolean = true,
		autoBoostThreshold: number = 0.3,
		returnDebug: boolean = false,
	): Promise<SearchResults> {
		const queryVector = await this.embeddings!.embedSingle(query);

		// Initial search with default oversample to assess vector confidence
		const initialOversample = limit * DEFAULT_OVERSAMPLE_MULTIPLIER;
		const [initialVectorResults, initialFtsResults] = await Promise.all([
			vectorSearch(table, queryVector, {
				limit: initialOversample,
				filterClause,
			}),
			ftsSearch(table, query, {
				limit: initialOversample,
				filterClause,
			}),
		]);

		// Calculate confidence metrics
		const maxVectorScore = Math.max(
			...initialVectorResults.map(r => r.score),
			0,
		);
		const maxFtsScore = Math.max(
			...initialFtsResults.map(r => r.ftsScore ?? r.score),
			0,
		);

		// Dynamic oversample: increase when vector confidence is low
		let oversampleMultiplier = DEFAULT_OVERSAMPLE_MULTIPLIER;
		let dynamicOversampleApplied = false;

		if (autoBoost && maxVectorScore < autoBoostThreshold) {
			// Linear scale from 2x to 4x based on how low vector scores are
			// At threshold (0.3): 2x, at 0: 4x
			const boost = 1 - maxVectorScore / autoBoostThreshold;
			oversampleMultiplier =
				DEFAULT_OVERSAMPLE_MULTIPLIER +
				boost * (MAX_OVERSAMPLE_MULTIPLIER - DEFAULT_OVERSAMPLE_MULTIPLIER);
			dynamicOversampleApplied =
				oversampleMultiplier > DEFAULT_OVERSAMPLE_MULTIPLIER;
		}

		const effectiveOversample = Math.round(limit * oversampleMultiplier);

		// If we need more results due to dynamic oversample, fetch additional
		let vectorResults = initialVectorResults;
		let ftsResults = initialFtsResults;

		if (effectiveOversample > initialOversample) {
			// Re-fetch with higher limit
			[vectorResults, ftsResults] = await Promise.all([
				vectorSearch(table, queryVector, {
					limit: effectiveOversample,
					filterClause,
				}),
				ftsSearch(table, query, {
					limit: effectiveOversample,
					filterClause,
				}),
			]);
		}

		// Auto-boost: increase BM25 weight when vector confidence is low
		let effectiveBm25Weight = bm25Weight;
		let autoBoostApplied = false;

		if (autoBoost && maxVectorScore < autoBoostThreshold) {
			// Calculate boost factor: higher boost when vector scores are lower
			const boost = (autoBoostThreshold - maxVectorScore) / autoBoostThreshold;
			// Increase BM25 weight by up to 0.5, capped at 0.9
			effectiveBm25Weight = Math.min(0.9, bm25Weight + boost * 0.5);
			autoBoostApplied = effectiveBm25Weight !== bm25Weight;
		}

		// Combine with RRF using effective weight
		const vectorWeight = 1 - effectiveBm25Weight;
		let results = hybridRerank(vectorResults, ftsResults, limit, vectorWeight);

		// Apply minScore filter
		if (minScore) {
			results = results.filter(r => r.score >= minScore);
		}

		// Build debug info if requested
		const debug: SearchDebugInfo | undefined = returnDebug
			? {
					maxVectorScore,
					maxFtsScore,
					requestedBm25Weight: bm25Weight,
					effectiveBm25Weight,
					autoBoostApplied,
					autoBoostThreshold,
					vectorResultCount: vectorResults.length,
					ftsResultCount: ftsResults.length,
					oversampleMultiplier,
					dynamicOversampleApplied,
				}
			: undefined;

		return {
			results,
			query,
			searchType: 'hybrid',
			elapsedMs: 0,
			debug,
		};
	}

	/**
	 * Definition search: Direct metadata lookup.
	 * Best for "where is X defined?" queries.
	 */
	private async searchDefinition(
		table: Table,
		symbolName: string,
		limit: number,
		typeFilter?: ('function' | 'class' | 'method' | 'module')[],
		additionalFilter?: string,
	): Promise<SearchResults> {
		const definitionFilter = buildDefinitionFilter(symbolName, typeFilter);

		// Combine with additional filters
		const fullFilter = additionalFilter
			? `(${definitionFilter}) AND (${additionalFilter})`
			: definitionFilter;

		// Use table query directly for metadata lookup
		const queryResults = await table
			.query()
			.where(fullFilter)
			.limit(limit)
			.toArray();

		const results = queryResults.map((row, index) => {
			const chunk = row as {
				id: string;
				text: string;
				filepath: string;
				filename: string;
				name: string;
				type: string;
				start_line: number;
				end_line: number;
				signature?: string | null;
				is_exported?: boolean;
			};

			return {
				id: chunk.id,
				text: chunk.text,
				filepath: chunk.filepath,
				filename: chunk.filename,
				name: chunk.name,
				type: chunk.type,
				startLine: chunk.start_line,
				endLine: chunk.end_line,
				score: 1 / (index + 1), // Rank-based score
				signature: chunk.signature,
				isExported: chunk.is_exported,
			};
		});

		return {
			results,
			query: symbolName,
			searchType: 'definition',
			elapsedMs: 0,
		};
	}

	/**
	 * Similar search: Vector search with code snippet as query.
	 * Best for "find code like this" queries.
	 */
	private async searchSimilar(
		table: Table,
		codeSnippet: string,
		limit: number,
		filterClause?: string,
		minScore?: number,
	): Promise<SearchResults> {
		// Embed the code snippet directly
		const queryVector = await this.embeddings!.embedSingle(codeSnippet);
		const results = await vectorSearch(table, queryVector, {
			limit,
			filterClause,
			minScore,
		});

		return {
			results,
			query:
				codeSnippet.substring(0, 100) + (codeSnippet.length > 100 ? '...' : ''),
			searchType: 'similar',
			elapsedMs: 0,
		};
	}

	/**
	 * Perform vector-only search. (Legacy method)
	 */
	async searchVector(
		query: string,
		limit: number = DEFAULT_LIMIT,
	): Promise<SearchResults> {
		return this.search(query, {mode: 'semantic', limit});
	}

	/**
	 * Perform FTS-only search. (Legacy method)
	 */
	async searchFts(
		query: string,
		limit: number = DEFAULT_LIMIT,
	): Promise<SearchResults> {
		return this.search(query, {mode: 'exact', limit});
	}

	/**
	 * Pre-initialize the search engine.
	 * Call this to eagerly load embedding models before search calls.
	 * For local models, this may take 30+ seconds on first run.
	 */
	async warmup(signal?: AbortSignal): Promise<void> {
		await this.ensureInitialized(signal);
	}

	/**
	 * Initialize the search engine.
	 * Uses idempotent promise pattern to prevent race conditions.
	 */
	private async ensureInitialized(signal?: AbortSignal): Promise<void> {
		// Fast path: already initialized
		if (this.initialized) return;

		// Idempotent: return existing promise if initialization in progress
		if (this.initPromise) return this.initPromise;

		// Start initialization and store promise
		this.initPromise = this.doInitialize(signal);
		return this.initPromise;
	}

	/**
	 * Perform actual initialization.
	 */
	private async doInitialize(signal?: AbortSignal): Promise<void> {
		try {
			throwIfAborted(signal, 'Warmup cancelled');
			const config = await loadConfig(this.projectRoot);
			throwIfAborted(signal, 'Warmup cancelled');

			// Initialize storage (skip if provided externally)
			if (!this.storage) {
				this.storage = new Storage(
					this.projectRoot,
					config.embeddingDimensions,
				);
				await this.storage.connect();
			}
			throwIfAborted(signal, 'Warmup cancelled');

			// Initialize embeddings with config (includes apiKey for cloud providers)
			this.embeddings = this.createEmbeddingProvider(config);
			await this.embeddings.initialize();
			throwIfAborted(signal, 'Warmup cancelled');

			this.initialized = true;
			this.log('info', 'SearchEngine initialized');
		} catch (error) {
			if (isAbortError(error)) {
				if (!this.externalStorage) {
					this.storage?.close();
				}
				this.storage = null;
				this.embeddings?.close();
				this.embeddings = null;
				this.initialized = false;
			}
			// Reset promise on failure to allow retry
			this.initPromise = null;
			throw error;
		}
	}

	/**
	 * Create the appropriate embedding provider based on config.
	 */
	private createEmbeddingProvider(config: {
		embeddingProvider: EmbeddingProviderType;
		apiKey?: string;
		openaiBaseUrl?: string;
	}): EmbeddingProvider {
		const apiKey = config.apiKey;
		switch (config.embeddingProvider) {
			case 'local':
				return new LocalEmbeddingProvider();
			case 'gemini':
				return new GeminiEmbeddingProvider(apiKey);
			case 'mistral':
				return new MistralEmbeddingProvider(apiKey);
			case 'openai':
				return new OpenAIEmbeddingProvider(apiKey, config.openaiBaseUrl);
			default:
				throw new Error(
					`Unknown embedding provider: ${config.embeddingProvider}`,
				);
		}
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
		// Only close storage if we created it (not external)
		if (!this.externalStorage) {
			this.storage?.close();
		}
		this.embeddings?.close();
		this.initialized = false;
		this.log('info', 'SearchEngine closed');
	}
}
