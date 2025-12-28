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
	type SearchResults,
	type IndexStats,
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
			elapsedMs: results.elapsedMs,
			results: [],
		});
	}

	return JSON.stringify({
		query: results.query,
		searchType: results.searchType,
		elapsedMs: results.elapsedMs,
		resultCount: results.results.length,
		results: results.results.map(r => ({
			type: r.type,
			name: r.name || '(anonymous)',
			filepath: r.filepath,
			startLine: r.startLine,
			endLine: r.endLine,
			score: Number(r.score.toFixed(4)),
			text: r.text,
		})),
	});
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

	// Tool: viberag_search
	server.addTool({
		name: 'viberag_search',
		description:
			'Search the codebase using hybrid semantic search (vector + BM25). ' +
			'Returns ranked code chunks with file paths, line numbers, symbol types, and relevance scores. ' +
			'Use natural language queries like "authentication functions" or "database connection handling".',
		parameters: z.object({
			query: z.string().describe('The search query in natural language'),
			limit: z
				.number()
				.min(1)
				.max(50)
				.optional()
				.default(10)
				.describe('Maximum number of results (1-50, default: 10)'),
			bm25_weight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.default(0.3)
				.describe(
					'Weight for keyword matching vs semantic search (0-1, default: 0.3)',
				),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);

			const engine = new SearchEngine(projectRoot);
			try {
				const results = await engine.search(args.query, {
					limit: args.limit,
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
			'Get index status including file count, chunk count, embedding provider, and last update time.',
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

			return JSON.stringify({
				status: 'indexed',
				version: manifest.version,
				createdAt: manifest.createdAt,
				updatedAt: manifest.updatedAt,
				totalFiles: manifest.stats.totalFiles,
				totalChunks: manifest.stats.totalChunks,
				embeddingProvider: config.embeddingProvider,
				embeddingModel: config.embeddingModel,
				embeddingDimensions: config.embeddingDimensions,
			});
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
