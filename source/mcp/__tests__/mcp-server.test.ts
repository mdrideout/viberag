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
		} | null = null;
		let statusAfterIndex: {
			status: string;
			totalFiles?: number;
			totalChunks?: number;
			embeddingProvider?: string;
			embeddingDimensions?: number;
			warmup?: {status?: string};
		} | null = null;
		let indexStats: {
			filesScanned: number;
			filesNew: number;
			filesModified: number;
			filesDeleted: number;
			chunksAdded: number;
			chunksDeleted: number;
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
				name: 'viberag_status',
				arguments: {},
			});
			statusBeforeIndex =
				parseToolJson<typeof statusBeforeIndex>(statusBeforeResult).data;

			const indexResult = await harness.client.callTool({
				name: 'viberag_index',
				arguments: {force: false},
			});
			indexStats = parseToolJson<typeof indexStats>(indexResult).data;

			const statusAfterResult = await harness.client.callTool({
				name: 'viberag_status',
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
			expect(toolNames).toContain('codebase_search');
			expect(toolNames).toContain('codebase_parallel_search');
			expect(toolNames).toContain('viberag_index');
			expect(toolNames).toContain('viberag_status');
			expect(toolNames).toContain('viberag_cancel');
			expect(toolNames).toContain('viberag_watch_status');
		});

		it('reports not_indexed before indexing', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			expect(statusBeforeIndex?.status).toBe('not_indexed');
			expect(statusBeforeIndex?.message).toContain('No index found');
		});

		it('indexes the fixture via viberag_index', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			expect(indexStats?.filesScanned).toBeGreaterThan(0);
			expect(indexStats?.filesNew).toBeGreaterThan(0);
			expect(indexStats?.chunksAdded).toBeGreaterThan(0);
			expect(
				(indexStats?.embeddingsComputed ?? 0) +
					(indexStats?.embeddingsCached ?? 0),
			).toBeGreaterThan(0);
		});

		it('reports indexed status after viberag_index', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			expect(statusAfterIndex?.status).toBe('indexed');
			expect(statusAfterIndex?.totalFiles).toBeGreaterThan(0);
			expect(statusAfterIndex?.totalChunks).toBeGreaterThan(0);
			expect(statusAfterIndex?.embeddingProvider).toBe(testProvider);
			expect(statusAfterIndex?.embeddingDimensions).toBeGreaterThan(0);
			expect(statusAfterIndex?.warmup?.status).toBeDefined();
		});

		it('codebase_search finds HttpClient definition', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'HttpClient',
					mode: 'definition',
					symbol_name: 'HttpClient',
					limit: 5,
				},
			});
			const {data} = parseToolJson<{
				results: Array<{filepath: string}>;
			}>(result);
			expect(
				data.results.some(r => r.filepath.includes('http_client.ts')),
			).toBe(true);
		});

		it('codebase_search applies exported filters', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'UserService',
					mode: 'definition',
					symbol_name: 'UserService',
					filters: {
						extension: ['.ts'],
						is_exported: true,
					},
				},
			});

			const {data} = parseToolJson<{
				results: Array<{filepath: string; isExported?: boolean}>;
			}>(result);
			expect(data.results.length).toBeGreaterThan(0);
			expect(
				data.results.every(
					r => r.filepath.includes('exported.ts') && r.isExported === true,
				),
			).toBe(true);
		});

		it('codebase_search applies decorator and docstring filters', async ({
			skip,
		}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'process_data',
					mode: 'definition',
					symbol_name: 'process_data',
					filters: {
						extension: ['.py'],
						decorator_contains: 'log_call',
						has_docstring: true,
					},
				},
			});
			const {data} = parseToolJson<{
				results: Array<{filepath: string; name?: string}>;
			}>(result);
			expect(
				data.results.some(
					r =>
						r.filepath.includes('decorators.py') && r.name === 'process_data',
				),
			).toBe(true);
		});

		it('codebase_search respects max_response_size', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'lorem',
					mode: 'exact',
					limit: 20,
					max_response_size: 1024,
				},
			});
			const {data} = parseToolJson<{
				resultCount: number;
				originalResultCount?: number;
				reducedForSize?: boolean;
			}>(result);
			expect(data.reducedForSize).toBe(true);
			expect(data.originalResultCount).toBeGreaterThan(data.resultCount);
		});

		it('codebase_parallel_search merges results', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await harness!.client.callTool({
				name: 'codebase_parallel_search',
				arguments: {
					searches: [
						{query: 'HttpClient', mode: 'definition', limit: 5},
						{query: 'UserService', mode: 'definition', limit: 5},
					],
					merge_results: true,
					merge_strategy: 'dedupe',
					merged_limit: 10,
				},
			});
			const {data} = parseToolJson<{
				searchCount: number;
				individual: Array<{
					resultCount: number;
					results: Array<{filepath: string}>;
				}>;
				merged?: {
					strategy: string;
					resultCount: number;
					results: Array<{filepath: string}>;
				};
			}>(result);
			expect(data.searchCount).toBe(2);
			expect(data.individual.length).toBe(2);
			expect(data.merged?.strategy).toBe('dedupe');
			expect(data.merged?.resultCount).toBeGreaterThan(0);
			expect(
				data.merged?.results.some(r => r.filepath.includes('http_client.ts')),
			).toBe(true);
			expect(
				data.merged?.results.some(r => r.filepath.includes('exported.ts')),
			).toBe(true);
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
						limit: 101,
					},
				})) as ToolResult;
			} catch (error) {
				callError = error;
			}

			if (callError) {
				expect(String(callError)).toContain('limit');
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
						name: 'viberag_watch_status',
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
						name: 'viberag_watch_status',
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

		it('viberag_status returns not_initialized with instructions', async () => {
			const result = await client.callTool({
				name: 'viberag_status',
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
			expect(status.instructions.providers).toContain('Gemini');
		});

		it('codebase_search returns helpful error for uninitialized project', async () => {
			const result = await client.callTool({
				name: 'codebase_search',
				arguments: {
					query: 'test query',
					mode: 'hybrid',
					limit: 10,
					auto_boost: true,
					auto_boost_threshold: 0.3,
					max_response_size: 51200,
				},
			});

			// Tool should return an error (isError: true)
			const content = result as {
				content: Array<{type: string; text?: string}>;
				isError?: boolean;
			};

			// The error message should guide users to viberag_status
			const firstContent = content.content[0]!;
			expect(firstContent.text).toBeDefined();
			expect(firstContent.text).toContain('not initialized');
			expect(firstContent.text).toContain('viberag_status');
		});
	});
});
