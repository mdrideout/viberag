/**
 * Daemon IPC Server
 *
 * Unix socket server for JSON-RPC 2.0 communication.
 * Handles client connections and request routing.
 */

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
	type JsonRpcRequest,
	type ErrorCode,
	parseRequest,
	formatResponse,
	formatError,
	ErrorCodes,
	MessageBuffer,
	JsonRpcParseError,
} from './protocol.js';
import type {DaemonOwner} from './owner.js';
import type {TelemetryClient} from './lib/telemetry/client.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Handler context passed to each method handler.
 */
export interface HandlerContext {
	owner: DaemonOwner;
	server: DaemonServer;
	socket: net.Socket;
	clientId: string;
}

/**
 * Handler function type.
 */
export type Handler = (
	params: Record<string, unknown> | undefined,
	ctx: HandlerContext,
) => Promise<unknown>;

/**
 * Handler registry mapping method names to handlers.
 */
export type HandlerRegistry = Record<string, Handler>;

// ============================================================================
// Daemon Server
// ============================================================================

/**
 * High-frequency daemon methods (polling/health checks) that are not
 * meaningful for product analytics when successful.
 *
 * We still capture failures for these methods.
 */
const NOISY_SUCCESS_METHODS = new Set([
	'status',
	'watchStatus',
	'ping',
	'health',
]);

type DaemonClientSource = 'cli' | 'mcp' | 'unknown';

function getClientSourceFromParams(
	params?: Record<string, unknown>,
): DaemonClientSource {
	const meta = params?.['__client'];
	if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
		return 'unknown';
	}
	const source = (meta as Record<string, unknown>)['source'];
	if (source === 'cli' || source === 'mcp' || source === 'unknown') {
		return source;
	}
	return 'unknown';
}

function stripClientMetaFromParams(
	params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!params) return undefined;
	if (!('__client' in params)) return params;
	const next: Record<string, unknown> = {...params};
	delete next['__client'];
	return next;
}

/**
 * IPC server for daemon communication.
 */
export class DaemonServer {
	private readonly socketPath: string;
	private readonly pidPath: string;
	private readonly owner: DaemonOwner;
	private telemetry: TelemetryClient | null = null;
	private handlers: HandlerRegistry = {};

	private server: net.Server | null = null;
	private clients: Map<string, net.Socket> = new Map();
	private messageBuffers: Map<string, MessageBuffer> = new Map();
	private nextClientId = 1;

	// Callbacks for lifecycle events
	onClientConnect?: (clientId: string) => void;
	onClientDisconnect?: (clientId: string, remainingCount: number) => void;
	/** Called on each request for activity-based timeout */
	onActivity?: () => void;

	constructor(owner: DaemonOwner) {
		this.owner = owner;
		this.socketPath = owner.getSocketPath();
		this.pidPath = owner.getPidPath();
	}

	setTelemetry(telemetry: TelemetryClient): void {
		this.telemetry = telemetry;
	}

	/**
	 * Register method handlers.
	 */
	setHandlers(handlers: HandlerRegistry): void {
		this.handlers = handlers;
	}

