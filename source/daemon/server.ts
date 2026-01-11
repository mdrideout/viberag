/**
 * Daemon IPC Server
 *
 * Unix socket server for JSON-RPC 2.0 communication.
 * Handles client connections, request routing, and notifications.
 */

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
	type JsonRpcRequest,
	type DaemonNotification,
	type ErrorCode,
	parseRequest,
	formatResponse,
	formatError,
	formatNotification,
	ErrorCodes,
	MessageBuffer,
	JsonRpcParseError,
} from './protocol.js';
import type {DaemonOwner} from './owner.js';

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
 * IPC server for daemon communication.
 */
export class DaemonServer {
	private readonly socketPath: string;
	private readonly pidPath: string;
	private readonly owner: DaemonOwner;
	private handlers: HandlerRegistry = {};

	private server: net.Server | null = null;
	private clients: Map<string, net.Socket> = new Map();
	private subscribedClients: Set<string> = new Set();
	private messageBuffers: Map<string, MessageBuffer> = new Map();
	private nextClientId = 1;

	// Callbacks for lifecycle events
	onClientConnect?: (clientId: string) => void;
	onClientDisconnect?: (clientId: string, remainingCount: number) => void;

	constructor(owner: DaemonOwner) {
		this.owner = owner;
		this.socketPath = owner.getSocketPath();
		this.pidPath = owner.getPidPath();
	}

	/**
	 * Register method handlers.
	 */
	setHandlers(handlers: HandlerRegistry): void {
		this.handlers = handlers;
	}

	/**
	 * Start the server.
	 */
	async start(): Promise<void> {
		// Ensure .viberag directory exists
		const viberagDir = path.dirname(this.socketPath);
		await fs.mkdir(viberagDir, {recursive: true});

		// Clean up stale socket file if it exists
		try {
			await fs.unlink(this.socketPath);
		} catch {
			// Ignore - file may not exist
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
		// Broadcast shutdown notification
		this.broadcastToSubscribed('shuttingDown', {reason: 'server stopping'});

		// Close all client connections
		for (const socket of this.clients.values()) {
			socket.destroy();
		}
		this.clients.clear();
		this.subscribedClients.clear();
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
	 * Broadcast a notification to all subscribed clients.
	 */
	broadcastToSubscribed(
		method: DaemonNotification,
		params?: Record<string, unknown>,
	): void {
		const message = formatNotification(method, params);
		for (const clientId of this.subscribedClients) {
			const socket = this.clients.get(clientId);
			if (socket && !socket.destroyed) {
				socket.write(message);
			}
		}
	}

	/**
	 * Broadcast a notification to all connected clients.
	 */
	broadcast(
		method: DaemonNotification,
		params?: Record<string, unknown>,
	): void {
		const message = formatNotification(method, params);
		for (const socket of this.clients.values()) {
			if (!socket.destroyed) {
				socket.write(message);
			}
		}
	}

	/**
	 * Subscribe a client to push notifications.
	 */
	subscribeClient(clientId: string): void {
		this.subscribedClients.add(clientId);
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
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = ((error as {code?: number}).code ??
				ErrorCodes.INTERNAL_ERROR) as ErrorCode;
			socket.write(formatError(request.id, code, message));
		}
	}

	/**
	 * Handle client disconnect.
	 */
	private handleDisconnect(clientId: string): void {
		this.clients.delete(clientId);
		this.subscribedClients.delete(clientId);
		this.messageBuffers.delete(clientId);

		const remaining = this.clients.size;
		console.error(
			`[daemon] Client disconnected: ${clientId} (${remaining} remaining)`,
		);

		this.onClientDisconnect?.(clientId, remaining);
	}
}
