import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

type ToolResult = {
	content: Array<{type: string; text?: string}>;
	isError?: boolean;
};

function parseJsonToolResult<T>(result: unknown): {data: T; isError?: boolean} {
	const payload = result as ToolResult;
	const text = payload.content?.[0]?.text;
	if (!text) {
		throw new Error(
			'[mcp-uninitialized-smoke.test] Missing tool text content.',
		);
	}
	return {data: JSON.parse(text) as T, isError: payload.isError};
}

describe('MCP Uninitialized Smoke', () => {
	let tempDir = '';
	let transport: StdioClientTransport;
	let client: Client;

	beforeAll(async () => {
		const serverPath = path.resolve(process.cwd(), 'dist/mcp/index.js');
		await fs.access(serverPath);

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-mcp-smoke-'));
		transport = new StdioClientTransport({
			command: 'node',
			args: [serverPath],
			cwd: tempDir,
			env: {
				...process.env,
				NODE_ENV: 'test',
				VIBERAG_SKIP_UPDATE_CHECK: '1',
			},
			stderr: 'pipe',
		});

		client = new Client(
			{name: 'viberag-smoke-client', version: '1.0.0'},
			{capabilities: {}},
		);
		await client.connect(transport);
	});

	afterAll(async () => {
		try {
			await client?.close();
		} catch {
			// Ignore close errors in cleanup
		}
		try {
			await transport?.close();
		} catch {
			// Ignore close errors in cleanup
		}
		if (tempDir) {
			await fs.rm(tempDir, {recursive: true, force: true});
		}
	});

	it('returns not_initialized status with setup instructions', async () => {
		const result = await client.callTool({
			name: 'get_status',
			arguments: {},
		});
		const {data, isError} = parseJsonToolResult<{
			status: string;
			message?: string;
			instructions?: {
				step1?: string;
				step2?: string;
			};
		}>(result);

		expect(isError).toBeFalsy();
		expect(data.status).toBe('not_initialized');
		expect(data.message).toContain('not initialized');
		expect(data.instructions?.step1).toContain('npx viberag');
		expect(data.instructions?.step2).toContain('/init');
	});
});
