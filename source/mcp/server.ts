/**
 * MCP Server for VibeRAG (v2).
 *
 * Exposes agent-centric search + navigation tools over MCP, backed by the daemon.
 *
 * Tools:
 * - search: intent-routed retrieval (symbols/files/blocks)
 * - get_symbol: fetch a symbol definition + metadata
 * - expand_context: fetch neighbors for a hit (symbols/chunks/files)
 * - open_span: read an exact code span from disk
 * - index: build/update the v2 index
 * - status: initialization + index status
 * - watch_status: watcher status (auto-indexing)
 * - cancel: cancel warmup/indexing
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {FastMCP} from 'fastmcp';
import {z} from 'zod';
import {configExists, loadConfig} from '../daemon/lib/config.js';
import {
	loadV2Manifest,
	v2ManifestExists,
} from '../daemon/services/v2/manifest.js';
import {DaemonClient} from '../client/index.js';
import type {DaemonStatusResponse} from '../client/types.js';
import {createServiceLogger, type Logger} from '../daemon/lib/logger.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as {
	version: `${number}.${number}.${number}`;
};

class NotInitializedError extends Error {
	constructor(projectRoot: string) {
		super(
			`VibeRAG not initialized in ${projectRoot}. ` +
				`Run 'npx viberag' in this directory and complete initialization.`,
		);
		this.name = 'NotInitializedError';
	}
}

async function ensureInitialized(projectRoot: string): Promise<void> {
	const exists = await configExists(projectRoot);
	if (!exists) {
		throw new NotInitializedError(projectRoot);
	}
}

const DEFAULT_MAX_RESPONSE_SIZE = 50 * 1024;
const MAX_RESPONSE_SIZE = 100 * 1024;

function estimateJsonSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeResolveProjectPath(projectRoot: string, filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
	const resolved = path.resolve(projectRoot, normalized);
	const rootResolved = path.resolve(projectRoot);
	if (resolved === rootResolved) {
		throw new Error('open_span requires a file path, not the project root.');
	}
	if (!resolved.startsWith(rootResolved + path.sep)) {
		throw new Error(`Refusing to read outside project root: ${filePath}`);
	}
	return resolved;
}

function truncateString(
	value: string,
	maxChars: number,
): {text: string; truncated: boolean} {
	if (value.length <= maxChars) return {text: value, truncated: false};
	return {text: value.slice(0, maxChars) + '\n…(truncated)…', truncated: true};
}

function clampLineRange(args: {
	start_line: number;
	end_line: number;
	max_lines: number;
}): {start: number; end: number; truncated: boolean} {
	const start = Math.max(1, Math.floor(args.start_line));
	const end = Math.max(start, Math.floor(args.end_line));
	const maxLines = Math.max(1, Math.floor(args.max_lines));

	if (end - start + 1 <= maxLines) {
		return {start, end, truncated: false};
	}
	return {start, end: start + maxLines - 1, truncated: true};
}

export interface McpServerWithDaemon {
	server: FastMCP;
	client: DaemonClient;
	connectDaemon: () => Promise<void>;
	disconnectDaemon: () => Promise<void>;
}

export function createMcpServer(projectRoot: string): McpServerWithDaemon {
	const server = new FastMCP({
		name: 'viberag',
		version: pkg.version,
	});

	const client = new DaemonClient(projectRoot);

	let logger: Logger | null = null;
	const getLogger = (): Logger => {
		if (!logger) {
			logger = createServiceLogger(projectRoot, 'mcp');
		}
		return logger;
	};

	const scopeSchema = z
		.object({
			path_prefix: z.array(z.string()).optional(),
			path_contains: z.array(z.string()).optional(),
			path_not_contains: z.array(z.string()).optional(),
			extension: z.array(z.string()).optional(),
		})
		.optional();

	// Tool: search
	server.addTool({
		name: 'search',
		description:
			'Intent-routed codebase search. Returns grouped results (definitions/files/blocks) with optional explanations and stable IDs for follow-ups.',
		parameters: z.object({
			query: z.string().describe('Natural language, symbol, or code query'),
			intent: z
				.enum([
					'auto',
					'definition',
					'usage',
					'concept',
					'exact_text',
					'similar_code',
				])
				.optional()
				.default('auto')
				.describe('Intent routing (default: auto)'),
			scope: scopeSchema.describe('Transparent path/extension filters'),
			k: z
				.number()
				.min(1)
				.max(100)
				.optional()
				.default(20)
				.describe('Max results per group (best-effort)'),
			explain: z
				.boolean()
				.optional()
				.default(true)
				.describe('Include per-hit channel explanation'),
			max_response_size: z
				.number()
				.min(1024)
				.max(MAX_RESPONSE_SIZE)
				.optional()
				.default(DEFAULT_MAX_RESPONSE_SIZE)
				.describe('Cap response size in bytes (default: 50KB)'),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);

			const trySearch = async (explain: boolean, k: number) => {
				const result = await client.search(args.query, {
					intent: args.intent,
					scope: args.scope,
					k,
					explain,
				});
				return result;
			};

			let explain = args.explain;
			let k = args.k;
			let result = await trySearch(explain, k);

			// Best-effort trimming strategy: drop explain, then reduce k.
			while (estimateJsonSize(result) > args.max_response_size) {
				if (explain) {
					explain = false;
					result = await trySearch(explain, k);
					continue;
				}
				if (k <= 1) break;
				k = Math.max(1, Math.floor(k / 2));
				result = await trySearch(explain, k);
			}

			return JSON.stringify(result);
		},
	});

	// Tool: open_span
	server.addTool({
		name: 'open_span',
		description:
			'Read an exact span from disk by file path + line range. Useful for expanding context precisely.',
		parameters: z.object({
			file_path: z
				.string()
				.describe('Project-relative path (e.g., "src/app.ts")'),
			start_line: z.number().min(1).describe('1-indexed start line'),
			end_line: z.number().min(1).describe('1-indexed end line'),
			max_lines: z
				.number()
				.min(1)
				.max(500)
				.optional()
				.default(200)
				.describe('Clamp returned line range to avoid huge responses'),
		}),
		execute: async args => {
			const absolutePath = safeResolveProjectPath(projectRoot, args.file_path);
			const content = await fs.readFile(absolutePath, 'utf-8');
			const lines = content.split('\n');

			const {start, end, truncated} = clampLineRange({
				start_line: args.start_line,
				end_line: args.end_line,
				max_lines: args.max_lines,
			});

			const slice = lines.slice(start - 1, end).join('\n');
			return JSON.stringify({
				file_path: args.file_path,
				start_line: start,
				end_line: end,
				truncated,
				text: slice,
			});
		},
	});

	// Tool: get_symbol
	server.addTool({
		name: 'get_symbol',
		description:
			'Fetch a symbol definition and deterministic metadata by symbol_id.',
		parameters: z.object({
			symbol_id: z.string().describe('Symbol ID from search() results'),
			include_code: z
				.boolean()
				.optional()
				.default(true)
				.describe('Include code_text in response (default: true)'),
			max_code_chars: z
				.number()
				.min(256)
				.max(100_000)
				.optional()
				.default(20_000)
				.describe('Clamp returned code_text length'),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);
			const symbol = await client.getSymbol(args.symbol_id);
			if (!symbol) {
				return JSON.stringify({
					found: false,
					symbol_id: args.symbol_id,
					message: 'Symbol not found. Re-run search or reindex.',
				});
			}

			const out: Record<string, unknown> = {...symbol, found: true};

			if (!args.include_code) {
				delete out['code_text'];
			} else if (typeof out['code_text'] === 'string') {
				const {text, truncated} = truncateString(
					out['code_text'],
					args.max_code_chars,
				);
				out['code_text'] = text;
				if (truncated) {
					out['code_truncated'] = true;
				}
			}

			return JSON.stringify(out);
		},
	});

	// Tool: find_usages
	server.addTool({
		name: 'find_usages',
		description:
			'Find usage occurrences (refs) for a symbol name or symbol_id. Returns refs grouped by file with stable ref_ids for follow-up actions.',
		parameters: z
			.object({
				symbol_id: z
					.string()
					.optional()
					.describe('Symbol ID from search() results (preferred)'),
				symbol_name: z
					.string()
					.optional()
					.describe('Raw symbol name (e.g., "HttpClient")'),
				scope: scopeSchema.describe('Transparent path/extension filters'),
				k: z
					.number()
					.min(1)
					.max(2000)
					.optional()
					.default(200)
					.describe('Max refs returned (best-effort)'),
				max_response_size: z
					.number()
					.min(1024)
					.max(MAX_RESPONSE_SIZE)
					.optional()
					.default(DEFAULT_MAX_RESPONSE_SIZE)
					.describe('Cap response size in bytes (default: 50KB)'),
			})
			.refine(v => v.symbol_id || v.symbol_name, {
				message: 'symbol_id or symbol_name is required',
			}),
		execute: async args => {
			await ensureInitialized(projectRoot);

			const tryFind = async (k: number) => {
				return client.findUsages({
					symbol_id: args.symbol_id,
					symbol_name: args.symbol_name,
					scope: args.scope,
					k,
				});
			};

			let k = args.k;
			let result = await tryFind(k);

			while (estimateJsonSize(result) > args.max_response_size) {
				if (k <= 1) break;
				k = Math.max(1, Math.floor(k / 2));
				result = await tryFind(k);
			}

			return JSON.stringify(result);
		},
	});

	// Tool: expand_context
	server.addTool({
		name: 'expand_context',
		description:
			'Given a hit (symbols/chunks/files), return neighbors: adjacent symbols, owned chunks, and related metadata.',
		parameters: z.object({
			table: z.enum(['symbols', 'chunks', 'files']),
			id: z.string().describe('Entity ID from search() results'),
			limit: z
				.number()
				.min(1)
				.max(200)
				.optional()
				.default(25)
				.describe('Max neighbors per section'),
			max_code_chars: z
				.number()
				.min(256)
				.max(100_000)
				.optional()
				.default(20_000)
				.describe('Clamp code_text fields in the response'),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);
			const expanded = await client.expandContext({
				table: args.table,
				id: args.id,
				limit: args.limit,
			});

			// Best-effort clamp of large code_text blobs.
			const maxChars = args.max_code_chars;
			const visit = (value: unknown): unknown => {
				if (typeof value === 'string') {
					return value.length > maxChars
						? truncateString(value, maxChars).text
						: value;
				}
				if (Array.isArray(value)) {
					return value.map(v => visit(v));
				}
				if (value && typeof value === 'object') {
					const obj = value as Record<string, unknown>;
					const out: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(obj)) {
						out[k] =
							k === 'code_text' && typeof v === 'string'
								? truncateString(v, maxChars).text
								: visit(v);
					}
					return out;
				}
				return value;
			};

			return JSON.stringify(visit(expanded));
		},
	});

	// Tool: index
	server.addTool({
		name: 'index',
		description:
			'Build or update the v2 index (symbols/chunks/files). Uses incremental indexing by default.',
		parameters: z.object({
			force: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'Force full rebuild of v2 entity tables (keeps embedding cache)',
				),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);
			const stats = await client.index({force: args.force});
			return JSON.stringify(stats);
		},
	});

	// Tool: cancel
	server.addTool({
		name: 'cancel',
		description:
			'Cancel the current daemon activity (indexing or warmup) without shutting down the daemon.',
		parameters: z.object({
			target: z.enum(['indexing', 'warmup', 'all']).optional().default('all'),
			reason: z.string().optional(),
		}),
		execute: async args => {
			if (!(await client.isRunning())) {
				return JSON.stringify({
					cancelled: false,
					targets: [],
					skipped: ['indexing', 'warmup'],
					reason: null,
					message: 'Daemon is not running. Nothing to cancel.',
				});
			}
			const response = await client.cancel({
				target: args.target,
				reason: args.reason,
			});
			return JSON.stringify(response);
		},
	});

	// Tool: watch_status
	server.addTool({
		name: 'watch_status',
		description: 'Get watcher status (auto-indexing).',
		parameters: z.object({}),
		execute: async () => {
			const status = await client.watchStatus();
			return JSON.stringify(status);
		},
	});

	// Tool: status
	server.addTool({
		name: 'status',
		description:
			'Get v2 index status and daemon status summary. Works even when the project is not initialized.',
		parameters: z.object({}),
		execute: async () => {
			const initialized = await configExists(projectRoot);
			if (!initialized) {
				return JSON.stringify({
					status: 'not_initialized',
					projectRoot,
					message: 'VibeRAG is not initialized in this project.',
					instructions: {
						step1: 'Run "npx viberag" in a terminal in this project directory',
						step2: 'Use the /init command to configure an embedding provider',
						note: 'After initialization, run the index tool to create the search index',
					},
					daemon: {
						status: (await client.isRunning()) ? 'running' : 'not_running',
					},
				});
			}

			const indexed = await v2ManifestExists(projectRoot);
			if (!indexed) {
				return JSON.stringify({
					status: 'not_indexed',
					message: 'No index found. Run the index tool to create one.',
					daemon: {
						status: (await client.isRunning()) ? 'running' : 'not_running',
					},
				});
			}

			const config = await loadConfig(projectRoot);
			const manifest = await loadV2Manifest(projectRoot, {
				repoId: 'unknown',
				revision: 'working',
			});

			const response: Record<string, unknown> = {
				status: 'indexed',
				version: manifest.version,
				createdAt: manifest.createdAt,
				updatedAt: manifest.updatedAt,
				totalFiles: manifest.stats.totalFiles,
				totalSymbols: manifest.stats.totalSymbols,
				totalChunks: manifest.stats.totalChunks,
				totalRefs: manifest.stats.totalRefs,
				embeddingProvider: config.embeddingProvider,
				embeddingModel: config.embeddingModel,
				embeddingDimensions: config.embeddingDimensions,
			};

			// Add daemon status summary (best effort)
			if (await client.isRunning()) {
				try {
					const daemonStatus = await client.status();
					response['daemon'] = formatDaemonStatusSummary(daemonStatus);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error('[mcp] Failed to get daemon status:', error);
					getLogger().error(
						'MCP',
						'Failed to get daemon status',
						error instanceof Error ? error : new Error(message),
					);
					response['daemon'] = {status: 'unavailable'};
				}
			} else {
				response['daemon'] = {status: 'not_running'};
			}

			return JSON.stringify(response);
		},
	});

	return {
		server,
		client,
		connectDaemon: async () => {
			if (await configExists(projectRoot)) {
				try {
					await client.connect();
					console.error('[viberag-mcp] Connected to daemon');
				} catch (error) {
					console.error(
						'[viberag-mcp] Failed to connect to daemon:',
						error instanceof Error ? error.message : error,
					);
				}
			}
		},
		disconnectDaemon: async () => {
			await client.disconnect();
		},
	};
}

function formatDaemonStatusSummary(
	status: DaemonStatusResponse,
): Record<string, unknown> {
	return {
		warmup: {
			status: status.warmupStatus,
			elapsedMs: status.warmupElapsedMs,
			cancelRequestedAt: status.warmupCancelRequestedAt,
			cancelledAt: status.warmupCancelledAt,
			cancelReason: status.warmupCancelReason,
		},
		indexing: status.indexing,
		watcher: status.watcherStatus,
	};
}
