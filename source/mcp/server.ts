/**
 * MCP Server for VibeRAG.
 *
 * Exposes agent-centric search + navigation tools over MCP, backed by the daemon.
 *
 * Tools:
 * - codebase_search: semantic search with intent routing (symbols/files/blocks)
 * - help: usage guide for MCP tools + search behavior
 * - get_symbol_details: fetch full symbol definition + metadata
 * - get_surrounding_code: fetch neighbors for a search hit
 * - read_file_lines: read exact source lines from disk
 * - find_references: find all references to a symbol
 * - build_index: build/update the search index
 * - get_status: initialization + index status
 * - get_watcher_status: watcher status (auto-indexing)
 * - cancel_operation: cancel warmup/indexing
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {FastMCP} from 'fastmcp';
import {z} from 'zod';
import {configExists, loadConfig} from '../daemon/lib/config.js';
import {
	checkNpmForUpdate,
	type NpmUpdateCheckResult,
} from '../daemon/lib/update-check.js';
import {
	checkV2IndexCompatibility,
	loadV2Manifest,
	v2ManifestExists,
} from '../daemon/services/v2/manifest.js';
import {getGrammarSupportSummary} from '../daemon/lib/chunker/grammars.js';
import {DaemonClient} from '../client/index.js';
import type {DaemonStatusResponse} from '../client/types.js';
import {createServiceLogger, type Logger} from '../daemon/lib/logger.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as {
	name: string;
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

const MCP_SERVER_INSTRUCTIONS = `viberag provides semantic codebase search tools + navigation over MCP.
Use viberag when trying to find all code, documentation, and files semantically related to a concept.
When you use viberag to search, viberag will uncover semantically related variables, types, classes, functions, definitions, symbols, and files so that you can ensure no important context is missed.

General workflow:
- Use codebase_search as the starting point for exploration. Choose an intent (auto/definition/usage/concept/exact_text/similar_code) and optional scope filters (path_prefix/path_contains/path_not_contains/extension).
- Use get_symbol_details(symbol_id) to fetch full definitions, find_references to locate usages, get_surrounding_code to expand context around a hit, and read_file_lines for raw source when you need exact lines.
- If errors or not initialized, call get_status to check if "not_initialized" or "not_indexed", ask the user to run "npx viberag" in the project and complete /init, then call build_index.
`;

function estimateJsonSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeResolveProjectPath(projectRoot: string, filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
	const resolved = path.resolve(projectRoot, normalized);
	const rootResolved = path.resolve(projectRoot);
	if (resolved === rootResolved) {
		throw new Error(
			'read_file_lines requires a file path, not the project root.',
		);
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
		instructions: MCP_SERVER_INSTRUCTIONS,
	});

	const client = new DaemonClient(projectRoot);

	const updateTimeoutMs = 3000;
	const updateCheckDisabled =
		process.env['VIBERAG_SKIP_UPDATE_CHECK'] === '1' ||
		process.env['VIBERAG_SKIP_UPDATE_CHECK'] === 'true' ||
		process.env['NODE_ENV'] === 'test';
	let npmUpdate:
		| ({status: 'pending'; startedAt: string; timeoutMs: number} & {
				packageName: string;
				currentVersion: string;
		  })
		| NpmUpdateCheckResult = updateCheckDisabled
		? {
				packageName: pkg.name,
				currentVersion: pkg.version,
				latestVersion: null,
				status: 'skipped',
				checkedAt: new Date().toISOString(),
				timeoutMs: updateTimeoutMs,
				error: null,
				upgradeCommand: `npm install -g ${pkg.name}`,
				message: null,
			}
		: {
				status: 'pending',
				startedAt: new Date().toISOString(),
				timeoutMs: updateTimeoutMs,
				packageName: pkg.name,
				currentVersion: pkg.version,
			};

	let npmUpdateStarted = updateCheckDisabled;
	server.on('connect', () => {
		if (updateCheckDisabled) return;
		if (npmUpdateStarted) return;
		npmUpdateStarted = true;

		checkNpmForUpdate({
			packageName: pkg.name,
			currentVersion: pkg.version,
			timeoutMs: updateTimeoutMs,
		})
			.then(result => {
				npmUpdate = result;
			})
			.catch(error => {
				const message = error instanceof Error ? error.message : String(error);
				npmUpdate = {
					packageName: pkg.name,
					currentVersion: pkg.version,
					latestVersion: null,
					status: 'error',
					checkedAt: new Date().toISOString(),
					timeoutMs: updateTimeoutMs,
					error: message,
					upgradeCommand: `npm install -g ${pkg.name}`,
					message: null,
				};
			});
	});

	let logger: Logger | null = null;
	const getLogger = (): Logger => {
		if (!logger) {
			logger = createServiceLogger(projectRoot, 'mcp');
		}
		return logger;
	};

	const scopeSchema = z
		.object({
			path_prefix: z
				.array(z.string())
				.optional()
				.describe(
					'Only include paths that start with any of these prefixes (project-relative). Example: ["src/"]. Avoiding when exploring and trying to find all related files.',
				),
			path_contains: z
				.array(z.string())
				.optional()
				.describe(
					'Only include paths that contain any of these substrings. Example: ["components/"]. Avoiding when exploring and trying to find all related files.',
				),
			path_not_contains: z
				.array(z.string())
				.optional()
				.describe(
					'Exclude paths that contain any of these substrings. Example: ["node_modules/"]. Avoiding when exploring and trying to find all related files.',
				),
			extension: z
				.array(z.string())
				.optional()
				.describe(
					'Only include files with these extensions (including the dot). Example: [".ts", ".tsx"]. Avoiding when exploring and trying to find all related files.',
				),
		})
		.optional();

	// Tool: help
	server.addTool({
		name: 'help',
		description: `Get usage guide for VibeRAG tools and search behavior.

WHEN TO USE:
- Learn how intent routing works
- See examples for each tool
- Understand the search channels (FTS, vector, hybrid)

INPUT: Optional tool name for specific help.
RETURNS: Detailed guide with examples and workflow suggestions.`,
		parameters: z.object({
			tool: z
				.enum([
					'codebase_search',
					'read_file_lines',
					'get_symbol_details',
					'find_references',
					'get_surrounding_code',
					'build_index',
					'get_status',
					'get_watcher_status',
					'cancel_operation',
				])
				.optional()
				.describe('Get help for a specific tool'),
		}),
		execute: async args => {
			const all = {
				how_search_works: {
					intent_routing:
						'codebase_search routes queries into definition/usage/concept/exact_text/similar_code. Override with intent param.',
					channels: [
						{
							channel: 'fts',
							kind: 'Full-text (BM25)',
							notes:
								'Indexes symbol names, qualnames, identifiers, and code text.',
						},
						{
							channel: 'fts_fuzzy',
							kind: 'Full-text fuzzy (Levenshtein)',
							notes:
								'Tolerates typos in symbol name lookups (definition intent).',
						},
						{
							channel: 'vector',
							kind: 'Semantic vector search',
							notes:
								'Embeddings-based similarity for concept queries and similar-code.',
						},
						{
							channel: 'hybrid',
							kind: 'Hybrid rerank',
							notes:
								'Combines FTS + vector using Reciprocal Rank Fusion (RRF).',
						},
					],
				},
				tools: {
					codebase_search: {
						when_to_use:
							'Start here. Symbol lookups, concept questions, error strings, code patterns.',
						key_inputs: [
							'query (required)',
							'intent: auto|definition|usage|concept|exact_text|similar_code',
							'scope filters (path_prefix/path_contains/path_not_contains/extension)',
						],
						output:
							'Grouped hits (definitions/files/blocks/usages) + stable IDs.',
						next_steps: [
							'get_symbol_details(symbol_id) → full code',
							'find_references(symbol_id) → all usages',
							'get_surrounding_code(table, id) → neighbors',
						],
						examples: [
							{query: 'HttpClient', intent: 'definition'},
							{query: 'how does authentication work', intent: 'concept'},
							{query: 'ECONNRESET', intent: 'exact_text'},
							{query: 'where is login used', intent: 'usage'},
						],
					},
					get_symbol_details: {
						when_to_use:
							'After codebase_search returns a definition. Get full code + metadata.',
						key_inputs: ['symbol_id (required)'],
						output:
							'Full code_text, signature, docstring, decorators, location.',
						next_steps: [
							'find_references(symbol_id) → where used',
							'get_surrounding_code("symbols", symbol_id) → neighbors',
						],
					},
					read_file_lines: {
						when_to_use:
							'Read raw source lines when search snippet is truncated or need more context.',
						key_inputs: ['file_path, start_line, end_line'],
						output: 'Exact text for the line range.',
					},
					get_surrounding_code: {
						when_to_use:
							'Navigate from a search hit to neighbors: other methods in class, related chunks, file structure.',
						key_inputs: ['table (symbols|chunks|files), id (required)'],
						output: 'Neighboring entities to continue exploration.',
					},
					find_references: {
						when_to_use:
							'Find all references to a symbol (calls, imports, type annotations).',
						key_inputs: ['symbol_id (preferred) or symbol_name'],
						output: 'Refs grouped by file with context snippets.',
					},
					build_index: {
						when_to_use:
							'First setup, after config changes (force=true), or manual reindex.',
						key_inputs: ['force (optional)'],
						output: 'Indexing stats.',
					},
					get_status: {
						when_to_use:
							'Check if VibeRAG is ready. Shows init status, index health, update availability.',
						key_inputs: [],
						output: 'Status + instructions if not ready.',
					},
					get_watcher_status: {
						when_to_use: 'Check if auto-indexing is active.',
						key_inputs: [],
						output: 'Watcher status.',
					},
					cancel_operation: {
						when_to_use: 'Cancel in-progress indexing or warmup.',
						key_inputs: ['target (optional), reason (optional)'],
						output: 'Cancellation result.',
					},
				},
			};

			if (args.tool) {
				const tool = args.tool;
				const entry = (all.tools as Record<string, unknown>)[tool];
				return JSON.stringify(
					entry
						? {tool, ...(entry as Record<string, unknown>)}
						: {tool, message: 'Unknown tool'},
				);
			}

			return JSON.stringify(all);
		},
	});

	// Tool: codebase_search
	server.addTool({
		name: 'codebase_search',
		description: `Semantic codebase search - your starting point for code exploration.

WHEN TO USE:
- Understanding features: "how does authentication work"
- Finding symbols: class names, function names, types
- Tracing errors: exact error messages or log strings
- Finding patterns: code snippets you want to match

INTENT (auto-detected, or override):
- concept: Natural language questions ("how does X work")
- definition: Symbol lookups (CamelCase names, function())
- usage: "where is X used/called/imported"
- exact_text: Literal strings, error messages, log output
- similar_code: Code snippets to find similar patterns

RETURNS: Grouped results (definitions/files/blocks/usages) with stable IDs.

NEXT STEPS:
- get_symbol_details(symbol_id) → full code + metadata
- find_references(symbol_id) → all call sites and imports
- get_surrounding_code(table, id) → neighboring symbols/chunks
- read_file_lines(file_path, start, end) → exact source lines`,
		parameters: z.object({
			query: z
				.string()
				.describe('Natural language, symbol name, or code snippet'),
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
				.describe(
					'Search strategy: auto (detect from query), concept (how does X work), definition (symbol lookup), usage (where is X used), exact_text (literal strings), similar_code (code patterns)',
				),
			scope: scopeSchema.describe(
				'Path/extension filters: path_prefix, path_contains, path_not_contains, extension',
			),
			k: z
				.number()
				.min(1)
				.max(100)
				.optional()
				.default(20)
				.describe('Max results per group'),
			explain: z
				.boolean()
				.optional()
				.default(true)
				.describe('Include match explanations (which search channels matched)'),
			max_response_size: z
				.number()
				.min(1024)
				.max(MAX_RESPONSE_SIZE)
				.optional()
				.default(DEFAULT_MAX_RESPONSE_SIZE)
				.describe('Max response size in bytes (default: 50KB)'),
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

	// Tool: read_file_lines
	server.addTool({
		name: 'read_file_lines',
		description: `Read exact source code lines from a file.

WHEN TO USE:
- Search result snippet is truncated
- Need more context around a specific location
- Want raw code at known line numbers

INPUT: file_path (project-relative), start_line, end_line
RETURNS: Exact text for the requested line range.

NOTE: Use after search results give you a file_path and line numbers.`,
		parameters: z.object({
			file_path: z
				.string()
				.describe('Project-relative path (e.g., "src/api/auth.ts")'),
			start_line: z.number().min(1).describe('First line to read (1-indexed)'),
			end_line: z.number().min(1).describe('Last line to read (1-indexed)'),
			max_lines: z
				.number()
				.min(1)
				.max(500)
				.optional()
				.default(200)
				.describe('Safety limit on returned lines (default: 200)'),
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

	// Tool: get_symbol_details
	server.addTool({
		name: 'get_symbol_details',
		description: `Fetch full details for a symbol by ID.

WHEN TO USE:
- After codebase_search returns a definition you want to inspect
- Need the complete code, signature, docstring, or decorators
- Want deterministic metadata (not search-ranked)

INPUT: symbol_id from codebase_search results
RETURNS: Full code_text, signature, docstring, decorators, location, export status.

NEXT STEPS:
- find_references(symbol_id) → where this symbol is used
- get_surrounding_code("symbols", symbol_id) → other symbols in same file`,
		parameters: z.object({
			symbol_id: z.string().describe('Symbol ID from codebase_search results'),
			include_code: z
				.boolean()
				.optional()
				.default(true)
				.describe('Include full code_text in response'),
			max_code_chars: z
				.number()
				.min(256)
				.max(100_000)
				.optional()
				.default(20_000)
				.describe('Truncate code_text to this length'),
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

	// Tool: find_references
	server.addTool({
		name: 'find_references',
		description: `Find all references to a symbol across the codebase.

WHEN TO USE:
- Trace how widely a function/class is used
- Find all call sites before refactoring
- Understand import/export relationships
- See where a symbol appears in the codebase

INPUT: symbol_id (preferred, from codebase_search) or symbol_name as fallback
RETURNS: References grouped by file, with line numbers and context snippets.

EXAMPLES:
- find_references(symbol_id: "abc123") → precise results for that symbol
- find_references(symbol_name: "HttpClient") → all refs to any HttpClient`,
		parameters: z
			.object({
				symbol_id: z
					.string()
					.optional()
					.describe('Symbol ID from codebase_search (preferred for precision)'),
				symbol_name: z
					.string()
					.optional()
					.describe('Symbol name as fallback (e.g., "HttpClient", "login")'),
				scope: scopeSchema.describe('Path/extension filters to narrow results'),
				k: z
					.number()
					.min(1)
					.max(2000)
					.optional()
					.default(200)
					.describe('Max references to return'),
				max_response_size: z
					.number()
					.min(1024)
					.max(MAX_RESPONSE_SIZE)
					.optional()
					.default(DEFAULT_MAX_RESPONSE_SIZE)
					.describe('Max response size in bytes (default: 50KB)'),
			})
			.refine(v => v.symbol_id || v.symbol_name, {
				message: 'Provide symbol_id or symbol_name',
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

	// Tool: get_surrounding_code
	server.addTool({
		name: 'get_surrounding_code',
		description: `Get neighboring code around a search result.

WHEN TO USE:
- See other methods in the same class
- Understand file structure around a hit
- Find related functions near your result
- Navigate from a chunk to its parent symbol

INPUT: table ("symbols" | "chunks" | "files") + id from codebase_search results
RETURNS: Neighboring entities - adjacent symbols, related chunks, or file metadata.

EXAMPLES:
- get_surrounding_code("symbols", id) → other symbols in same file, child methods
- get_surrounding_code("chunks", id) → nearby code blocks, parent symbol
- get_surrounding_code("files", id) → file-level exports, imports, summary`,
		parameters: z.object({
			table: z
				.enum(['symbols', 'chunks', 'files'])
				.describe('Which table the ID came from'),
			id: z.string().describe('Entity ID from codebase_search results'),
			limit: z
				.number()
				.min(1)
				.max(200)
				.optional()
				.default(25)
				.describe('Max neighbors to return per section'),
			max_code_chars: z
				.number()
				.min(256)
				.max(100_000)
				.optional()
				.default(20_000)
				.describe('Truncate code_text fields to this length'),
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

	// Tool: build_index
	server.addTool({
		name: 'build_index',
		description: `Build or update the semantic search index.

WHEN TO USE:
- First time setup after initialization
- After changing configuration (use force=true)
- Manually trigger reindex after code changes
- Fix "reindex required" errors (use force=true)

INPUT: force=false (incremental, default) or force=true (full rebuild)
RETURNS: Indexing stats - files processed, symbols/chunks created, embeddings computed.

NOTE: Usually automatic via file watcher. Only call manually if needed.`,
		parameters: z.object({
			force: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'Force full rebuild (use after upgrades or to fix corruption)',
				),
		}),
		execute: async args => {
			await ensureInitialized(projectRoot);
			const stats = await client.index({force: args.force});
			return JSON.stringify(stats);
		},
	});

	// Tool: cancel_operation
	server.addTool({
		name: 'cancel_operation',
		description: `Cancel ongoing indexing or warmup operations.

WHEN TO USE:
- Indexing is taking too long
- Need to stop warmup to free resources
- Want to restart with different options

INPUT: target ("indexing" | "warmup" | "all"), optional reason
RETURNS: What was cancelled and current state.`,
		parameters: z.object({
			target: z
				.enum(['indexing', 'warmup', 'all'])
				.optional()
				.default('all')
				.describe('What to cancel'),
			reason: z
				.string()
				.optional()
				.describe('Optional reason for cancellation'),
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

	// Tool: get_watcher_status
	server.addTool({
		name: 'get_watcher_status',
		description: `Check file watcher status for automatic index updates.

WHEN TO USE:
- Verify auto-indexing is active
- Debug why index seems stale
- Check pending file changes

RETURNS: Watcher state, watched file count, pending changes.`,
		parameters: z.object({}),
		execute: async () => {
			const status = await client.watchStatus();
			return JSON.stringify(status);
		},
	});

	// Tool: get_status
	server.addTool({
		name: 'get_status',
		description: `Check VibeRAG status - works even before initialization.

WHEN TO USE:
- First call to verify VibeRAG is ready
- Check if reindex is required after upgrade
- See index stats (files, symbols, chunks)
- Check for available updates

RETURNS:
- Initialization status and setup instructions (if not initialized)
- Index compatibility (may indicate reindex needed)
- Index stats: file/symbol/chunk counts
- Daemon status: running, warmup progress, indexing state

CALL THIS FIRST if unsure whether VibeRAG is ready to use.`,
		parameters: z.object({}),
		execute: async () => {
			const v2IndexCompatibility = await checkV2IndexCompatibility(projectRoot);
			const grammar = getGrammarSupportSummary();
			const parsing = {
				enabled: grammar.enabled.map(g => g.display_name),
				disabled: grammar.disabled.map(g => ({
					language: g.language,
					name: g.display_name,
					reason: g.reason,
				})),
				note: 'Markdown/unsupported files are indexed as plain text (no AST symbols/refs/usages).',
			};
			const initialized = await configExists(projectRoot);
			if (!initialized) {
				return JSON.stringify({
					status: 'not_initialized',
					projectRoot,
					parsing,
					startup_checks: {
						npm_update: npmUpdate,
						index: v2IndexCompatibility,
					},
					message: 'VibeRAG is not initialized in this project.',
					instructions: {
						step1: 'Run "npx viberag" in a terminal in this project directory',
						step2: 'Use the /init command to configure an embedding provider',
						note: 'After initialization, run the build_index tool to create the search index',
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
					parsing,
					startup_checks: {
						npm_update: npmUpdate,
						index: v2IndexCompatibility,
					},
					message: 'No index found. Run the build_index tool to create one.',
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
				schemaVersion: manifest.schemaVersion,
				createdAt: manifest.createdAt,
				updatedAt: manifest.updatedAt,
				totalFiles: manifest.stats.totalFiles,
				totalSymbols: manifest.stats.totalSymbols,
				totalChunks: manifest.stats.totalChunks,
				totalRefs: manifest.stats.totalRefs,
				embeddingProvider: config.embeddingProvider,
				embeddingModel: config.embeddingModel,
				embeddingDimensions: config.embeddingDimensions,
				parsing,
				startup_checks: {
					npm_update: npmUpdate,
					index: v2IndexCompatibility,
				},
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
