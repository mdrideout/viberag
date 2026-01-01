/**
 * MCP Server for VibeRAG
 *
 * Exposes RAG functionality via Model Context Protocol.
 * Tools: viberag_search, viberag_index, viberag_status, viberag_watch_status
 *
 * Includes file watcher for automatic incremental indexing.
 */

import {createRequire} from 'node:module';
import {FastMCP} from 'fastmcp';
import {z} from 'zod';
import {
	SearchEngine,
	Indexer,
	configExists,
	loadManifest,
	manifestExists,
	loadConfig,
	getSchemaVersionInfo,
	type SearchResults,
	type IndexStats,
	type SearchFilters,
} from '../rag/index.js';
import {FileWatcher} from './watcher.js';

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
 * Format search results for MCP response.
 */
function formatSearchResults(
	results: SearchResults,
	includeDebug: boolean = false,
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

	const response: Record<string, unknown> = {
		query: results.query,
		mode: results.searchType,
		elapsedMs: results.elapsedMs,
		resultCount: results.results.length,
		results: results.results.map(r => ({
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
 * MCP server with file watcher.
 */
export interface McpServerWithWatcher {
	server: FastMCP;
	watcher: FileWatcher;
	/** Start the watcher (call after server.start) */
	startWatcher: () => Promise<void>;
	/** Stop the watcher (call before exit) */
	stopWatcher: () => Promise<void>;
}

/**
 * Create and configure the MCP server with file watcher.
 */
export function createMcpServer(projectRoot: string): McpServerWithWatcher {
	const server = new FastMCP({
		name: 'viberag',
		version: pkg.version,
	});

	// Create file watcher
	const watcher = new FileWatcher(projectRoot);

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
				.describe('Path must contain ALL strings - AND logic (e.g., ["services", "user"])'),
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
				.describe('Only public/exported symbols (Go: Capitalized, Python: no _ prefix, JS/TS: export)'),
			decorator_contains: z
				.string()
				.optional()
				.describe('Has decorator/attribute containing string (Python: @route, Java: @GetMapping, Rust: #[test])'),
			has_docstring: z.boolean().optional().describe('Only code with doc comments'),
		})
		.optional();

	// Tool: viberag_search
	server.addTool({
		name: 'viberag_search',
		description: `Search code by meaning or keywords. Supports iterative refinement.

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
4. If results seem incomplete, try viberag_multi_search for comparison
5. Use exhaustive=true for refactoring tasks needing ALL matches

RESULT INTERPRETATION:
- score: Combined relevance (higher = better)
- vectorScore: Semantic similarity (0-1, may be missing for exact mode)
- ftsScore: Keyword match strength (BM25 score)
- debug.searchQuality: 'high', 'medium', or 'low' based on vector scores
- debug.suggestion: Hints when different settings might work better

FILTERS (transparent, you control what's excluded):
Path filters:
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

			const engine = new SearchEngine(projectRoot);
			try {
				// Determine if debug info should be returned
				const returnDebug =
					args.return_debug ?? (args.mode === 'hybrid' || args.mode === undefined);

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
				return formatSearchResults(results, returnDebug);
			} finally {
				engine.close();
			}
		},
	});

	// Tool: viberag_index
	server.addTool({
		name: 'viberag_index',
		description:
			'Index the codebase for semantic search. Uses incremental indexing by default ' +
			'(only processes changed files based on Merkle tree diff). ' +
			'Use force=true for full reindex after config changes.',
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
			'If schema version is outdated, run viberag_index with force=true to reindex.',
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

	// Tool: viberag_multi_search
	server.addTool({
		name: 'viberag_multi_search',
		description: `Run multiple searches in parallel and compare results.

USE CASES:
- Compare semantic vs keyword results for the same query
- Run same query with different weights to find optimal settings
- Search multiple related queries and aggregate results
- Implement multi-phase search strategies

RETURNS:
- Individual results for each search configuration
- Merged/deduped results with source tracking
- Comparative metrics (overlap, unique results per config)

EXAMPLE STRATEGIES:
1. Mode comparison: [{mode:'semantic'}, {mode:'exact'}, {mode:'hybrid'}]
2. Weight tuning: [{bm25_weight:0.2}, {bm25_weight:0.5}, {bm25_weight:0.8}]
3. Multi-query: [{query:'auth'}, {query:'authentication'}, {query:'login'}]`,
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
						auto_boost: z
							.boolean()
							.optional()
							.describe('Enable auto-boost'),
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
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);

			const engine = new SearchEngine(projectRoot);
			try {
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
					const mergedResults = allResults
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

					// Calculate overlap statistics
					const uniqueToSearch = args.searches.map((_, i) =>
						allResults.filter(
							r => r.sources.length === 1 && r.sources[0] === i,
						).length,
					);
					const overlapping = allResults.filter(
						r => r.sources.length > 1,
					).length;

					merged = {
						strategy: args.merge_strategy,
						totalUnique: allResults.length,
						resultCount: mergedResults.length,
						overlap: overlapping,
						uniquePerSearch: uniqueToSearch,
						results: mergedResults,
					};
				}

				return JSON.stringify({
					searchCount: args.searches.length,
					individual,
					merged,
				});
			} finally {
				engine.close();
			}
		},
	});

	return {
		server,
		watcher,
		startWatcher: async () => {
			// Only start watcher if project is initialized
			if (await configExists(projectRoot)) {
				await watcher.start();
			}
		},
		stopWatcher: async () => {
			await watcher.stop();
		},
	};
}
