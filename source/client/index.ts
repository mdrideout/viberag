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
	ClientFindUsagesOptions,
	ClientEvalOptions,
	ClientIndexOptions,
	IndexStartResponse,
	DaemonStatusResponse,
	PingResponse,
	SearchResults,
	FindUsagesResults,
	EvalReport,
	IndexStats,
	WatcherStatus,
	CancelResponse,
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
	private readonly clientSource: 'cli' | 'mcp' | 'unknown';

	private connection: DaemonConnection | null = null;
	private connectPromise: Promise<void> | null = null;

	constructor(options: DaemonClientOptions | string) {
		// Handle simple string constructor
		if (typeof options === 'string') {
			this.projectRoot = options;
			this.autoStart = true;
			this.connectTimeout = 5000;
			this.clientSource = 'cli';
		} else {
			this.projectRoot = options.projectRoot;
			this.autoStart = options.autoStart ?? true;
			this.connectTimeout = options.connectTimeout ?? 5000;
			this.clientSource = options.clientSource ?? 'cli';
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

	private async request(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		await this.ensureConnected();
		const withMeta: Record<string, unknown> | undefined = params
			? {...params, __client: {source: this.clientSource}}
			: {__client: {source: this.clientSource}};
		return this.connection!.request(method, withMeta);
	}

	/**
	 * Search the codebase.
	 */
	async search(
		query: string,
		options?: ClientSearchOptions,
	): Promise<SearchResults> {
		return this.request('search', {
			query,
			...options,
		}) as Promise<SearchResults>;
	}

	/**
	 * Fetch a symbol definition row by symbol_id.
	 */
	async getSymbol(symbol_id: string): Promise<Record<string, unknown> | null> {
		return this.request('getSymbol', {symbol_id}) as Promise<Record<
			string,
			unknown
		> | null>;
	}

	/**
	 * Find usages for a symbol name or symbol_id.
	 */
	async findUsages(
		options: ClientFindUsagesOptions,
	): Promise<FindUsagesResults> {
		return this.request(
			'findUsages',
			options as unknown as Record<string, unknown>,
		) as Promise<FindUsagesResults>;
	}

	/**
	 * Run the v2 eval harness (quality + latency).
	 */
	async eval(options?: ClientEvalOptions): Promise<EvalReport> {
		return this.request(
			'eval',
			options as unknown as Record<string, unknown> | undefined,
		) as Promise<EvalReport>;
	}

	/**
	 * Expand context for a hit (symbols/chunks/files).
	 */
	async expandContext(args: {
		table: 'symbols' | 'chunks' | 'files';
		id: string;
		limit?: number;
	}): Promise<Record<string, unknown>> {
		return this.request(
			'expandContext',
			args as unknown as Record<string, unknown>,
		) as Promise<Record<string, unknown>>;
	}

	/**
	 * Index the codebase.
	 */
	async index(options?: ClientIndexOptions): Promise<IndexStats> {
		return this.request(
			'index',
			options as unknown as Record<string, unknown>,
		) as Promise<IndexStats>;
	}

	/**
	 * Start indexing asynchronously.
	 */
	async indexAsync(options?: ClientIndexOptions): Promise<IndexStartResponse> {
		return this.request(
			'indexAsync',
			options as unknown as Record<string, unknown>,
		) as Promise<IndexStartResponse>;
	}

	/**
	 * Get daemon status.
	 * Clients should poll this endpoint for state updates.
	 */
	async status(): Promise<DaemonStatusResponse> {
		return this.request('status') as Promise<DaemonStatusResponse>;
	}

	/**
	 * Get watcher status.
	 */
	async watchStatus(): Promise<WatcherStatus> {
		return this.request('watchStatus') as Promise<WatcherStatus>;
	}

	/**
	 * Request daemon shutdown.
	 */
	async shutdown(reason?: string): Promise<void> {
		await this.request('shutdown', {reason});
	}

	/**
	 * Cancel the current daemon activity (indexing or warmup).
	 */
	async cancel(options?: {
		target?: 'indexing' | 'warmup' | 'all';
		reason?: string;
	}): Promise<CancelResponse> {
		return this.request(
			'cancel',
			options as Record<string, unknown> | undefined,
		) as Promise<CancelResponse>;
	}

	/**
	 * Ping the daemon.
	 */
	async ping(): Promise<PingResponse> {
		return this.request('ping') as Promise<PingResponse>;
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
		return this.request('health') as Promise<{
			healthy: boolean;
			uptime: number;
			memoryUsage: NodeJS.MemoryUsage;
			clients: number;
			indexStatus: string;
			protocolVersion: number;
		}>;
	}

	/**
	 * Trigger a test exception in the daemon (undocumented).
	 *
	 * Useful for validating Sentry error reporting.
	 */
	async testException(message?: string): Promise<void> {
		await this.request('testException', {message});
	}
}

// Re-export types and utilities
export {
	getSocketPath,
	getLockPath,
	isDaemonRunning,
	isDaemonLocked,
} from './auto-start.js';
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
