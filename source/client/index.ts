/**
 * Daemon Client
 *
 * High-level client for daemon communication.
 * Provides typed API methods and handles connection lifecycle.
 *
 * Features:
 * - Auto-starts daemon if not running
 * - Reconnection with exponential backoff
 * - Push notification handling
 * - Typed method wrappers
 */

import {EventEmitter} from 'node:events';
import {DaemonConnection} from './connection.js';
import {
	ensureDaemonRunning,
	isDaemonRunning,
	getSocketPath,
} from './auto-start.js';
import {store, IndexingActions, SlotProgressActions} from '../store/index.js';
import type {
	DaemonClientOptions,
	ConnectionState,
	ClientSearchOptions,
	ClientIndexOptions,
	DaemonStatusResponse,
	PingResponse,
	SearchResults,
	IndexStats,
	WatcherStatus,
	IndexProgressEvent,
	IndexCompleteEvent,
	ShuttingDownEvent,
} from './types.js';
import {PROTOCOL_VERSION} from '../daemon/protocol.js';

// ============================================================================
// Constants
// ============================================================================

/** Reconnection delays (exponential backoff) */
const RECONNECT_DELAYS = [100, 500, 1000, 2000];

// ============================================================================
// DaemonClient
// ============================================================================

/**
 * Client for communicating with the VibeRAG daemon.
 *
 * Events:
 * - 'connect': Connected to daemon
 * - 'disconnect': Disconnected (reason: string)
 * - 'reconnect': Successfully reconnected
 * - 'reconnectFailed': Failed to reconnect after all attempts
 * - 'error': Error occurred (error: Error)
 * - 'indexProgress': Index progress update (event: IndexProgressEvent)
 * - 'indexComplete': Indexing completed (event: IndexCompleteEvent)
 * - 'watcherEvent': File watcher event (event: WatcherEvent)
 * - 'shuttingDown': Daemon shutting down (event: ShuttingDownEvent)
 */
export class DaemonClient extends EventEmitter {
	private readonly projectRoot: string;
	private readonly socketPath: string;
	private readonly autoStart: boolean;
	private readonly connectTimeout: number;
	private readonly reconnectAttempts: number;

	private connection: DaemonConnection | null = null;
	private state: ConnectionState = 'disconnected';
	private reconnecting = false;
	private closed = false;
	private connectPromise: Promise<void> | null = null;

	constructor(options: DaemonClientOptions | string) {
		super();

		// Handle simple string constructor
		if (typeof options === 'string') {
			this.projectRoot = options;
			this.autoStart = true;
			this.connectTimeout = 5000;
			this.reconnectAttempts = 3;
		} else {
			this.projectRoot = options.projectRoot;
			this.autoStart = options.autoStart ?? true;
			this.connectTimeout = options.connectTimeout ?? 5000;
			this.reconnectAttempts = options.reconnectAttempts ?? 3;
		}

		this.socketPath = getSocketPath(this.projectRoot);
	}

	// ==========================================================================
	// Connection Management
	// ==========================================================================

