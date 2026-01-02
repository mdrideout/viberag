/**
 * MCP Server for VibeRAG
 *
 * Exposes RAG functionality via Model Context Protocol.
 * Tools: codebase_search, codebase_parallel_search, viberag_index, viberag_status, viberag_watch_status
 *
 * Includes file watcher for automatic incremental indexing.
 */

import {createRequire} from 'node:module';
import {FastMCP} from 'fastmcp';
import {z} from 'zod';
import {
	Indexer,
	configExists,
	loadManifest,
	manifestExists,
	loadConfig,
	saveConfig,
	PROVIDER_CONFIGS,
	getSchemaVersionInfo,
	type SearchResults,
	type IndexStats,
	type SearchFilters,
} from '../rag/index.js';
import {FileWatcher} from './watcher.js';
import {WarmupManager} from './warmup.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as {
	version: `${number}.${number}.${number}`;
};

/**
 * Error thrown when project is not initialized.
 */
class NotInitializedError extends Error {
	constructor(projectRoot: string) {
		super(
			`VibeRAG not initialized in ${projectRoot}. ` +
				`Run 'npx viberag' and use /init command first.`,
		);
		this.name = 'NotInitializedError';
	}
}

/**
 * Verify project is initialized, throw if not.
 */
async function ensureInitialized(projectRoot: string): Promise<void> {
	const exists = await configExists(projectRoot);
	if (!exists) {
		throw new NotInitializedError(projectRoot);
	}
}

/**
 * Default maximum response size in bytes (100KB).
 * Reduces result count to fit; does NOT truncate text.
 */
const DEFAULT_MAX_RESPONSE_SIZE = 100 * 1024;

/**
 * Maximum allowed response size (500KB).
 */
const MAX_RESPONSE_SIZE = 500 * 1024;

/**
 * Overhead per result in JSON (metadata fields, formatting).
 */
const RESULT_OVERHEAD_BYTES = 200;

/**
 * Estimate JSON response size for a set of results.
 */
function estimateResponseSize(results: SearchResults['results']): number {
	const textSize = results.reduce((sum, r) => sum + r.text.length, 0);
	const overhead = results.length * RESULT_OVERHEAD_BYTES + 500; // Base JSON overhead
	return textSize + overhead;
}

/**
 * Cap results to fit within max response size.
 * Removes results from the end (lowest relevance) until size fits.
 */
