/**
 * Daemon Connection Manager
 *
 * Low-level socket connection with message buffering and request/response handling.
 */

import * as net from 'node:net';
import {EventEmitter} from 'node:events';
import {MessageBuffer} from '../daemon/protocol.js';

// ============================================================================
// Types
// ============================================================================

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
	jsonrpc: '2.0';
	id?: number | string;
	method?: string;
	result?: unknown;
	error?: {code: number; message: string; data?: unknown};
	params?: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

/** Default request timeout */
const REQUEST_TIMEOUT_MS = 30000;

// ============================================================================
// Connection Class
// ============================================================================

/**
 * Socket connection with JSON-RPC message handling.
 *
 * Events:
 * - 'connect': Socket connected
 * - 'disconnect': Socket disconnected (reason: string)
 * - 'notification': Push notification received (method: string, params: unknown)
 * - 'error': Error occurred (error: Error)
 */
export class DaemonConnection extends EventEmitter {
	private readonly socketPath: string;
	private socket: net.Socket | null = null;
	private buffer: MessageBuffer;
	private requestId = 0;
	private pendingRequests: Map<number | string, PendingRequest> = new Map();
	private connected = false;

	constructor(socketPath: string) {
		super();
		this.socketPath = socketPath;
		this.buffer = new MessageBuffer();
	}

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return this.connected && this.socket !== null && !this.socket.destroyed;
	}

	/**
	 * Connect to the daemon socket.
	 */
	async connect(timeout: number = 5000): Promise<void> {
		if (this.isConnected()) {
			return;
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.socket?.destroy();
				reject(new Error(`Connection timeout after ${timeout}ms`));
			}, timeout);

			this.socket = net.createConnection(this.socketPath);

			this.socket.on('connect', () => {
				clearTimeout(timer);
				this.connected = true;
				this.buffer.clear();
				this.emit('connect');
				resolve();
			});

			this.socket.on('data', data => {
				this.handleData(data);
			});

			this.socket.on('close', () => {
				const wasConnected = this.connected;
				this.connected = false;
				this.rejectPendingRequests(new Error('Connection closed'));

				if (wasConnected) {
					this.emit('disconnect', 'socket closed');
				}
			});

			this.socket.on('error', error => {
				clearTimeout(timer);
				this.connected = false;

				if (!this.connected) {
					// Connection failed
					reject(error);
				} else {
					// Error after connected
					this.emit('error', error);
				}
			});
		});
	}

	/**
	 * Disconnect from the daemon.
	 */
	disconnect(): void {
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
		this.connected = false;
		this.rejectPendingRequests(new Error('Disconnected'));
		this.buffer.clear();
	}

	/**
	 * Send a request and wait for response.
	 */
	async request(
		method: string,
		params?: Record<string, unknown>,
		timeout: number = REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		if (!this.isConnected()) {
			throw new Error('Not connected');
		}

		const id = ++this.requestId;
		const request = {
			jsonrpc: '2.0' as const,
			method,
			params,
			id,
		};

		return new Promise((resolve, reject) => {
			// Set up timeout
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request timeout: ${method}`));
			}, timeout);

			// Store pending request
			this.pendingRequests.set(id, {resolve, reject, timer});

			// Send request
			const message = JSON.stringify(request) + '\n';
			this.socket!.write(message, err => {
				if (err) {
					clearTimeout(timer);
					this.pendingRequests.delete(id);
					reject(err);
				}
			});
		});
	}

	/**
	 * Handle incoming data.
	 */
	private handleData(data: Buffer): void {
		const messages = this.buffer.append(data.toString());

		for (const message of messages) {
			try {
				const parsed = JSON.parse(message) as JsonRpcMessage;
				this.handleMessage(parsed);
			} catch {
				this.emit('error', new Error(`Failed to parse message: ${message}`));
			}
		}
	}

	/**
	 * Handle a parsed JSON-RPC message.
	 */
	private handleMessage(msg: JsonRpcMessage): void {
		if (msg.id !== undefined) {
			// Response to a request
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				this.pendingRequests.delete(msg.id);
				clearTimeout(pending.timer);

				if (msg.error) {
					pending.reject(
						new Error(msg.error.message || `Error ${msg.error.code}`),
					);
				} else {
					pending.resolve(msg.result);
				}
			}
		} else if (msg.method) {
			// Push notification
			this.emit('notification', msg.method, msg.params);
		}
	}

	/**
	 * Reject all pending requests.
	 */
	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}
