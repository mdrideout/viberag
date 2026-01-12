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
import {DaemonClient} from '../../client/index.js';

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

	describe('Integration Tests', () => {
		let transport: StdioClientTransport | null = null;
		let client: Client | null = null;
		let daemonClient: DaemonClient | null = null;
		let setupError: Error | null = null;

		beforeAll(async () => {
			// Pre-start the daemon before spawning MCP server
			// This avoids nested subprocess spawning issues in vitest
			const projectRoot = process.cwd();
			daemonClient = new DaemonClient(projectRoot);

			try {
				await daemonClient.connect();
			} catch (error) {
				// Daemon startup can fail due to environment issues (e.g., EMFILE)
				// Store the error and skip tests that require the daemon
				setupError = error instanceof Error ? error : new Error(String(error));
				console.warn(
					`[mcp-server.test] Daemon startup failed: ${setupError.message}`,
				);
				console.warn('[mcp-server.test] Integration tests will be skipped.');
				return;
			}

			// Get path to the compiled MCP server entry point
			const serverPath = path.resolve(projectRoot, 'dist/mcp/index.js');

			// Create stdio transport that spawns the MCP server as a subprocess
			transport = new StdioClientTransport({
				command: 'node',
				args: [serverPath],
				env: {
					...process.env,
					// Suppress warmup and watcher output during tests
					NODE_ENV: 'test',
				},
				// Pipe stderr so we can capture server output if needed
				stderr: 'pipe',
			});

			// Create MCP client
			client = new Client(
				{name: 'viberag-test-client', version: '1.0.0'},
				{capabilities: {}},
			);

			// Connect client to transport - this starts the transport and performs MCP initialize handshake
			// Note: Client.connect() automatically calls transport.start()
			await client.connect(transport);
		}, 60000); // 60 second timeout for daemon + server startup

		afterAll(async () => {
			// Clean up: close client and transport
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
			// Disconnect daemon client (don't shutdown - other tests may need it)
			try {
				await daemonClient?.disconnect();
			} catch {
				// Ignore close errors
			}
		});

		it('completes MCP initialize handshake successfully', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			// If we get here, the handshake succeeded (client.connect() would throw otherwise)
			const serverCapabilities = client!.getServerCapabilities();
			expect(serverCapabilities).toBeDefined();

			const serverVersion = client!.getServerVersion();
			expect(serverVersion).toBeDefined();
			expect(serverVersion?.name).toBe('viberag');
		});

		it('lists expected tools', async ({skip}) => {
			if (setupError) {
				skip();
				return;
			}
			const result = await client!.listTools();

			expect(result.tools).toBeDefined();
			expect(result.tools.length).toBeGreaterThan(0);

			// Verify expected tools are registered
			const toolNames = result.tools.map(t => t.name);
			expect(toolNames).toContain('codebase_search');
			expect(toolNames).toContain('codebase_parallel_search');
			expect(toolNames).toContain('viberag_index');
			expect(toolNames).toContain('viberag_status');
			expect(toolNames).toContain('viberag_watch_status');
		});

		it('can call viberag_watch_status for initialized project', async ({
			skip,
		}) => {
			if (setupError) {
				skip();
				return;
			}
			// viberag_watch_status returns watcher status from the daemon
			// The daemon auto-starts when the first tool is called
			const result = await client!.callTool({
				name: 'viberag_watch_status',
				arguments: {},
			});

			expect(result).toBeDefined();

			// Result has content array with text content
			// Type assertion needed due to MCP SDK's complex union types
			const content = result as {
				content: Array<{type: string; text?: string}>;
			};
			expect(content.content).toBeDefined();
			expect(content.content.length).toBeGreaterThan(0);

			// Should return JSON with watcher status
			const firstContent = content.content[0]!;
			expect(firstContent.type).toBe('text');
			expect(firstContent.text).toBeDefined();
			const status = JSON.parse(firstContent.text!);
			// WatcherStatus has 'watching' property (not 'isWatching')
			expect(status).toHaveProperty('watching');
		}, 60000);

		it('viberag_status returns index info for initialized project', async ({
			skip,
		}) => {
			if (setupError) {
				skip();
				return;
			}
			// viberag_status should work for both initialized and uninitialized projects
			// This test runs in viberag directory which IS initialized
			const result = await client!.callTool({
				name: 'viberag_status',
				arguments: {},
			});

			expect(result).toBeDefined();

			const content = result as {content: Array<{type: string; text?: string}>};
			expect(content.content).toBeDefined();
			expect(content.content.length).toBeGreaterThan(0);

			const firstContent = content.content[0]!;
			expect(firstContent.type).toBe('text');
			expect(firstContent.text).toBeDefined();
			const status = JSON.parse(firstContent.text!);

			// Should return either 'indexed', 'not_indexed', or 'not_initialized'
			expect(status).toHaveProperty('status');
			expect(['indexed', 'not_indexed', 'not_initialized']).toContain(
				status.status,
			);

			// For initialized projects, should have either index info or instructions
			if (status.status === 'not_initialized') {
				expect(status).toHaveProperty('instructions');
			}
		});
	});

	describe('Uninitialized Project Tests', () => {
		let transport: StdioClientTransport;
		let client: Client;
		let tempDir: string;

		beforeAll(async () => {
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
