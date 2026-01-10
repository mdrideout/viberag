/**
 * Warmup Manager for MCP Server
 *
 * Manages singleton SearchEngine initialization and state.
 * Ensures embedding model is loaded once and shared across tool calls.
 *
 * State is tracked in Redux for consistency with the rest of the codebase.
 * The idempotent promise pattern solves the race condition:
 * - First call: Creates the warmup promise, starts initialization
 * - Concurrent calls: All await the SAME promise (no duplicate work)
 * - After ready: Returns cached SearchEngine immediately
 */

import {SearchEngine, loadConfig, configExists} from '../rag/index.js';
import {store, WarmupActions} from '../store/index.js';

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
	// State is now in Redux - no local state field

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	/**
	 * Get current warmup state from Redux.
	 */
	getState(): WarmupState {
		const reduxState = store.getState().warmup;
		// Convert Redux state to WarmupState interface (optional vs nullable)
		return {
			status: reduxState.status,
			provider: reduxState.provider ?? undefined,
			startedAt: reduxState.startedAt ?? undefined,
			readyAt: reduxState.readyAt ?? undefined,
			elapsedMs: reduxState.elapsedMs ?? undefined,
			error: reduxState.error ?? undefined,
		};
	}

	/**
	 * Check if warmup is ready.
	 */
	isReady(): boolean {
		return (
			store.getState().warmup.status === 'ready' && this.searchEngine !== null
		);
	}

	/**
	 * Check if warmup failed.
	 */
	isFailed(): boolean {
		return store.getState().warmup.status === 'failed';
	}

	/**
	 * Check if warmup is in progress.
	 */
	isInitializing(): boolean {
		return store.getState().warmup.status === 'initializing';
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
			// Dispatch to Redux (single source of truth)
			store.dispatch(WarmupActions.setNotInitialized());
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
				// Dispatch to Redux (single source of truth)
				store.dispatch(WarmupActions.setNotInitialized());
				throw new Error('Project not initialized');
			}

			// Load config to get provider type
			const config = await loadConfig(this.projectRoot);

			// Dispatch to Redux (single source of truth)
			store.dispatch(WarmupActions.start({provider: config.embeddingProvider}));

			options?.onProgress?.(this.getState());
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

			// Dispatch to Redux (single source of truth)
			store.dispatch(WarmupActions.ready({elapsedMs: elapsed}));

			options?.onProgress?.(this.getState());
			console.error(`[viberag-mcp] Warmup complete (${elapsed}ms)`);

			return engine;
		} catch (error) {
			const elapsed = Date.now() - startTime;
			const message = error instanceof Error ? error.message : String(error);

			// Dispatch to Redux (single source of truth)
			store.dispatch(
				WarmupActions.failed({error: message, elapsedMs: elapsed}),
			);

			options?.onProgress?.(this.getState());
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

		// Clear local references
		this.warmupPromise = null;
		this.searchEngine = null;

		// Reset Redux state
		store.dispatch(WarmupActions.reset());

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
