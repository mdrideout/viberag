/**
 * MCP server tests.
 *
 * Tests include:
 * 1. Smoke tests - verify module loads without circular dependency errors
 * 2. Integration tests - verify MCP protocol handshake and tool listing (requires daemon)
 * 3. Uninitialized project tests - verify helpful error handling
 *
 * Note: Integration tests require the daemon to start successfully.
 * The daemon needs Unix socket creation permissions. If the daemon fails to start
 * (e.g., EMFILE - too many open files, or EPERM - operation not permitted on socket),
 * the integration tests will be gracefully skipped.
 *
 * Common causes of daemon startup failure:
 * - macOS sandbox restrictions blocking Unix socket creation
 * - File descriptor limits (ulimit -n) too low for file watcher
 * - Security policies preventing process spawning
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawn, type ChildProcess} from 'node:child_process';
import {DaemonClient} from '../../client/index.js';
import {getSocketPath, isSocketConnectable} from '../../client/auto-start.js';
import {createConfigForProvider} from '../../daemon/lib/config.js';

const repoRoot = process.cwd();
const fixturesRoot = path.join(repoRoot, 'test-fixtures', 'codebase');
const mcpServerPath = path.resolve(repoRoot, 'dist/mcp/index.js');
const daemonPath = path.resolve(repoRoot, 'dist/daemon/index.js');
const requireDaemonTests =
	process.env['VIBERAG_REQUIRE_DAEMON_TESTS'] === '1' ||
	process.env['VIBERAG_REQUIRE_DAEMON_TESTS'] === 'true' ||
	process.env['CI'] === '1' ||
	process.env['CI'] === 'true';
const testProvider = (process.env['VIBERAG_TEST_PROVIDER'] ?? 'local').trim();
const testApiKey = process.env['VIBERAG_TEST_API_KEY']?.trim();
const supportedProviders = new Set(['local', 'gemini', 'mistral', 'openai']);

if (!supportedProviders.has(testProvider)) {
	throw new Error(
		`[mcp-server.test] Unsupported VIBERAG_TEST_PROVIDER "${testProvider}". ` +
			'Use local, gemini, mistral, or openai.',
	);
}

type IntegrationProject = {
	projectRoot: string;
	cleanup: () => Promise<void>;
};

type IntegrationProjectOptions = {
	watchEnabled?: boolean;
	includeLargeFile?: boolean;
};

type ToolResult = {
	content: Array<{type: string; text?: string}>;
	isError?: boolean;
};

type McpHarness = {
	client: Client;
	transport: StdioClientTransport;
	daemonClient: DaemonClient;
	daemonProcess: ChildProcess;
	project: IntegrationProject;
	cleanup: () => Promise<void>;
};

async function ensureMcpServerBuild(): Promise<void> {
	try {
		await fs.access(mcpServerPath);
	} catch {
		throw new Error(
			`[mcp-server.test] MCP server build missing at ${mcpServerPath}. ` +
				`Run npm run build.`,
		);
	}
}

async function ensureDaemonBuild(): Promise<void> {
	try {
		await fs.access(daemonPath);
	} catch {
		throw new Error(
			`[mcp-server.test] Daemon build missing at ${daemonPath}. Run npm run build.`,
		);
	}
}

async function startDaemonProcess(
	projectRoot: string,
): Promise<{process: ChildProcess; stderr: string}> {
	const daemonProcess = spawn('node', [daemonPath], {
		cwd: projectRoot,
		env: {
			...process.env,
			NODE_ENV: 'test',
		},
		stdio: ['ignore', 'ignore', 'pipe'],
	});

	let stderr = '';
	daemonProcess.stderr?.on('data', chunk => {
		stderr = `${stderr}${chunk.toString()}`.slice(-4000);
	});

	const socketPath = getSocketPath(projectRoot);
	const deadline = Date.now() + 60_000;

	while (Date.now() < deadline) {
		if (daemonProcess.exitCode !== null) {
			throw new Error(
				`[mcp-server.test] Daemon exited early (code ${daemonProcess.exitCode}). ` +
					`Stderr: ${stderr || 'none'}`,
			);
		}

		if (await isSocketConnectable(socketPath, 200)) {
			return {process: daemonProcess, stderr};
		}

		await new Promise(resolve => setTimeout(resolve, 200));
	}

	throw new Error(
		`[mcp-server.test] Daemon failed to start within 60000ms. ` +
			`Stderr: ${stderr || 'none'}`,
	);
}

function buildTestConfig(watchEnabled: boolean): Record<string, unknown> {
	const config = createConfigForProvider(
		testProvider as 'local' | 'gemini' | 'mistral' | 'openai',
	);

	if (testProvider !== 'local') {
		if (!testApiKey) {
			throw new Error(
				`[mcp-server.test] VIBERAG_TEST_API_KEY is required for provider "${testProvider}".`,
			);
		}
		config.apiKey = testApiKey;
	}

	return {
		...config,
		watch: {
			...config.watch,
			enabled: watchEnabled,
		},
	};
}

async function writeTestConfig(
	projectRoot: string,
	watchEnabled: boolean,
): Promise<void> {
	const configDir = path.join(projectRoot, '.viberag');
	await fs.mkdir(configDir, {recursive: true});

	const config = buildTestConfig(watchEnabled);

	await fs.writeFile(
		path.join(configDir, 'config.json'),
		JSON.stringify(config, null, '\t') + '\n',
	);
}

async function createIntegrationProject(
	options: IntegrationProjectOptions = {},
): Promise<IntegrationProject> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-mcp-test-'));
	await fs.cp(fixturesRoot, tempDir, {recursive: true});
	await writeTestConfig(tempDir, options.watchEnabled ?? false);

	if (options.includeLargeFile) {
		const line = 'lorem ipsum dolor sit amet';
		const content = new Array(200).fill(line).join('\n');
		const filenames = ['large-1.txt', 'large-2.txt', 'large-3.txt'];
		await Promise.all(
			filenames.map((filename, index) =>
				fs.writeFile(path.join(tempDir, filename), `${content}\n# ${index}\n`),
			),
		);
	}

	return {
		projectRoot: tempDir,
		cleanup: async () => {
			await fs.rm(tempDir, {recursive: true, force: true});
		},
	};
}

async function startMcpHarness(
	options: IntegrationProjectOptions,
): Promise<McpHarness> {
	await ensureMcpServerBuild();
	await ensureDaemonBuild();

	const project = await createIntegrationProject(options);
	const daemonProcessResult = await startDaemonProcess(project.projectRoot);
	const daemonProcess = daemonProcessResult.process;
	const daemonClient = new DaemonClient({
		projectRoot: project.projectRoot,
		autoStart: false,
		connectTimeout: 10_000,
	});

	try {
		await daemonClient.connect();
	} catch (error) {
		try {
			daemonProcess.kill('SIGTERM');
		} catch {
			// Ignore kill errors
		}
		await project.cleanup();
		throw error;
	}

	const transport = new StdioClientTransport({
		command: 'node',
		args: [mcpServerPath],
		cwd: project.projectRoot,
		env: {
			...process.env,
			NODE_ENV: 'test',
		},
		stderr: 'pipe',
	});

	const client = new Client(
		{name: 'viberag-test-client', version: '1.0.0'},
		{capabilities: {}},
	);

	try {
		await client.connect(transport);
	} catch (error) {
		try {
			await transport.close();
		} catch {
			// Ignore close errors
		}
		try {
			if (daemonClient.isConnected()) {
				await daemonClient.shutdown('mcp integration test setup failed');
			}
		} catch {
			// Ignore shutdown errors
		}
		try {
			daemonProcess.kill('SIGTERM');
		} catch {
			// Ignore kill errors
		}
		await daemonClient.disconnect().catch(() => {});
		await project.cleanup();
		throw error;
	}

	const cleanup = async () => {
		try {
			await client.close();
		} catch {
			// Ignore close errors
		}
		try {
			await transport.close();
		} catch {
			// Ignore close errors
		}
		try {
			if (daemonClient.isConnected()) {
				await daemonClient.shutdown('mcp integration test cleanup');
			}
		} catch {
			// Ignore shutdown errors
		}
		try {
			await daemonClient.disconnect();
		} catch {
			// Ignore disconnect errors
		}
		try {
			daemonProcess.kill('SIGTERM');
		} catch {
			// Ignore kill errors
		}
		try {
			await project.cleanup();
		} catch {
			// Ignore cleanup errors
		}
	};

	return {
		client,
		transport,
		daemonClient,
		daemonProcess,
		project,
		cleanup,
	};
}

function getToolText(result: unknown): {text: string; isError?: boolean} {
	const payload = result as ToolResult;
	const first = payload.content?.[0];
	if (!first?.text) {
		throw new Error('[mcp-server.test] Tool response missing text content.');
	}
	return {text: first.text, isError: payload.isError};
}

function parseToolJson<T>(result: unknown): {data: T; isError?: boolean} {
	const {text, isError} = getToolText(result);
	return {data: JSON.parse(text) as T, isError};
}

async function waitForStatus<T>(
	fetchStatus: () => Promise<T>,
	isReady: (status: T) => boolean,
	timeoutMs: number,
): Promise<T> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const status = await fetchStatus();
		if (isReady(status)) {
			return status;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}

	throw new Error('[mcp-server.test] Timed out waiting for watcher status.');
}

describe('MCP Server', () => {
	describe('Smoke Tests', () => {
		it('server module loads without initialization errors', async () => {
			// This will throw if there are circular dependency issues
			// like "Cannot access 'X' before initialization"
			const importPromise = import('../server.js');

			// Should not throw ReferenceError or other initialization errors
			await expect(importPromise).resolves.toBeDefined();
		});

		it('exports createMcpServer function', async () => {
			const serverModule = await import('../server.js');

			// Verify key exports exist
			expect(serverModule).toHaveProperty('createMcpServer');
			expect(typeof serverModule.createMcpServer).toBe('function');
		});
	});

	describe.sequential('Integration Tests', () => {
		let harness: McpHarness | null = null;
		let setupError: Error | null = null;
		let statusBeforeIndex: {
			status: string;
			message?: string;
			startup_checks?: {
				npm_update?: {status?: string};
				index?: {status?: string; message?: string | null};
			};
		} | null = null;
		let statusAfterIndex: {
			status: string;
			totalFiles?: number;
			totalSymbols?: number;
			totalChunks?: number;
			totalRefs?: number;
			embeddingProvider?: string;
			embeddingDimensions?: number;
			daemon?: {warmup?: {status?: string}};
			startup_checks?: {
				npm_update?: {status?: string};
				index?: {status?: string; message?: string | null};
			};
		} | null = null;
		let indexStats: {
			filesScanned: number;
			filesIndexed: number;
			filesNew: number;
			filesModified: number;
			filesDeleted: number;
			fileRowsUpserted: number;
			symbolRowsUpserted: number;
			chunkRowsUpserted: number;
			fileRowsDeleted: number;
			symbolRowsDeleted: number;
			chunkRowsDeleted: number;
			embeddingsComputed: number;
			embeddingsCached: number;
		} | null = null;

		beforeAll(async () => {
			try {
				harness = await startMcpHarness({
					watchEnabled: false,
					includeLargeFile: true,
				});
			} catch (error) {
				setupError = error instanceof Error ? error : new Error(String(error));
				if (requireDaemonTests) {
					throw new Error(
						`[mcp-server.test] Daemon startup failed: ${setupError.message}`,
					);
				}
				console.warn(
					`[mcp-server.test] Daemon startup failed: ${setupError.message}`,
				);
				console.warn('[mcp-server.test] Integration tests will be skipped.');
				return;
			}

			const statusBeforeResult = await harness.client.callTool({
				name: 'get_status',
				arguments: {},
			});
			statusBeforeIndex =
				parseToolJson<typeof statusBeforeIndex>(statusBeforeResult).data;

			const indexResult = await harness.client.callTool({
				name: 'build_index',
				arguments: {force: false},
			});
			indexStats = parseToolJson<typeof indexStats>(indexResult).data;

			const statusAfterResult = await harness.client.callTool({
				name: 'get_status',
				arguments: {},
			});
			statusAfterIndex =
				parseToolJson<typeof statusAfterIndex>(statusAfterResult).data;
		}, 180000);

		afterAll(async () => {
			await harness?.cleanup();
		});

		it('completes MCP initialize handshake successfully', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			// If we get here, the handshake succeeded (client.connect() would throw otherwise)
			const serverCapabilities = harness!.client.getServerCapabilities();
			expect(serverCapabilities).toBeDefined();

			const serverVersion = harness!.client.getServerVersion();
			expect(serverVersion).toBeDefined();
			expect(serverVersion?.name).toBe('viberag');
		});

		it('lists expected tools', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.listTools();

			expect(result.tools).toBeDefined();
			expect(result.tools.length).toBeGreaterThan(0);

			// Verify expected tools are registered
			const toolNames = result.tools.map(t => t.name);
			expect(toolNames).toContain('help');
			expect(toolNames).toContain('codebase_search');
			expect(toolNames).toContain('get_symbol_details');
			expect(toolNames).toContain('find_references');
			expect(toolNames).toContain('get_surrounding_code');
			expect(toolNames).toContain('read_file_lines');
			expect(toolNames).toContain('build_index');
			expect(toolNames).toContain('get_status');
			expect(toolNames).toContain('cancel_operation');
			expect(toolNames).toContain('get_watcher_status');
		});

		it('help tool returns a tool guide', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'help',
				arguments: {},
			});
			const {data, isError} = parseToolJson<{tools?: Record<string, unknown>}>(
				result,
			);
			expect(isError).toBeFalsy();
			expect(data.tools).toBeDefined();
			expect(data.tools).toHaveProperty('codebase_search');
		});

		it('reports not_indexed before indexing', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			expect(statusBeforeIndex?.status).toBe('not_indexed');
			expect(statusBeforeIndex?.message).toContain('No index found');
		});

		it('indexes the fixture via index', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			expect(indexStats?.filesScanned).toBeGreaterThan(0);
			expect(indexStats?.filesNew).toBeGreaterThan(0);
			expect(indexStats?.chunkRowsUpserted).toBeGreaterThan(0);
			expect(
				(indexStats?.embeddingsComputed ?? 0) +
					(indexStats?.embeddingsCached ?? 0),
			).toBeGreaterThan(0);
		});

		it('reports indexed status after index', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			expect(statusAfterIndex?.status).toBe('indexed');
			expect(statusAfterIndex?.totalFiles).toBeGreaterThan(0);
			expect(statusAfterIndex?.totalSymbols).toBeGreaterThan(0);
			expect(statusAfterIndex?.totalChunks).toBeGreaterThan(0);
			expect(statusAfterIndex?.totalRefs).toBeGreaterThan(0);
			expect(statusAfterIndex?.embeddingProvider).toBe(testProvider);
			expect(statusAfterIndex?.embeddingDimensions).toBeGreaterThan(0);
			expect(statusAfterIndex?.daemon?.warmup?.status).toBeDefined();
		});

		it('includes startup_checks in status payload', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}

			expect(statusBeforeIndex?.startup_checks?.index?.status).toBe(
				'not_indexed',
			);
			expect(statusAfterIndex?.startup_checks?.index?.status).toBe(
				'compatible',
			);

			// Update check is disabled under NODE_ENV=test for integration tests.
			const npmStatus = statusBeforeIndex?.startup_checks?.npm_update?.status;
			expect(npmStatus).toBe('skipped');
		});

		it('reports needs_reindex when manifest schemaVersion mismatches', async ({
			skip,
		}) => {
			if (setupError) {
				skip();
				return;
			}

			const manifestPath = path.join(
				harness!.project.projectRoot,
				'.viberag',
				'manifest-v2.json',
			);
			const original = await fs.readFile(manifestPath, 'utf-8');

			try {
				const parsed = JSON.parse(original) as Record<string, unknown>;
				const schemaVersion = Number(parsed['schemaVersion'] ?? 0);
				parsed['schemaVersion'] = Math.max(0, schemaVersion - 1);
				await fs.writeFile(
					manifestPath,
					JSON.stringify(parsed, null, 2) + '\n',
				);

				const statusResult = await harness!.client.callTool({
					name: 'get_status',
					arguments: {},
				});
				const data = parseToolJson<Record<string, unknown>>(statusResult).data;
				const v2Index = (
					data['startup_checks'] as Record<string, unknown> | null
				)?.['index'] as Record<string, unknown> | null;
				expect(v2Index?.['status']).toBe('needs_reindex');
			} finally {
				await fs.writeFile(manifestPath, original);
			}
		});

		it('search finds HttpClient definition', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'HttpClient',
					intent: 'definition',
					k: 10,
				},
			});
			const {data} = parseToolJson<{
				groups: {definitions: Array<{id: string; file_path: string}>};
			}>(result);
			expect(
				data.groups.definitions.some(r =>
					r.file_path.includes('http_client.ts'),
				),
			).toBe(true);
		});

		it('get_symbol returns a definition for HttpClient', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'HttpClient',
					intent: 'definition',
					k: 5,
				},
			});

			const search = parseToolJson<{
				groups: {definitions: Array<{id: string; file_path: string}>};
			}>(result).data;
			const first = search.groups.definitions[0];
			expect(first).toBeDefined();

			const symbolResult = await harness!.client.callTool({
				name: 'get_symbol_details',
				arguments: {symbol_id: first!.id, include_code: true},
			});
			const {data} = parseToolJson<{
				found: boolean;
				file_path: string;
				code_text?: string;
			}>(symbolResult);
			expect(data.found).toBe(true);
			expect(data.file_path).toContain('http_client.ts');
			expect(data.code_text).toBeDefined();
			expect(data.code_text).toContain('HttpClient');
		});

		it('find_usages returns refs for HttpClient', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}

			const searchResult = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {query: 'HttpClient', intent: 'definition', k: 5},
			});
			const search = parseToolJson<{
				groups: {definitions: Array<{id: string; file_path: string}>};
			}>(searchResult).data;
			const first = search.groups.definitions[0];
			expect(first).toBeDefined();

			const result = await harness!.client.callTool({
				name: 'find_references',
				arguments: {symbol_id: first!.id, k: 50},
			});
			const {data} = parseToolJson<{
				resolved: {symbol_name: string};
				by_file: Array<{file_path: string; refs: Array<{token_text: string}>}>;
			}>(result);

			expect(data.resolved.symbol_name).toBe('HttpClient');
			const file = data.by_file.find(f =>
				f.file_path.includes('src/services/http.ts'),
			);
			expect(file).toBeDefined();
			expect(file!.refs.some(r => r.token_text === 'HttpClient')).toBe(true);
		});

		it('expand_context returns neighbors for a definition hit', async ({
			skip,
		}) => {
			if (setupError) {
				skip();
				return;
			}
			const searchResult = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {query: 'HttpClient', intent: 'definition', k: 5},
			});
			const search = parseToolJson<{
				groups: {definitions: Array<{id: string; file_path: string}>};
			}>(searchResult).data;
			const first = search.groups.definitions[0];
			expect(first).toBeDefined();

			const expandedResult = await harness!.client.callTool({
				name: 'get_surrounding_code',
				arguments: {table: 'symbols', id: first!.id, limit: 10},
			});
			const {data} = parseToolJson<{
				found: boolean;
				neighbors?: unknown[];
				chunks?: unknown[];
			}>(expandedResult);
			expect(data.found).toBe(true);
			expect(Array.isArray(data.neighbors)).toBe(true);
		});

		it('search respects max_response_size', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'lorem',
					intent: 'exact_text',
					k: 50,
					explain: true,
					max_response_size: 2048,
				},
			});

			const {text} = getToolText(result);
			expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
		});

		it('rejects invalid search parameters', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			let callError: unknown = null;
			let result: ToolResult | null = null;

			try {
				result = (await harness!.client.callTool({
					name: 'codebase_search',
					arguments: {
						query: 'HttpClient',
						k: 101,
					},
				})) as ToolResult;
			} catch (error) {
				callError = error;
			}

			if (callError) {
				expect(String(callError)).toContain('k');
				return;
			}

			expect(result?.isError).toBe(true);
		});
	});

	describe.sequential('Watcher Integration', () => {
		let harness: McpHarness | null = null;
		let setupError: Error | null = null;

		beforeAll(async () => {
			try {
				harness = await startMcpHarness({watchEnabled: true});
			} catch (error) {
				setupError = error instanceof Error ? error : new Error(String(error));
				if (requireDaemonTests) {
					throw new Error(
						`[mcp-server.test] Daemon startup failed: ${setupError.message}`,
					);
				}
				console.warn(
					`[mcp-server.test] Daemon startup failed: ${setupError.message}`,
				);
				console.warn('[mcp-server.test] Watcher tests will be skipped.');
			}
		}, 120000);

		afterAll(async () => {
			await harness?.cleanup();
		});

		it('reports watcher status and reacts to file changes', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}

			const status = await waitForStatus(
				async () => {
					const result = await harness!.client.callTool({
						name: 'get_watcher_status',
						arguments: {},
					});
					return parseToolJson<{
						watching: boolean;
						filesWatched: number;
						lastIndexUpdate: string | null;
					}>(result).data;
				},
				(state: {watching: boolean; filesWatched: number}) =>
					state.watching && state.filesWatched > 0,
				30000,
			);

			const startIndexUpdate = status.lastIndexUpdate;
			const targetPath = path.join(harness!.project.projectRoot, 'math.py');
			await fs.appendFile(targetPath, '\n\n# watcher test change\n# end\n');

			const updated = await waitForStatus(
				async () => {
					const result = await harness!.client.callTool({
						name: 'get_watcher_status',
						arguments: {},
					});
					return parseToolJson<{
						lastIndexUpdate: string | null;
						indexUpToDate: boolean;
					}>(result).data;
				},
				(state: {lastIndexUpdate: string | null; indexUpToDate: boolean}) =>
					state.indexUpToDate &&
					state.lastIndexUpdate !== null &&
					state.lastIndexUpdate !== startIndexUpdate,
				60000,
			);

			expect(updated.lastIndexUpdate).not.toBe(startIndexUpdate);
		});
	});

	describe('Uninitialized Project Tests', () => {
		let transport: StdioClientTransport;
		let client: Client;
		let tempDir: string;

		beforeAll(async () => {
			await ensureMcpServerBuild();

			// Create a temporary directory WITHOUT .viberag
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-test-'));

			// Get path to the compiled MCP server entry point
			const serverPath = path.resolve(process.cwd(), 'dist/mcp/index.js');

			// Create stdio transport that spawns the MCP server in the temp directory
			transport = new StdioClientTransport({
				command: 'node',
				args: [serverPath],
				cwd: tempDir, // Run in uninitialized directory
				env: {
					...process.env,
					NODE_ENV: 'test',
				},
				stderr: 'pipe',
			});

			client = new Client(
				{name: 'viberag-test-client', version: '1.0.0'},
				{capabilities: {}},
			);

			await client.connect(transport);
		}, 30000);

		afterAll(async () => {
			try {
				await client?.close();
			} catch {
				// Ignore close errors
			}
			try {
				await transport?.close();
			} catch {
				// Ignore close errors
			}
			// Clean up temp directory
			try {
				await fs.rm(tempDir, {recursive: true, force: true});
			} catch {
				// Ignore cleanup errors
			}
		});

		it('server starts successfully in uninitialized project', async () => {
			// If we get here, the server started without crashing
			const serverVersion = client.getServerVersion();
			expect(serverVersion).toBeDefined();
			expect(serverVersion?.name).toBe('viberag');
		});

		it('status returns not_initialized with instructions', async () => {
			const result = await client.callTool({
				name: 'get_status',
				arguments: {},
			});

			expect(result).toBeDefined();

			const content = result as {content: Array<{type: string; text?: string}>};
			const firstContent = content.content[0]!;
			expect(firstContent.text).toBeDefined();

			const status = JSON.parse(firstContent.text!);

			// Should return not_initialized status
			expect(status.status).toBe('not_initialized');
			expect(status.message).toContain('not initialized');

			// Should include helpful instructions
			expect(status.instructions).toBeDefined();
			expect(status.instructions.step1).toContain('npx viberag');
			expect(status.instructions.step2).toContain('/init');
			expect(status.instructions.note).toContain('index');
		});

		it('search returns helpful error for uninitialized project', async () => {
			let callError: unknown = null;
			let result: ToolResult | null = null;

			try {
				result = (await client.callTool({
					name: 'codebase_search',
					arguments: {
						query: 'test query',
						intent: 'concept',
						k: 10,
					},
				})) as ToolResult;
			} catch (error) {
				callError = error;
			}

			if (callError) {
				expect(String(callError)).toContain('not initialized');
				return;
			}

			// Tool should return an error (isError: true)
			const content = result as ToolResult;
			expect(content.isError).toBe(true);

			// The error message should be actionable
			const firstContent = content.content[0]!;
			expect(firstContent.text).toBeDefined();
			expect(firstContent.text).toContain('not initialized');
			expect(firstContent.text).toContain('npx viberag');
		});
	});
});
