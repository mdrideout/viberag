/**
 * Warmup Manager for MCP Server
 *
 * Manages singleton SearchEngine initialization and state.
 * Ensures embedding model is loaded once and shared across tool calls.
 *
 * The idempotent promise pattern solves the race condition:
 * - First call: Creates the warmup promise, starts initialization
 * - Concurrent calls: All await the SAME promise (no duplicate work)
 * - After ready: Returns cached SearchEngine immediately
 */

import {SearchEngine, loadConfig, configExists} from '../rag/index.js';

/**
 * Warmup status enum.
 */
export type WarmupStatus =
	| 'not_started' // Before warmup triggered
	| 'not_initialized' // Project not initialized
	| 'initializing' // Warmup in progress
	| 'ready' // Warmup complete, engine available
	| 'failed'; // Warmup failed (can retry)

/**
 * Warmup state for status reporting.
 */
export interface WarmupState {
	status: WarmupStatus;
	provider?: string;
	startedAt?: string;
	readyAt?: string;
	elapsedMs?: number;
	error?: string;
}

/**
 * Options for warmup.
 */
export interface WarmupOptions {
	/** Timeout in ms (default: 180000 for local, 30000 for cloud) */
	timeout?: number;
	/** Callback for progress updates */
	onProgress?: (state: WarmupState) => void;
}

/**
 * Manages embedding provider warmup and SearchEngine singleton.
 */
export class WarmupManager {
	private readonly projectRoot: string;
	private searchEngine: SearchEngine | null = null;
	private warmupPromise: Promise<SearchEngine> | null = null;
	private state: WarmupState = {status: 'not_started'};

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	/**
	 * Get current warmup state.
	 */
	getState(): WarmupState {
		return {...this.state};
	}

	/**
	 * Check if warmup is ready.
	 */
	isReady(): boolean {
		return this.state.status === 'ready' && this.searchEngine !== null;
	}

	/**
	 * Check if warmup failed.
	 */
	isFailed(): boolean {
		return this.state.status === 'failed';
	}

	/**
	 * Check if warmup is in progress.
	 */
	isInitializing(): boolean {
		return this.state.status === 'initializing';
	}

	/**
	 * Get the warmup promise for external error monitoring.
	 * Returns null if warmup hasn't started.
	 */
	getWarmupPromise(): Promise<SearchEngine> | null {
		return this.warmupPromise;
	}

	/**
	 * Start warmup if not already started.
	 * Returns immediately - doesn't wait for completion.
	 */
	startWarmup(options?: WarmupOptions): void {
		if (this.warmupPromise || this.searchEngine) {
			return; // Already started or ready
		}

		// Fire and forget - errors handled internally
		this.warmupPromise = this.doWarmup(options).catch(error => {
			// Error already captured in state, re-throw for promise chain
			throw error;
		});
	}

	/**
	 * Get the initialized SearchEngine.
	 * Waits for warmup if in progress, starts warmup if not started.
	 *
	 * @throws Error if project not initialized or warmup failed
	 */
	async getSearchEngine(options?: WarmupOptions): Promise<SearchEngine> {
		// Already ready - return cached engine
		if (this.searchEngine) {
			return this.searchEngine;
		}

		// Warmup in progress - wait for it (all callers share same promise)
		if (this.warmupPromise) {
			return this.warmupPromise;
		}

		// Check if project is initialized
		if (!(await configExists(this.projectRoot))) {
			this.state = {status: 'not_initialized'};
			throw new Error(
				`VibeRAG not initialized in ${this.projectRoot}. ` +
					`Run 'npx viberag' and use /init command first.`,
			);
		}

		// Start warmup and wait
		this.warmupPromise = this.doWarmup(options);
		return this.warmupPromise;
	}

	/**
	 * Perform the actual warmup.
	 */
	private async doWarmup(options?: WarmupOptions): Promise<SearchEngine> {
		const startTime = Date.now();

		try {
			// Check if project is initialized
			if (!(await configExists(this.projectRoot))) {
				this.state = {status: 'not_initialized'};
				throw new Error('Project not initialized');
			}

			// Load config to get provider type
			const config = await loadConfig(this.projectRoot);

			// Update state
			this.state = {
				status: 'initializing',
				provider: config.embeddingProvider,
				startedAt: new Date().toISOString(),
			};

			options?.onProgress?.(this.state);
			console.error(
				`[viberag-mcp] Warming up ${config.embeddingProvider} embedding provider...`,
			);

			// Determine timeout based on provider
			const isLocal = config.embeddingProvider.startsWith('local');
			const timeout = options?.timeout ?? (isLocal ? 180000 : 30000);

			// Create search engine
			const engine = new SearchEngine(this.projectRoot);

			// Wrap initialization with timeout
			const initPromise = engine.warmup();
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(
						new Error(
							`Warmup timeout after ${timeout}ms. ` +
								`For local models, first run may take several minutes to download.`,
						),
					);
				}, timeout);
			});

			await Promise.race([initPromise, timeoutPromise]);

			// Success
			const elapsed = Date.now() - startTime;
			this.searchEngine = engine;
			this.state = {
				status: 'ready',
				provider: config.embeddingProvider,
				startedAt: this.state.startedAt,
				readyAt: new Date().toISOString(),
				elapsedMs: elapsed,
			};

			options?.onProgress?.(this.state);
			console.error(`[viberag-mcp] Warmup complete (${elapsed}ms)`);

			return engine;
		} catch (error) {
			const elapsed = Date.now() - startTime;
			const message = error instanceof Error ? error.message : String(error);

			this.state = {
				...this.state,
				status: 'failed',
				elapsedMs: elapsed,
				error: message,
			};

			options?.onProgress?.(this.state);
			console.error(`[viberag-mcp] Warmup failed: ${message}`);

			// Clear promise to allow retry
			this.warmupPromise = null;

			throw error;
		}
	}

	/**
	 * Retry warmup after a failure.
	 * Clears previous state and starts fresh.
	 */
	async retry(options?: WarmupOptions): Promise<SearchEngine> {
		// Close any existing engine
		this.close();

		// Clear state
		this.warmupPromise = null;
		this.searchEngine = null;
		this.state = {status: 'not_started'};

		// Start fresh
		return this.getSearchEngine(options);
	}

	/**
	 * Close the search engine and free resources.
	 */
	close(): void {
		if (this.searchEngine) {
			this.searchEngine.close();
			this.searchEngine = null;
		}
		this.warmupPromise = null;
	}
}
