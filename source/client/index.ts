/**
 * Daemon Client
 *
 * High-level client for daemon communication.
 * Provides typed API methods and handles connection lifecycle.
 *
 * Simplified for polling-based architecture:
 * - Pure request/response, no push notifications
 * - No reconnection logic - clients poll and reconnect as needed
 * - Auto-starts daemon if not running
 */

import {DaemonConnection} from './connection.js';
import {
	ensureDaemonRunning,
	isDaemonRunning,
	getSocketPath,
} from './auto-start.js';
import type {
	DaemonClientOptions,
	ClientSearchOptions,
	ClientIndexOptions,
	DaemonStatusResponse,
	PingResponse,
	SearchResults,
	IndexStats,
	WatcherStatus,
} from './types.js';

// ============================================================================
// DaemonClient
// ============================================================================

/**
 * Client for communicating with the VibeRAG daemon.
 * Pure request/response - clients poll status() for updates.
 */
export class DaemonClient {
	private readonly projectRoot: string;
	private readonly socketPath: string;
	private readonly autoStart: boolean;
	private readonly connectTimeout: number;

	private connection: DaemonConnection | null = null;
	private connectPromise: Promise<void> | null = null;

	constructor(options: DaemonClientOptions | string) {
		// Handle simple string constructor
		if (typeof options === 'string') {
			this.projectRoot = options;
			this.autoStart = true;
			this.connectTimeout = 5000;
		} else {
			this.projectRoot = options.projectRoot;
			this.autoStart = options.autoStart ?? true;
			this.connectTimeout = options.connectTimeout ?? 5000;
		}

		this.socketPath = getSocketPath(this.projectRoot);
	}

	// ==========================================================================
	// Connection Management
	// ==========================================================================

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return this.connection?.isConnected() === true;
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
		try {
			// Auto-start daemon if needed
			if (this.autoStart) {
				await ensureDaemonRunning(this.projectRoot);
			}

			// Create connection
			this.connection = new DaemonConnection(this.socketPath);

			// Connect
			await this.connection.connect(this.connectTimeout);
		} catch (error) {
			this.connection = null;
			throw error;
		}
	}

	/**
	 * Disconnect from the daemon.
	 */
	async disconnect(): Promise<void> {
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
	 * Clients should poll this endpoint for state updates.
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
	ClientSearchOptions,
	ClientIndexOptions,
	DaemonStatusResponse,
	PingResponse,
	SearchResults,
	IndexStats,
	WatcherStatus,
	SlotState,
	FailedChunk,
} from './types.js';