function capResultsToSize(
	results: SearchResults['results'],
	maxSize: number,
): SearchResults['results'] {
	if (results.length === 0) return results;

	// Quick check: if current size is within limit, return as-is
	const currentSize = estimateResponseSize(results);
	if (currentSize <= maxSize) return results;

	// Binary search for optimal result count
	let low = 1;
	let high = results.length;
	let bestCount = 1;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const subset = results.slice(0, mid);
		const size = estimateResponseSize(subset);

		if (size <= maxSize) {
			bestCount = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return results.slice(0, bestCount);
}

/**
 * Format search results for MCP response.
 *
 * @param maxResponseSize - Maximum response size in bytes. Reduces result count to fit.
 */
function formatSearchResults(
	results: SearchResults,
	includeDebug: boolean = false,
	maxResponseSize: number = DEFAULT_MAX_RESPONSE_SIZE,
): string {
	if (results.results.length === 0) {
		const response: Record<string, unknown> = {
			message: `No results found for "${results.query}"`,
			mode: results.searchType,
			elapsedMs: results.elapsedMs,
			results: [],
		};

		// Include debug info even for empty results (helps diagnose issues)
		if (includeDebug && results.debug) {
			response['debug'] = formatDebugInfo(results.debug);
		}

		return JSON.stringify(response);
	}

	// Cap results to fit within max response size
	const cappedResults = capResultsToSize(results.results, maxResponseSize);
	const wasReduced = cappedResults.length < results.results.length;

	const response: Record<string, unknown> = {
		query: results.query,
		mode: results.searchType,
		elapsedMs: results.elapsedMs,
		resultCount: cappedResults.length,
		results: cappedResults.map(r => ({
			type: r.type,
			name: r.name || '(anonymous)',
			filepath: r.filepath,
			startLine: r.startLine,
			endLine: r.endLine,
			score: Number(r.score.toFixed(4)),
			vectorScore: r.vectorScore ? Number(r.vectorScore.toFixed(4)) : undefined,
			ftsScore: r.ftsScore ? Number(r.ftsScore.toFixed(4)) : undefined,
			signature: r.signature ?? undefined,
			isExported: r.isExported ?? undefined,
			text: r.text,
		})),
	};

	// Add indicator if results were reduced due to size
	if (wasReduced) {
		response['originalResultCount'] = results.results.length;
		response['reducedForSize'] = true;
	}

	// Add totalMatches for exhaustive mode
	if (results.totalMatches !== undefined) {
		response['totalMatches'] = results.totalMatches;
	}

	// Add debug info for AI evaluation
	if (includeDebug && results.debug) {
		response['debug'] = formatDebugInfo(results.debug);
	}

	return JSON.stringify(response);
}

/**
 * Format debug info with quality assessment and suggestions.
 */
function formatDebugInfo(
	debug: NonNullable<SearchResults['debug']>,
): Record<string, unknown> {
	const searchQuality =
		debug.maxVectorScore > 0.5
			? 'high'
			: debug.maxVectorScore > 0.3
				? 'medium'
				: 'low';

	const result: Record<string, unknown> = {
		maxVectorScore: Number(debug.maxVectorScore.toFixed(4)),
		maxFtsScore: Number(debug.maxFtsScore.toFixed(4)),
		requestedBm25Weight: Number(debug.requestedBm25Weight.toFixed(2)),
		effectiveBm25Weight: Number(debug.effectiveBm25Weight.toFixed(2)),
		autoBoostApplied: debug.autoBoostApplied,
		vectorResultCount: debug.vectorResultCount,
		ftsResultCount: debug.ftsResultCount,
		searchQuality,
	};

	// Add oversample info if present
	if (debug.oversampleMultiplier !== undefined) {
		result['oversampleMultiplier'] = Number(
			debug.oversampleMultiplier.toFixed(2),
		);
	}
	if (debug.dynamicOversampleApplied !== undefined) {
		result['dynamicOversampleApplied'] = debug.dynamicOversampleApplied;
	}

	// Add suggestion if search quality is low but FTS found results
	if (debug.maxVectorScore < 0.3 && debug.maxFtsScore > 1) {
		result['suggestion'] =
			'Consider exact mode or higher bm25_weight for this query';
	}

	return result;
}

/**
 * Format index stats for MCP response.
 */
function formatIndexStats(stats: IndexStats): string {
	return JSON.stringify({
		message: 'Index complete',
		filesScanned: stats.filesScanned,
		filesNew: stats.filesNew,
		filesModified: stats.filesModified,
		filesDeleted: stats.filesDeleted,
		chunksAdded: stats.chunksAdded,
		chunksDeleted: stats.chunksDeleted,
		embeddingsComputed: stats.embeddingsComputed,
		embeddingsCached: stats.embeddingsCached,
	});
}

/**
 * MCP server with file watcher and warmup manager.
 */
export interface McpServerWithWatcher {
	server: FastMCP;
	watcher: FileWatcher;
	warmupManager: WarmupManager;
	/** Start the watcher (call after server.start) */
	startWatcher: () => Promise<void>;
	/** Stop the watcher (call before exit) */
	stopWatcher: () => Promise<void>;
	/** Start warmup (call after server.start) */
	startWarmup: () => void;
}

/**
 * Create and configure the MCP server with file watcher and warmup manager.
 */
export function createMcpServer(projectRoot: string): McpServerWithWatcher {
	const server = new FastMCP({
		name: 'viberag',
		version: pkg.version,
	});

	// Create file watcher
	const watcher = new FileWatcher(projectRoot);

	// Create warmup manager for shared SearchEngine
	const warmupManager = new WarmupManager(projectRoot);

	// Filters schema for transparent, AI-controlled filtering
	const filtersSchema = z
		.object({
			path_prefix: z
				.string()
				.optional()
				.describe('Scope to directory (e.g., "src/api/")'),
			path_contains: z
				.array(z.string())
				.optional()
				.describe(
					'Path must contain ALL strings - AND logic (e.g., ["services", "user"])',
				),
			path_not_contains: z
				.array(z.string())
				.optional()
				.describe(
					'Exclude if path contains ANY string - OR logic (e.g., ["test", "__tests__", "_test.", ".spec."])',
				),
			type: z
				.array(z.enum(['function', 'class', 'method', 'module']))
				.optional()
				.describe('Match ANY type - OR logic (e.g., ["function", "method"])'),
			extension: z
				.array(z.string())
				.optional()
				.describe('Match ANY extension - OR logic (e.g., [".ts", ".py"])'),
			is_exported: z
				.boolean()
				.optional()
				.describe(
					'Only public/exported symbols (Go: Capitalized, Python: no _ prefix, JS/TS: export)',
				),
			decorator_contains: z
				.string()
				.optional()
				.describe(
					'Has decorator/attribute containing string (Python: @route, Java: @GetMapping, Rust: #[test])',
				),
			has_docstring: z
				.boolean()
				.optional()
				.describe('Only code with doc comments'),
		})
		.optional();

	// Tool: codebase_search
	server.addTool({
		name: 'codebase_search',
		description: `
Codebase search: semantic search, keyword search, and hybrid search options. 
Use this when you need to find code that matches semantic meaning and keyword patterns. 
This tool helps you perform exhaustive searches of the codebase and get the best 
context and understanding when exploring and searching the codebase, docs, etc.

USE FOR CODEBASE EXPLORATION:
- Finds related code that grep/glob/read would miss. 
- Semantic codebase search will find more relevant files.

EXAMPLES:
- "How does X work?"
- "Where is Y handled?"
- "Find patterns for Z"
- "Help me understand X"
- "How are we handling [exception type]"
- "Find every instance of Y"

WHEN TO USE codebase_search:
- You're exploring or investigating
- You need comprehensive results (not just the first match)
- The question is conceptual ("how does X work" vs "where is function Y")
- You want to find related code you might not have thought to search for
- Find semantically similar code when you don't know the exact function or variable names

REAL EXAMPLE: Asked "how are API keys configured?"
- grep finds: 3 files with "API_KEY" pattern
- viberag finds: 36 results including provider implementations, ADR docs explaining
  design decisions, init wizard UI, error messages, and config interfaces

DELEGATE TO A BACKGROUND AGENT
- Tell sub-agents / background agents to run viberag codebase_search mcp tool
- Tell task/explore to use viberag codebase_search and then synthesize findings and results and return a summary
- Context management: This reduces token usage in the main conversation context
- For simple lookups ("where is function X?"), direct viberag calls are fine.

MODE SELECTION:
- 'hybrid' (default): Combined semantic + keyword. Start here for most queries.
- 'semantic': Pure meaning-based search. Best for conceptual queries.
- 'exact': Pure keyword/BM25. Best for symbol names, specific strings.
- 'definition': Direct symbol lookup. Fastest for "where is X defined?"
- 'similar': Find code similar to a snippet. Pass code_snippet parameter.

WEIGHT TUNING (hybrid mode):
The bm25_weight parameter (0-1) balances keyword vs semantic matching:
- 0.2-0.3: Favor semantic (conceptual queries like "how does X work")
- 0.5: Balanced (documentation, prose, mixed content)
- 0.7-0.9: Favor keywords (symbol names, exact strings, specific terms)

AUTO-BOOST:
By default, auto_boost=true increases keyword weight when semantic scores are low.
This helps find content that doesn't match code embeddings (docs, comments, prose).
Set auto_boost=false for precise control or comparative searches.

ITERATIVE STRATEGY:
For thorough searches, consider:
1. Start with hybrid mode, default weights
2. Check debug info to evaluate search quality
3. If maxVectorScore < 0.3, try exact mode or higher bm25_weight
4. If results seem incomplete, try codebase_parallel_search for comparison
5. Use exhaustive=true for refactoring tasks needing ALL matches

RESULT INTERPRETATION:
- score: Combined relevance (higher = better)
- vectorScore: Semantic similarity (0-1, may be missing for exact mode)
- ftsScore: Keyword match strength (BM25 score)
- debug.searchQuality: 'high', 'medium', or 'low' based on vector scores
- debug.suggestion: Hints when different settings might work better

FILTERS (transparent, you control what's excluded):
Path filters:
- recommendation: use sparingly - only exclude what you absolutely do not want included.
- path_prefix: Scope to directory (e.g., "src/api/")
- path_contains: Path must contain ALL strings (AND logic)
- path_not_contains: Exclude if path contains ANY string (OR logic)

Code filters:
- type: Match ANY of ["function", "class", "method", "module"]
- extension: Match ANY extension (e.g., [".ts", ".py"])

Metadata filters:
- is_exported: Only public/exported symbols
- has_docstring: Only code with documentation comments
- decorator_contains: Has decorator/attribute matching string

COMMON PATTERNS:
Exclude tests: { path_not_contains: ["test", "__tests__", ".spec.", "mock"] }
Find API endpoints: { decorator_contains: "Get", is_exported: true }
Production code: { path_not_contains: ["test", "mock", "fixture"], is_exported: true }`,
		parameters: z.object({
			query: z.string().describe('The search query in natural language'),
			mode: z
				.enum(['semantic', 'exact', 'hybrid', 'definition', 'similar'])
				.optional()
				.default('hybrid')
				.describe('Search mode (default: hybrid)'),
			code_snippet: z
				.string()
				.optional()
				.describe("For mode='similar': code to find similar matches for"),
			symbol_name: z
				.string()
				.optional()
				.describe("For mode='definition': exact symbol name to look up"),
			limit: z
				.number()
				.min(1)
				.max(100)
				.optional()
				.default(10)
				.describe('Maximum number of results (1-100, default: 10)'),
			exhaustive: z
				.boolean()
				.optional()
				.default(false)
				.describe('Return all matches (for refactoring/auditing)'),
			min_score: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe('Minimum relevance score threshold (0-1)'),
			filters: filtersSchema.describe('Transparent filters (see description)'),
			bm25_weight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe(
					'Balance between keyword (BM25) and semantic search in hybrid mode. ' +
						'Higher values favor exact keyword matches, lower values favor semantic similarity. ' +
						'Guidelines: 0.7-0.9 for symbol names/exact strings, 0.5 for documentation/prose, ' +
						'0.2-0.3 for conceptual queries (default: 0.3). Ignored for non-hybrid modes.',
				),
			auto_boost: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					'When true (default), automatically boosts BM25 weight if semantic scores are low. ' +
						'Set to false for precise control over weights or when running comparative searches.',
				),
			auto_boost_threshold: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.default(0.3)
				.describe(
					'Vector score threshold below which auto-boost activates (default: 0.3). ' +
						'Lower values make auto-boost more aggressive. Only applies when auto_boost=true.',
				),
			return_debug: z
				.boolean()
				.optional()
				.describe(
					'Include search diagnostics: max_vector_score, max_fts_score, effective_bm25_weight. ' +
						'Defaults to true for hybrid mode, false for other modes. ' +
						'Useful for evaluating search quality and tuning parameters.',
				),
			max_response_size: z
				.number()
				.min(1024)
				.max(MAX_RESPONSE_SIZE)
				.optional()
				.default(DEFAULT_MAX_RESPONSE_SIZE)
				.describe(
					'Maximum response size in bytes (default: 100KB, max: 500KB). ' +
						'Reduces result count to fit within limit; does NOT truncate text content. ' +
						'Use a larger value for exhaustive searches.',
				),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);

			// Convert snake_case filter keys to camelCase
			const filters: SearchFilters | undefined = args.filters
				? {
						pathPrefix: args.filters.path_prefix,
						pathContains: args.filters.path_contains,
						pathNotContains: args.filters.path_not_contains,
						type: args.filters.type,
						extension: args.filters.extension,
						isExported: args.filters.is_exported,
						decoratorContains: args.filters.decorator_contains,
						hasDocstring: args.filters.has_docstring,
					}
				: undefined;

			// Get shared search engine from warmup manager (waits for warmup if needed)
			const engine = await warmupManager.getSearchEngine();

			// Determine if debug info should be returned
			const returnDebug =
				args.return_debug ??
				(args.mode === 'hybrid' || args.mode === undefined);

			const results = await engine.search(args.query, {
				mode: args.mode,
				limit: args.limit,
				exhaustive: args.exhaustive,
				minScore: args.min_score,
				filters,
				codeSnippet: args.code_snippet,
				symbolName: args.symbol_name,
				bm25Weight: args.bm25_weight,
				autoBoost: args.auto_boost,
				autoBoostThreshold: args.auto_boost_threshold,
				returnDebug,
			});

			// Don't close engine - it's shared across calls
			return formatSearchResults(results, returnDebug, args.max_response_size);
		},
	});

	// Tool: viberag_index
	server.addTool({
		name: 'viberag_index',
		description:
			'Index the codebase for semantic search. Uses incremental indexing by default ' +
			'(only processes changed files based on Merkle tree diff). ' +
			'Use force=true for full reindex after config changes. ' +
			'NOTE: Indexing can take time for large codebases. Consider running in a background ' +
			'agent or delegating to a sub-agent if your platform supports it.',
		parameters: z.object({
			force: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'Force full reindex, ignoring change detection (default: false)',
				),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);

			// When forcing reindex, sync config dimensions with current provider settings
			// This handles cases where PROVIDER_CONFIGS dimensions changed (e.g., Gemini 768→1536)
			if (args.force) {
				const config = await loadConfig(projectRoot);
				const currentDimensions =
					PROVIDER_CONFIGS[config.embeddingProvider]?.dimensions;

				if (
					currentDimensions &&
					config.embeddingDimensions !== currentDimensions
				) {
					const updatedConfig = {
						...config,
						embeddingDimensions: currentDimensions,
						embeddingModel: PROVIDER_CONFIGS[config.embeddingProvider].model,
					};
					await saveConfig(projectRoot, updatedConfig);
				}
			}

			const indexer = new Indexer(projectRoot);
			try {
				const stats = await indexer.index({force: args.force});
				return formatIndexStats(stats);
			} finally {
				indexer.close();
			}
		},
	});

	// Tool: viberag_status
	server.addTool({
		name: 'viberag_status',
		description:
			'Get index status including file count, chunk count, embedding provider, schema version, and last update time. ' +
			'If schema version is outdated, run viberag_index with force=true to reindex. ' +
			'TIP: Check status before delegating exploration to sub-agents to ensure the index is current.',
		parameters: z.object({}),
		execute: async () => {
			await ensureInitialized(projectRoot);

			if (!(await manifestExists(projectRoot))) {
				return JSON.stringify({
					status: 'not_indexed',
					message: 'No index found. Run viberag_index to create one.',
				});
			}

			const manifest = await loadManifest(projectRoot);
			const config = await loadConfig(projectRoot);
			const schemaInfo = getSchemaVersionInfo(manifest);

			const response: Record<string, unknown> = {
				status: 'indexed',
				version: manifest.version,
				schemaVersion: schemaInfo.current,
				createdAt: manifest.createdAt,
				updatedAt: manifest.updatedAt,
				totalFiles: manifest.stats.totalFiles,
				totalChunks: manifest.stats.totalChunks,
				embeddingProvider: config.embeddingProvider,
				embeddingModel: config.embeddingModel,
				embeddingDimensions: config.embeddingDimensions,
			};

			// Warn if schema version is outdated
			if (schemaInfo.needsReindex) {
				response['warning'] =
					`Schema version ${schemaInfo.current} is outdated (current: ${schemaInfo.required}). ` +
					`Run viberag_index with force=true to reindex and enable new features.`;
			}

			// Add warmup state
			const warmupState = warmupManager.getState();
			response['warmup'] = {
				status: warmupState.status,
				provider: warmupState.provider,
				startedAt: warmupState.startedAt,
				readyAt: warmupState.readyAt,
				elapsedMs: warmupState.elapsedMs,
				error: warmupState.error,
			};

			return JSON.stringify(response);
		},
	});

	// Tool: viberag_watch_status
	server.addTool({
		name: 'viberag_watch_status',
		description:
			'Get file watcher status. Shows if auto-indexing is active, ' +
			'how many files are being watched, pending changes, and last update time.',
		parameters: z.object({}),
		execute: async () => {
			const status = watcher.getStatus();
			return JSON.stringify(status);
		},
	});

	// Tool: codebase_parallel_search
	server.addTool({
		name: 'codebase_parallel_search',
		description: `
Codebase Parallel Search: run multiple semantic search, keyword search, and hybrid searches in parallel and compare results. 
Use this when you need to run multiple searches at once to find code that matches semantic meaning and keyword patterns. 
This tool helps you perform exhaustive searches of the codebase and get the best 
context and understanding when exploring and searching the codebase, docs, etc.

NOTE: This is for narrower sets of queries. Parallel searches may return a large number of results,
it is best to keep search filters narrow and specific. For separate broader searches, use codebase_search one at a time.

USE FOR CODEBASE EXPLORATION:
- Finds related code that grep/glob/read would miss. 
- Semantic codebase search will find more relevant files.

EXAMPLE: "How are embeddings configured?"
- codebase_search: Found 8 results (embedding provider files)
- codebase_parallel_search with 3 strategies: Found 24 unique results including:
  * Provider implementations (what single search found)
  * ADR docs explaining why certain providers were chosen
  * Init wizard showing user-facing configuration
  * Type definitions and interfaces
  * Error handling and validation

WHEN TO USE:
- Need to test several search strategies at once
- Exploring a feature or system (not just looking up one thing)
- You want comprehensive coverage without multiple round-trips
- The topic has multiple related concepts (auth → session, JWT, tokens, login)
- You're not sure which search mode will work best

MODE SELECTION:
- 'hybrid' (default): Combined semantic + keyword. Start here for most queries.
- 'semantic': Pure meaning-based search. Best for conceptual queries.
- 'exact': Pure keyword/BM25. Best for symbol names, specific strings.
- 'definition': Direct symbol lookup. Fastest for "where is X defined?"
- 'similar': Find code similar to a snippet. Pass code_snippet parameter.

WEIGHT TUNING (hybrid mode):
The bm25_weight parameter (0-1) balances keyword vs semantic matching:
- 0.2-0.3: Favor semantic (conceptual queries like "how does X work")
- 0.5: Balanced (documentation, prose, mixed content)
- 0.7-0.9: Favor keywords (symbol names, exact strings, specific terms)

AUTO-BOOST:
By default, auto_boost=true increases keyword weight when semantic scores are low.
This helps find content that doesn't match code embeddings (docs, comments, prose).
Set auto_boost=false for precise control or comparative searches.

PARALLEL SEARCH STRATEGIES:
1. Mode comparison: [{mode:'semantic'}, {mode:'exact'}, {mode:'hybrid'}]
2. Related concepts: [{query:'auth'}, {query:'session'}, {query:'login'}]
3. Weight tuning: [{bm25_weight:0.2}, {bm25_weight:0.5}, {bm25_weight:0.8}]

USE CASES:
- Compare semantic vs keyword results for the same query
- Run same query with different weights to find optimal settings
- Search multiple related queries and aggregate results
- Implement multi-phase search strategies

RESULT INTERPRETATION:
- score: Combined relevance (higher = better)
- vectorScore: Semantic similarity (0-1, may be missing for exact mode)
- ftsScore: Keyword match strength (BM25 score)
- debug.searchQuality: 'high', 'medium', or 'low' based on vector scores
- debug.suggestion: Hints when different settings might work better

FILTERS (transparent, you control what's excluded):
Path filters:
- recommendation: use sparingly - only exclude what you absolutely do not want included.
- path_prefix: Scope to directory (e.g., "src/api/")
- path_contains: Path must contain ALL strings (AND logic)
- path_not_contains: Exclude if path contains ANY string (OR logic)

Code filters:
- type: Match ANY of ["function", "class", "method", "module"]
- extension: Match ANY extension (e.g., [".ts", ".py"])

Metadata filters:
- is_exported: Only public/exported symbols
- has_docstring: Only code with documentation comments
- decorator_contains: Has decorator/attribute matching string
`,
		parameters: z.object({
			searches: z
				.array(
					z.object({
						query: z.string().describe('Search query'),
						mode: z
							.enum(['semantic', 'exact', 'hybrid', 'definition', 'similar'])
							.optional()
							.describe('Search mode'),
						bm25_weight: z
							.number()
							.min(0)
							.max(1)
							.optional()
							.describe('BM25 weight for hybrid mode'),
						auto_boost: z.boolean().optional().describe('Enable auto-boost'),
						limit: z
							.number()
							.min(1)
							.max(50)
							.optional()
							.default(10)
							.describe('Max results per search'),
						filters: filtersSchema,
					}),
				)
				.min(1)
				.max(5)
				.describe('Array of search configurations (1-5)'),
			merge_results: z
				.boolean()
				.optional()
				.default(true)
				.describe('Combine and dedupe results across all searches'),
			merge_strategy: z
				.enum(['rrf', 'dedupe'])
				.optional()
				.default('rrf')
				.describe(
					'How to merge: "rrf" - Reciprocal Rank Fusion (results in multiple searches rank higher), ' +
						'"dedupe" - Simple deduplication (keep highest score)',
				),
			merged_limit: z
				.number()
				.min(1)
				.max(100)
				.optional()
				.default(20)
				.describe('Max results in merged output'),
			max_response_size: z
				.number()
				.min(1024)
				.max(MAX_RESPONSE_SIZE)
				.optional()
				.default(DEFAULT_MAX_RESPONSE_SIZE)
				.describe(
					'Maximum response size in bytes (default: 100KB). ' +
						'Reduces merged result count to fit; does NOT truncate text.',
				),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);

			// Get shared search engine from warmup manager (waits for warmup if needed)
			const engine = await warmupManager.getSearchEngine();

			// Run all searches in parallel
			const searchPromises = args.searches.map(async (config, index) => {
				const filters: SearchFilters | undefined = config.filters
					? {
							pathPrefix: config.filters.path_prefix,
							pathContains: config.filters.path_contains,
							pathNotContains: config.filters.path_not_contains,
							type: config.filters.type,
							extension: config.filters.extension,
							isExported: config.filters.is_exported,
							decoratorContains: config.filters.decorator_contains,
							hasDocstring: config.filters.has_docstring,
						}
					: undefined;

				const results = await engine.search(config.query, {
					mode: config.mode,
					limit: config.limit,
					filters,
					bm25Weight: config.bm25_weight,
					autoBoost: config.auto_boost,
					returnDebug: true,
				});

				return {
					index,
					config: {
						query: config.query,
						mode: config.mode ?? 'hybrid',
						bm25Weight: config.bm25_weight,
					},
					results,
				};
			});

			const searchResults = await Promise.all(searchPromises);

			// Build individual results
			const individual = searchResults.map(sr => ({
				searchIndex: sr.index,
				config: sr.config,
				resultCount: sr.results.results.length,
				results: sr.results.results.map(r => ({
					id: r.id,
					type: r.type,
					name: r.name || '(anonymous)',
					filepath: r.filepath,
					startLine: r.startLine,
					endLine: r.endLine,
					score: Number(r.score.toFixed(4)),
				})),
				debug: sr.results.debug,
			}));

			// Build merged results if requested
			let merged: Record<string, unknown> | undefined;

			if (args.merge_results) {
				// Collect all results with their sources
				const allResults: Array<{
					result: (typeof searchResults)[0]['results']['results'][0];
					sources: number[];
					ranks: number[];
				}> = [];

				// Group results by ID
				const resultMap = new Map<
					string,
					{
						result: (typeof searchResults)[0]['results']['results'][0];
						sources: number[];
						ranks: number[];
					}
				>();

				for (const sr of searchResults) {
					sr.results.results.forEach((result, rank) => {
						const existing = resultMap.get(result.id);
						if (existing) {
							existing.sources.push(sr.index);
							existing.ranks.push(rank);
							// Keep highest score
							if (result.score > existing.result.score) {
								existing.result = result;
							}
						} else {
							resultMap.set(result.id, {
								result,
								sources: [sr.index],
								ranks: [rank],
							});
						}
					});
				}

				// Convert to array for sorting
				for (const [, value] of resultMap) {
					allResults.push(value);
				}

				// Sort by merge strategy
				if (args.merge_strategy === 'rrf') {
					// RRF: Sum of 1/(rank+k) across all sources
					const k = 60; // RRF constant
					allResults.sort((a, b) => {
						const rrfA = a.ranks.reduce((sum, r) => sum + 1 / (r + k), 0);
						const rrfB = b.ranks.reduce((sum, r) => sum + 1 / (r + k), 0);
						return rrfB - rrfA; // Higher RRF score first
					});
				} else {
					// Dedupe: Sort by score, then by number of sources
					allResults.sort((a, b) => {
						if (b.sources.length !== a.sources.length) {
							return b.sources.length - a.sources.length;
						}
						return b.result.score - a.result.score;
					});
				}

				// Take top merged_limit results
				let mergedResults = allResults
					.slice(0, args.merged_limit)
					.map(item => ({
						id: item.result.id,
						type: item.result.type,
						name: item.result.name || '(anonymous)',
						filepath: item.result.filepath,
						startLine: item.result.startLine,
						endLine: item.result.endLine,
						score: Number(item.result.score.toFixed(4)),
						sources: item.sources,
						text: item.result.text,
					}));

				// Apply size capping to merged results
				const cappedMerged = capResultsToSize(
					mergedResults.map(r => ({
						...r,
						id: r.id,
						filename: '',
						vectorScore: undefined,
						ftsScore: undefined,
						signature: undefined,
						isExported: undefined,
					})),
					args.max_response_size,
				);

				// Reduce to capped length if needed
				if (cappedMerged.length < mergedResults.length) {
					mergedResults = mergedResults.slice(0, cappedMerged.length);
				}

				// Calculate overlap statistics
				const uniqueToSearch = args.searches.map(
					(_, i) =>
						allResults.filter(r => r.sources.length === 1 && r.sources[0] === i)
							.length,
				);
				const overlapping = allResults.filter(r => r.sources.length > 1).length;

				merged = {
					strategy: args.merge_strategy,
					totalUnique: allResults.length,
					resultCount: mergedResults.length,
					overlap: overlapping,
					uniquePerSearch: uniqueToSearch,
					results: mergedResults,
				};
			}

			// Don't close engine - it's shared across calls
			return JSON.stringify({
				searchCount: args.searches.length,
				individual,
				merged,
			});
		},
	});

	return {
		server,
		watcher,
		warmupManager,
		startWatcher: async () => {
			// Only start watcher if project is initialized
			if (await configExists(projectRoot)) {
				await watcher.start();
			}
		},
		stopWatcher: async () => {
			await watcher.stop();
			warmupManager.close();
		},
		startWarmup: () => {
			warmupManager.startWarmup({
				onProgress: state => {
					if (state.status === 'ready') {
						console.error(
							`[viberag-mcp] Warmup complete (${state.elapsedMs}ms)`,
						);
					}
				},
			});
		},
	};
}
