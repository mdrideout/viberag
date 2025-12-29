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
function formatSearchResults(results: SearchResults): string {
	if (results.results.length === 0) {
		return JSON.stringify({
			message: `No results found for "${results.query}"`,
			mode: results.searchType,
			elapsedMs: results.elapsedMs,
			results: [],
		});
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
			signature: r.signature ?? undefined,
			isExported: r.isExported ?? undefined,
			text: r.text,
		})),
	};

	// Add totalMatches for exhaustive mode
	if (results.totalMatches !== undefined) {
		response['totalMatches'] = results.totalMatches;
	}

	return JSON.stringify(response);
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
				.describe('Scope to files starting with this path (e.g., "src/api/")'),
			path_contains: z
				.array(z.string())
				.optional()
				.describe('Must contain ALL of these strings in path'),
			path_not_contains: z
				.array(z.string())
				.optional()
				.describe(
					'Exclude paths containing ANY of these (e.g., ["test", "__tests__", ".spec."])',
				),
			type: z
				.array(z.enum(['function', 'class', 'method', 'module']))
				.optional()
				.describe('Filter by code structure type'),
			extension: z
				.array(z.string())
				.optional()
				.describe('Filter by file extension (e.g., [".ts", ".tsx"])'),
			is_exported: z
				.boolean()
				.optional()
				.describe('Only exported/public symbols'),
			decorator_contains: z
				.string()
				.optional()
				.describe('Has decorator matching string (e.g., "Get", "route")'),
			has_docstring: z.boolean().optional().describe('Has documentation'),
		})
		.optional();

	// Tool: viberag_search
	server.addTool({
		name: 'viberag_search',
		description: `Search code by meaning or keywords. Primary search tool.

MODE SELECTION:
- 'semantic': For conceptual queries ("how does auth work"). Finds code by meaning.
- 'exact': For symbol names, specific strings ("handlePayment"). Keyword-based, fast.
- 'hybrid' (default): Combines semantic + keyword. Good general purpose.
- 'definition': For "where is X defined". Direct lookup, fastest.
- 'similar': For "find code like this". Pass code_snippet parameter.

EXHAUSTIVE MODE:
Set exhaustive=true for refactoring tasks that need ALL matches.
Default (false) returns top results by relevance.

FILTERS (transparent, you control what's excluded):
- path_prefix: Scope to directory (e.g., "src/api/")
- path_contains: Must contain strings (e.g., ["auth"])
- path_not_contains: Exclude paths (e.g., ["test", "__tests__", ".spec."])
- type: Code structure (["function", "class", "method"])
- extension: File types ([".ts", ".py"])
- is_exported: Only public/exported symbols
- decorator_contains: Has decorator matching string (e.g., "Get", "route")

MULTI-STAGE PATTERN:
For complex queries, call multiple times with progressive filtering:
1. Broad search to discover area
2. Narrow with path filters from results
3. Refine with specific terms`,
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
					'[Deprecated: use mode instead] Weight for keyword matching (0-1)',
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
				const results = await engine.search(args.query, {
					mode: args.mode,
					limit: args.limit,
					exhaustive: args.exhaustive,
					minScore: args.min_score,
					filters,
					codeSnippet: args.code_snippet,
					symbolName: args.symbol_name,
					bm25Weight: args.bm25_weight,
				});
				return formatSearchResults(results);
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