	/**
	 * Check if a socket is connectable (live daemon responding).
	 */
	private isSocketLive(socketPath: string, timeout = 1000): Promise<boolean> {
		return new Promise(resolve => {
			const socket = net.createConnection(socketPath);

			const timer = setTimeout(() => {
				socket.destroy();
				resolve(false);
			}, timeout);

			socket.on('connect', () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(true);
			});

			socket.on('error', () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
	}

	/**
	 * Start the server.
	 */
	async start(): Promise<void> {
		// Ensure global run directory exists (avoid writing inside project folder)
		const runDir = path.dirname(this.pidPath);
		await fs.mkdir(runDir, {recursive: true});

		// Clean up stale socket file if it exists
		// Note: We hold the daemon lock at this point, so any existing socket is stale.
		// Safety check: verify socket is not connectable before deleting
		try {
			await fs.access(this.socketPath);
			// Socket file exists - verify it's stale by trying to connect
			const isLive = await this.isSocketLive(this.socketPath);
			if (isLive) {
				// This should never happen if lock is working correctly
				throw new Error(
					'Socket is still connectable - another daemon may be running despite lock',
				);
			}
			// Socket is stale, safe to delete
			await fs.unlink(this.socketPath);
			console.error('[daemon] Cleaned up stale socket file');
		} catch (err) {
			// File doesn't exist or other error - continue
			if (
				err instanceof Error &&
				err.message.includes('another daemon may be running')
			) {
				throw err;
			}
		}

		// Write PID file
		await fs.writeFile(this.pidPath, String(process.pid));

		// Create server
		this.server = net.createServer(socket => this.handleConnection(socket));

		// Listen on socket
		await new Promise<void>((resolve, reject) => {
			this.server!.on('error', reject);
			this.server!.listen(this.socketPath, () => {
				this.server!.removeListener('error', reject);
				resolve();
			});
		});

		console.error(`[daemon] Listening on ${this.socketPath}`);
	}

	/**
	 * Stop the server.
	 */
	async stop(): Promise<void> {
		// Close all client connections
		for (const socket of this.clients.values()) {
			socket.destroy();
		}
		this.clients.clear();
		this.messageBuffers.clear();

		// Close server
		if (this.server) {
			await new Promise<void>(resolve => {
				this.server!.close(() => resolve());
			});
			this.server = null;
		}

		// Clean up files
		try {
			await fs.unlink(this.socketPath);
		} catch {
			// Ignore
		}
		try {
			await fs.unlink(this.pidPath);
		} catch {
			// Ignore
		}

		console.error('[daemon] Server stopped');
	}

	/**
	 * Get the number of connected clients.
	 */
	getClientCount(): number {
		return this.clients.size;
	}

	/**
	 * Handle new client connection.
	 */
	private handleConnection(socket: net.Socket): void {
		const clientId = `client-${this.nextClientId++}`;

		this.clients.set(clientId, socket);
		this.messageBuffers.set(clientId, new MessageBuffer());

		console.error(`[daemon] Client connected: ${clientId}`);
		this.onClientConnect?.(clientId);

		socket.on('data', data => {
			this.handleData(clientId, socket, data);
		});

		socket.on('close', () => {
			this.handleDisconnect(clientId);
		});

		socket.on('error', error => {
			console.error(`[daemon] Socket error for ${clientId}:`, error.message);
			this.handleDisconnect(clientId);
		});
	}

	/**
	 * Handle incoming data from client.
	 */
	private handleData(clientId: string, socket: net.Socket, data: Buffer): void {
		const buffer = this.messageBuffers.get(clientId);
		if (!buffer) return;

		// Extract complete messages
		const messages = buffer.append(data.toString());

		// Process each message
		for (const message of messages) {
			this.handleMessage(clientId, socket, message);
		}
	}

	/**
	 * Handle a single JSON-RPC message.
	 */
	private async handleMessage(
		clientId: string,
		socket: net.Socket,
		message: string,
	): Promise<void> {
		const startedAt = Date.now();
		// Record activity for timeout management
		this.onActivity?.();

		let request: JsonRpcRequest;

		try {
			request = parseRequest(message);
		} catch (error) {
			if (error instanceof JsonRpcParseError) {
				socket.write(formatError(null, ErrorCodes.PARSE_ERROR, error.message));
			} else {
				socket.write(
					formatError(null, ErrorCodes.INTERNAL_ERROR, 'Parse error'),
				);
			}
			return;
		}

		// Find handler
		const handler = this.handlers[request.method];
		if (!handler) {
			socket.write(
				formatError(
					request.id,
					ErrorCodes.METHOD_NOT_FOUND,
					`Method not found: ${request.method}`,
				),
			);
			return;
		}

		// Execute handler
		try {
			const ctx: HandlerContext = {
				owner: this.owner,
				server: this,
				socket,
				clientId,
			};

			const result = await handler(request.params, ctx);
			socket.write(formatResponse(request.id, result));

			if (this.telemetry) {
				const clientSource = getClientSourceFromParams(request.params);
				// MCP already captures tool-level telemetry, so avoid double-counting.
				if (clientSource === 'mcp') return;

				// Avoid spamming PostHog with high-frequency polling methods.
				// Still capture failures in the catch() below.
				if (NOISY_SUCCESS_METHODS.has(request.method)) return;

				void this.telemetry
					.captureOperation({
						operation_kind: 'daemon_method',
						name: request.method,
						input: stripClientMetaFromParams(request.params) ?? null,
						output: result,
						success: true,
						duration_ms: Date.now() - startedAt,
					})
					.catch(() => {});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = ((error as {code?: number}).code ??
				ErrorCodes.INTERNAL_ERROR) as ErrorCode;

			// Centralized error logging - log to both stderr and debug.log
			// Pass Error object (not just message) to preserve stack trace
			console.error(`[daemon] Handler error (${request.method}):`, error);
			const logger = this.owner.getLogger();
			if (logger) {
				logger.error(
					'DaemonServer',
					`Handler error: ${request.method}`,
					error instanceof Error ? error : new Error(message),
				);
			}

			socket.write(formatError(request.id, code, message));

			if (this.telemetry) {
				const clientSource = getClientSourceFromParams(request.params);
				// MCP already captures tool-level telemetry, so avoid double-counting.
				if (clientSource === 'mcp') return;

				void this.telemetry
					.captureOperation({
						operation_kind: 'daemon_method',
						name: request.method,
						input: stripClientMetaFromParams(request.params) ?? null,
						output: null,
						success: false,
						duration_ms: Date.now() - startedAt,
						error:
							error instanceof Error
								? {name: error.name, message: error.message, stack: error.stack}
								: {message},
					})
					.catch(() => {});
			}
		}
	}

	/**
	 * Handle client disconnect.
	 */
	private handleDisconnect(clientId: string): void {
		this.clients.delete(clientId);
		this.messageBuffers.delete(clientId);

		const remaining = this.clients.size;
		console.error(
			`[daemon] Client disconnected: ${clientId} (${remaining} remaining)`,
		);

		this.onClientDisconnect?.(clientId, remaining);
	}
}
