import {describe, it, expect} from 'vitest';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import {DaemonServer} from '../server.js';

function createSocketPath(): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\viberag-daemon-telemetry-${crypto.randomUUID()}`;
	}
	return path.join(
		os.tmpdir(),
		`viberag-daemon-telemetry-${crypto.randomUUID()}.sock`,
	);
}

async function sendJsonRpcRequest(args: {
	socketPath: string;
	request: unknown;
}): Promise<unknown> {
	const socket = net.createConnection(args.socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once('connect', () => resolve());
		socket.once('error', err => reject(err));
	});

	const responsePromise = new Promise<unknown>((resolve, reject) => {
		let buffer = '';
		socket.on('data', data => {
			buffer += data.toString('utf8');
			const idx = buffer.indexOf('\n');
			if (idx === -1) return;
			const line = buffer.slice(0, idx);
			try {
				resolve(JSON.parse(line) as unknown);
			} catch (err) {
				reject(err);
			} finally {
				socket.destroy();
			}
		});
		socket.once('error', err => reject(err));
	});

	socket.write(`${JSON.stringify(args.request)}\n`);
	return responsePromise;
}

describe('DaemonServer telemetry', () => {
	it('captures daemon_method telemetry for mcp clients (output omitted)', async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), 'viberag-daemon-telemetry-test-'),
		);
		const pidPath = path.join(tempDir, 'daemon.pid');
		const socketPath = createSocketPath();

		const captured: unknown[] = [];
		let resolveCapture: ((value: unknown) => void) | null = null;
		const capturePromise = new Promise<unknown>(resolve => {
			resolveCapture = resolve;
		});

		const server = new DaemonServer({
			getSocketPath: () => socketPath,
			getPidPath: () => pidPath,
			getLogger: () => null,
		} as never);

		server.setTelemetry({
			captureOperation: async op => {
				captured.push(op);
				resolveCapture?.(op);
				return 'test_request_id';
			},
			capture: () => {},
			shutdown: async () => {},
		});
		server.setHandlers({
			search: async () => ({ok: true}),
		});

		try {
			await server.start();

			const response = await sendJsonRpcRequest({
				socketPath,
				request: {
					jsonrpc: '2.0',
					method: 'search',
					params: {query: 'embedding provider', __client: {source: 'mcp'}},
					id: 1,
				},
			});

			expect(response).toMatchObject({
				jsonrpc: '2.0',
				id: 1,
				result: {ok: true},
			});

			const op = (await capturePromise) as Record<string, unknown>;
			expect(op['operation_kind']).toBe('daemon_method');
			expect(op['name']).toBe('search');
			expect(op['success']).toBe(true);
			expect(op['output']).toBeNull();
			expect(op['input']).toMatchObject({
				__client_source: 'mcp',
				query: 'embedding provider',
			});
		} finally {
			await server.stop().catch(() => {});
			await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
		}

		expect(captured.length).toBeGreaterThanOrEqual(1);
	});

	it('captures daemon_method telemetry for cli clients (output included)', async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), 'viberag-daemon-telemetry-test-'),
		);
		const pidPath = path.join(tempDir, 'daemon.pid');
		const socketPath = createSocketPath();

		let resolveCapture: ((value: unknown) => void) | null = null;
		const capturePromise = new Promise<unknown>(resolve => {
			resolveCapture = resolve;
		});

		const server = new DaemonServer({
			getSocketPath: () => socketPath,
			getPidPath: () => pidPath,
			getLogger: () => null,
		} as never);

		server.setTelemetry({
			captureOperation: async op => {
				resolveCapture?.(op);
				return 'test_request_id';
			},
			capture: () => {},
			shutdown: async () => {},
		});
		server.setHandlers({
			search: async () => ({ok: true}),
		});

		try {
			await server.start();

			const response = await sendJsonRpcRequest({
				socketPath,
				request: {
					jsonrpc: '2.0',
					method: 'search',
					params: {query: 'embed(', __client: {source: 'cli'}},
					id: 1,
				},
			});

			expect(response).toMatchObject({
				jsonrpc: '2.0',
				id: 1,
				result: {ok: true},
			});

			const op = (await capturePromise) as Record<string, unknown>;
			expect(op['operation_kind']).toBe('daemon_method');
			expect(op['name']).toBe('search');
			expect(op['success']).toBe(true);
			expect(op['output']).toEqual({ok: true});
			expect(op['input']).toMatchObject({
				__client_source: 'cli',
				query: 'embed(',
			});
		} finally {
			await server.stop().catch(() => {});
			await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
		}
	});
});