	/**
	 * Get current connection state.
	 */
	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return (
			this.state === 'connected' && this.connection?.isConnected() === true
		);
	}

	/**
	 * Connect to the daemon.
	 * Auto-starts daemon if not running (when autoStart is true).
	 * Safe for concurrent calls - will reuse in-flight connection attempt.
	 */
	async connect(): Promise<void> {
		if (this.isConnected()) {
			return;
		}

		// Reuse existing connection attempt if one is in progress
		if (this.connectPromise) {
			return this.connectPromise;
		}

		this.connectPromise = this.doConnect();

		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = null;
		}
	}

	/**
	 * Internal connection logic.
	 */
	private async doConnect(): Promise<void> {
		this.state = 'connecting';
		this.closed = false;

		try {
			// Auto-start daemon if needed
			if (this.autoStart) {
				await ensureDaemonRunning(this.projectRoot);
			}

			// Create connection
			this.connection = new DaemonConnection(this.socketPath);

			// Wire up events
			this.connection.on('disconnect', reason => {
				this.handleDisconnect(reason);
			});

			this.connection.on('notification', (method, params) => {
				this.handleNotification(method, params as Record<string, unknown>);
			});

			this.connection.on('error', error => {
				this.emit('error', error);
			});

			// Connect
			await this.connection.connect(this.connectTimeout);

			// Subscribe to notifications
			await this.connection.request('subscribe', {
				protocolVersion: PROTOCOL_VERSION,
			});

			this.state = 'connected';
			this.emit('connect');
		} catch (error) {
			this.state = 'disconnected';
			throw error;
		}
	}

	/**
	 * Disconnect from the daemon.
	 */
	async disconnect(): Promise<void> {
		this.closed = true;
		this.state = 'disconnected';

		if (this.connection) {
			this.connection.disconnect();
			this.connection = null;
		}
	}

	/**
	 * Check if daemon is running (without connecting).
	 */
	async isRunning(): Promise<boolean> {
		return isDaemonRunning(this.projectRoot);
	}

	// ==========================================================================
	// Reconnection
	// ==========================================================================

	/**
	 * Handle disconnect event.
	 */
	private async handleDisconnect(reason: string): Promise<void> {
		this.state = 'disconnected';
		this.emit('disconnect', reason);

		// Don't reconnect if explicitly closed or already reconnecting
		if (this.closed || this.reconnecting) {
			return;
		}

		// Attempt reconnection
		this.reconnecting = true;
		this.state = 'reconnecting';

		for (let i = 0; i < this.reconnectAttempts; i++) {
			const delay =
				RECONNECT_DELAYS[i] ?? RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1];
			await new Promise(r => setTimeout(r, delay));

			if (this.closed) {
				break;
			}

			try {
				this.connection = null;
				await this.connect();
				this.reconnecting = false;
				this.emit('reconnect');
				return;
			} catch {
				// Continue to next attempt
			}
		}

		this.reconnecting = false;
		this.state = 'disconnected';
		this.emit('reconnectFailed');
	}

	/**
	 * Handle push notification.
	 * Dispatches to Redux store to sync state, then emits event.
	 */
	private handleNotification(
		method: string,
		params: Record<string, unknown>,
	): void {
		switch (method) {
			case 'indexProgress':
				// Sync indexing state to local Redux store
				store.dispatch(
					IndexingActions.setProgress({
						current: params['current'] as number,
						total: params['total'] as number,
						stage: params['stage'] as string,
						chunksProcessed: params['chunksProcessed'] as number,
					}),
				);
				this.emit('indexProgress', params as unknown as IndexProgressEvent);
				break;
			case 'indexComplete':
				// Mark indexing as complete in local store
				if (params['success']) {
					store.dispatch(IndexingActions.complete());
				} else {
					store.dispatch(
						IndexingActions.fail(
							(params['error'] as string) ?? 'Unknown error',
						),
					);
				}
				this.emit('indexComplete', params as unknown as IndexCompleteEvent);
				break;
			case 'slotProgress': {
				// Sync slot progress to local Redux store
				const slotIndex = params['index'] as number;
				const slotState = params['state'] as
					| 'idle'
					| 'processing'
					| 'rate-limited';

				if (slotState === 'idle') {
					store.dispatch(SlotProgressActions.setSlotIdle(slotIndex));
				} else if (slotState === 'rate-limited') {
					store.dispatch(
						SlotProgressActions.setSlotRateLimited({
							index: slotIndex,
							batchInfo: (params['batchInfo'] as string) ?? '',
							retryInfo: (params['retryInfo'] as string) ?? '',
						}),
					);
				} else {
					store.dispatch(
						SlotProgressActions.setSlotProcessing({
							index: slotIndex,
							batchInfo: (params['batchInfo'] as string) ?? '',
						}),
					);
				}
				this.emit('slotProgress', params);
				break;
			}
			case 'watcherEvent':
				this.emit('watcherEvent', params);
				break;
			case 'shuttingDown':
				this.emit('shuttingDown', params as unknown as ShuttingDownEvent);
				break;
			default:
				// Unknown notification
				break;
		}
	}

	// ==========================================================================
	// API Methods
	// ==========================================================================

	/**
	 * Ensure connected before making a request.
	 */
	private async ensureConnected(): Promise<void> {
		if (!this.isConnected()) {
			await this.connect();
		}
	}

	/**
	 * Search the codebase.
	 */
	async search(
		query: string,
		options?: ClientSearchOptions,
	): Promise<SearchResults> {
		await this.ensureConnected();
		return this.connection!.request('search', {
			query,
			...options,
		}) as Promise<SearchResults>;
	}

	/**
	 * Index the codebase.
	 */
	async index(options?: ClientIndexOptions): Promise<IndexStats> {
		await this.ensureConnected();
		return this.connection!.request(
			'index',
			options as unknown as Record<string, unknown>,
		) as Promise<IndexStats>;
	}

	/**
	 * Get daemon status.
	 */
	async status(): Promise<DaemonStatusResponse> {
		await this.ensureConnected();
		return this.connection!.request('status') as Promise<DaemonStatusResponse>;
	}

	/**
	 * Get watcher status.
	 */
	async watchStatus(): Promise<WatcherStatus> {
		await this.ensureConnected();
		return this.connection!.request('watchStatus') as Promise<WatcherStatus>;
	}

	/**
	 * Request daemon shutdown.
	 */
	async shutdown(reason?: string): Promise<void> {
		await this.ensureConnected();
		await this.connection!.request('shutdown', {reason});
	}

	/**
	 * Ping the daemon.
	 */
	async ping(): Promise<PingResponse> {
		await this.ensureConnected();
		return this.connection!.request('ping') as Promise<PingResponse>;
	}

	/**
	 * Get health information.
	 */
	async health(): Promise<{
		healthy: boolean;
		uptime: number;
		memoryUsage: NodeJS.MemoryUsage;
		clients: number;
		indexStatus: string;
		protocolVersion: number;
	}> {
		await this.ensureConnected();
		return this.connection!.request('health') as Promise<{
			healthy: boolean;
			uptime: number;
			memoryUsage: NodeJS.MemoryUsage;
			clients: number;
			indexStatus: string;
			protocolVersion: number;
		}>;
	}
}

// Re-export types and utilities
export {getSocketPath, isDaemonRunning} from './auto-start.js';
export type {
	DaemonClientOptions,
	ConnectionState,
	ClientSearchOptions,
	ClientIndexOptions,
	DaemonStatusResponse,
	SubscribeResponse,
	PingResponse,
	SearchResults,
	IndexStats,
	WatcherStatus,
	IndexProgressEvent,
	IndexCompleteEvent,
	ShuttingDownEvent,
} from './types.js';
