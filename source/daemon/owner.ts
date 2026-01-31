/**
 * Daemon Resource Owner
 *
 * Single owner of all mutable project state. The daemon owns:
 * - LanceDB connection (via Storage)
 * - FileWatcher (auto-indexing on file changes)
 * - SearchEngine (singleton, shared across requests)
 * - IndexingService (on-demand, exclusive access via mutex)
 *
 * Uses event-based services instead of Redux.
 * CLI and MCP clients access these resources via IPC.
 */

import * as crypto from 'node:crypto';
import {loadConfig, configExists, type ViberagConfig} from './lib/config.js';
import {getDaemonPidPath, getDaemonSocketPath} from './lib/constants.js';
import {createServiceLogger, type Logger} from './lib/logger.js';
import {isAbortError, throwIfAborted} from './lib/abort.js';
import {daemonState, type IndexingStatus} from './state.js';
import {SearchEngineV2} from './services/v2/search/engine.js';
import type {
	V2FindUsagesOptions,
	V2FindUsagesResponse,
	V2SearchResponse,
} from './services/v2/search/types.js';
import {
	runV2Eval,
	type V2EvalOptions,
	type V2EvalReport,
} from './services/v2/eval/eval.js';
import {IndexingServiceV2, type V2IndexStats} from './services/v2/indexing.js';
import type {IndexingPhase, IndexingUnit} from './services/types.js';
import {FileWatcher, type WatcherStatus} from './services/watcher.js';
import {StorageV2} from './services/v2/storage/index.js';
import {loadV2Manifest, v2ManifestExists} from './services/v2/manifest.js';
import type {
	V2SearchIntent,
	V2SearchScope,
} from './services/v2/search/types.js';

// ============================================================================
// Types
// ============================================================================

const AUTO_INDEX_CANCEL_PAUSE_MS = 30_000;

/**
 * Search options passed from client.
 */
export interface DaemonSearchOptions {
	intent?: V2SearchIntent;
	scope?: V2SearchScope;
	k?: number;
	explain?: boolean;
}

/**
 * Index options passed from client.
 */
export interface DaemonIndexOptions {
	force?: boolean;
}

/**
 * Cancel options passed from client.
 */
export interface DaemonCancelOptions {
	target?: 'indexing' | 'warmup' | 'all';
	reason?: string;
}

/**
 * Cancel response for clients.
 */
export interface DaemonCancelResponse {
	cancelled: boolean;
	targets: Array<'indexing' | 'warmup'>;
	skipped: Array<'indexing' | 'warmup'>;
	reason: string | null;
	message: string;
}

/**
 * Slot state for concurrent embedding tracking.
 */
export interface SlotState {
	state: 'idle' | 'processing' | 'rate-limited';
	batchInfo: string | null;
	retryInfo: string | null;
}

/**
 * Failed chunk info.
 */
export interface FailedChunk {
	batchInfo: string;
	error: string;
	timestamp: string;
	files: string[];
	chunkCount: number;
}

/**
 * Status response for clients.
 * Enhanced to support polling-based state synchronization.
 */
export interface DaemonStatus {
	initialized: boolean;
	indexed: boolean;
	version?: number;
	createdAt?: string;
	updatedAt?: string;
	totalFiles?: number;
	totalSymbols?: number;
	totalChunks?: number;
	totalRefs?: number;
	embeddingProvider?: string;
	embeddingModel?: string;
	warmupStatus: string;
	warmupElapsedMs?: number;
	warmupCancelRequestedAt?: string | null;
	warmupCancelledAt?: string | null;
	warmupCancelReason?: string | null;
	watcherStatus: WatcherStatus;

	// Indexing state for polling-based updates
	indexing: {
		status:
			| 'idle'
			| 'initializing'
			| 'indexing'
			| 'cancelling'
			| 'cancelled'
			| 'complete'
			| 'error';
		phase: IndexingPhase | null;
		current: number;
		total: number;
		unit: IndexingUnit | null;
		stage: string;
		chunksProcessed: number;
		throttleMessage: string | null;
		error: string | null;
		startedAt: string | null;
		lastCompleted: string | null;
		lastStats: V2IndexStats | null;
		lastProgressAt: string | null;
		cancelRequestedAt: string | null;
		cancelledAt: string | null;
		lastCancelled: string | null;
		cancelReason: string | null;
		secondsSinceProgress: number | null;
		elapsedMs: number | null;
		percent: number;
	};

	// Slot progress for concurrent embedding tracking
	slots: SlotState[];

	// Failed batches after retries exhausted
	failures: FailedChunk[];
}

// ============================================================================
// Daemon Owner
// ============================================================================

/**
 * Owns and manages all daemon resources.
 * Uses event-based services wired to daemon state.
 */
export class DaemonOwner {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private logger: Logger | null = null;
	private watcher: FileWatcher | null = null;
	private initializePromise: Promise<void> | null = null;

	// Shared Storage instance (owned by DaemonOwner)
	private storage: StorageV2 | null = null;

	// SearchEngine singleton (lazy initialized)
	private searchEngine: SearchEngineV2 | null = null;
	private warmupPromise: Promise<SearchEngineV2> | null = null;
	private warmupStartTime: number | null = null;
	private warmupAbortController: AbortController | null = null;
	private indexingAbortController: AbortController | null = null;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	/**
	 * Initialize the daemon owner.
	 * Loads config, starts watcher, begins warmup.
	 */
	async initialize(): Promise<void> {
		if (this.initializePromise) {
			return this.initializePromise;
		}

		this.initializePromise = this.doInitialize().catch(error => {
			this.initializePromise = null;
			throw error;
		});

		return this.initializePromise;
	}

	/**
	 * Ensure the daemon owner is initialized.
	 */
	async ensureInitialized(): Promise<void> {
		await this.initialize();
	}

	private async doInitialize(): Promise<void> {
		// Check if project is initialized
		if (!(await configExists(this.projectRoot))) {
			throw new Error(
				`VibeRAG not initialized in ${this.projectRoot}. ` +
					`Run 'npx viberag' and use /init command first.`,
			);
		}

		// Load config
		this.config = await loadConfig(this.projectRoot);

		// Create service logger (writes to global per-project logs directory)
		try {
			this.logger = createServiceLogger(this.projectRoot, 'daemon');
		} catch {
			// Ignore - debug logging is optional
		}

		this.log('info', `Daemon initializing for ${this.projectRoot}`);

		// Create and connect shared v2 Storage instance
		this.storage = new StorageV2(
			this.projectRoot,
			this.config.embeddingDimensions,
		);
		await this.storage.connect();
		this.log('info', 'Storage connected');

		// Start watcher (if enabled)
		if (this.config.watch?.enabled !== false) {
			this.watcher = new FileWatcher(this.projectRoot);
			this.wireWatcherEvents();

			// Set index trigger callback
			this.watcher.setIndexTrigger(async () => {
				const stats = await this.index({force: false});
				return {
					chunksAdded: stats.chunkRowsUpserted,
					chunksDeleted: stats.chunkRowsDeleted,
				};
			});

			void this.watcher
				.start()
				.then(() => {
					this.log('info', 'File watcher started');
				})
				.catch(error => {
					const message =
						error instanceof Error ? error.message : String(error);
					this.log('error', `File watcher failed to start: ${message}`);
				});
		}

		// Start warmup in background (don't await)
		this.startWarmup();

		this.log('info', 'Daemon initialized');
	}

	/**
	 * Shutdown the daemon owner.
	 * Stops watcher, closes search engine and storage.
	 */
	async shutdown(): Promise<void> {
		this.log('info', 'Daemon shutting down');

		// Stop watcher
		if (this.watcher) {
			await this.watcher.stop();
			this.watcher = null;
		}

		// Close search engine (no longer closes storage since it's external)
		if (this.searchEngine) {
			this.searchEngine.close();
			this.searchEngine = null;
		}
		this.warmupPromise = null;

		// Close shared storage
		if (this.storage) {
			this.storage.close();
			this.storage = null;
		}

		// Reset state
		daemonState.reset();

		this.log('info', 'Daemon shutdown complete');
	}

	// ==========================================================================
	// Event Wiring
	// ==========================================================================

	/**
	 * Wire watcher events to daemon state.
	 */
	private wireWatcherEvents(): void {
		if (!this.watcher) return;

		this.watcher.on('watcher-start', () => {
			daemonState.updateNested('watcher', () => ({
				watching: true,
			}));
		});

		this.watcher.on('watcher-ready', ({filesWatched}) => {
			daemonState.updateNested('watcher', () => ({
				watching: true,
				filesWatched,
			}));
		});

		this.watcher.on('watcher-debouncing', ({pendingPaths}) => {
			daemonState.updateNested('watcher', () => ({
				pendingChanges: pendingPaths.length,
				indexUpToDate: false,
			}));
		});

		this.watcher.on('watcher-indexed', () => {
			daemonState.updateNested('watcher', () => ({
				lastIndexUpdate: new Date().toISOString(),
				indexUpToDate: true,
				pendingChanges: 0,
			}));
		});

		this.watcher.on('watcher-stopped', () => {
			daemonState.updateNested('watcher', () => ({
				watching: false,
				filesWatched: 0,
				pendingChanges: 0,
			}));
		});

		this.watcher.on('watcher-error', ({error}) => {
			this.log('error', `Watcher error: ${error}`);
		});
	}

	/**
	 * Wire indexing service events to daemon state.
	 */
	private wireIndexingEvents(indexer: IndexingServiceV2): void {
		indexer.on('start', () => {
			const startedAt = new Date().toISOString();
			daemonState.updateNested('indexing', () => ({
				status: 'initializing' as const,
				phase: 'init' as const,
				current: 0,
				total: 0,
				unit: null,
				stage: 'Initializing indexer',
				chunksProcessed: 0,
				throttleMessage: null,
				error: null,
				startedAt,
				lastProgressAt: startedAt,
				cancelRequestedAt: null,
				cancelledAt: null,
				cancelReason: null,
			}));
			// Reset slots
			daemonState.update(state => ({
				slots: state.slots.map(() => ({
					state: 'idle' as const,
					batchInfo: null,
					retryInfo: null,
				})),
				failures: [],
			}));
		});

		indexer.on('progress', ({phase, current, total, unit, stage}) => {
			const status: IndexingStatus =
				phase === 'init' ? 'initializing' : 'indexing';
			daemonState.updateNested('indexing', () => ({
				status,
				phase,
				current,
				total,
				unit,
				stage,
				lastProgressAt: new Date().toISOString(),
			}));
		});

		indexer.on('chunk-progress', ({chunksProcessed}) => {
			daemonState.updateNested('indexing', () => ({
				chunksProcessed,
				lastProgressAt: new Date().toISOString(),
			}));
		});

		indexer.on('throttle', ({message}) => {
			daemonState.updateNested('indexing', () => ({
				throttleMessage: message,
				lastProgressAt: new Date().toISOString(),
			}));
		});

		indexer.on('complete', () => {
			daemonState.updateNested('indexing', () => ({
				status: 'complete' as const,
				phase: null,
				unit: null,
				stage: '',
				lastCompleted: new Date().toISOString(),
				throttleMessage: null,
				lastProgressAt: new Date().toISOString(),
				startedAt: null,
				cancelRequestedAt: null,
				cancelledAt: null,
				cancelReason: null,
			}));
			// Reset to idle after a short delay
			setTimeout(() => {
				const state = daemonState.getSnapshot();
				if (state.indexing.status === 'complete') {
					daemonState.updateNested('indexing', () => ({
						status: 'idle' as const,
						phase: null,
						unit: null,
						stage: '',
					}));
				}
			}, 1000);
		});

		indexer.on('error', ({error}) => {
			daemonState.updateNested('indexing', current => ({
				status: 'error' as const,
				phase: current.phase,
				unit: current.unit,
				stage: current.stage,
				error: error.message,
				lastProgressAt: new Date().toISOString(),
				startedAt: null,
			}));
		});

		indexer.on('cancelled', ({reason}) => {
			const cancelledAt = new Date().toISOString();
			daemonState.updateNested('indexing', current => ({
				status: 'cancelled' as const,
				phase: null,
				unit: null,
				stage: 'Cancelled',
				error: null,
				throttleMessage: null,
				lastProgressAt: cancelledAt,
				startedAt: null,
				cancelledAt,
				lastCancelled: cancelledAt,
				cancelReason: reason ?? current.cancelReason,
			}));
			setTimeout(() => {
				const state = daemonState.getSnapshot();
				if (state.indexing.status === 'cancelled') {
					daemonState.updateNested('indexing', () => ({
						status: 'idle' as const,
						phase: null,
						unit: null,
						stage: '',
					}));
				}
			}, 1000);
		});

		// Slot events
		indexer.on('slot-processing', ({slot, batchInfo}) => {
			daemonState.update(state => ({
				slots: state.slots.map((s, i) =>
					i === slot
						? {state: 'processing' as const, batchInfo, retryInfo: null}
						: s,
				),
			}));
		});

		indexer.on('slot-rate-limited', ({slot, retryInfo}) => {
			daemonState.update(state => ({
				slots: state.slots.map((s, i) =>
					i === slot ? {...s, state: 'rate-limited' as const, retryInfo} : s,
				),
			}));
		});

		indexer.on('slot-idle', ({slot}) => {
			daemonState.update(state => ({
				slots: state.slots.map((s, i) =>
					i === slot
						? {state: 'idle' as const, batchInfo: null, retryInfo: null}
						: s,
				),
			}));
		});

		indexer.on('slot-failure', ({batchInfo, error, files, chunkCount}) => {
			daemonState.update(state => ({
				failures: [
					...state.failures,
					{
						batchInfo,
						error,
						timestamp: new Date().toISOString(),
						files,
						chunkCount,
					},
				],
			}));
		});

		indexer.on('slots-reset', () => {
			daemonState.update(state => ({
				slots: state.slots.map(() => ({
					state: 'idle' as const,
					batchInfo: null,
					retryInfo: null,
				})),
			}));
		});
	}

	// ==========================================================================
	// SearchEngine Management (WarmupManager pattern)
	// ==========================================================================

	/**
	 * Start warmup in background.
	 */
	private startWarmup(): void {
		if (this.warmupPromise || this.searchEngine) {
			return; // Already started or ready
		}

		this.warmupAbortController = new AbortController();
		const signal = this.warmupAbortController.signal;

		this.warmupPromise = this.doWarmup(signal).catch(error => {
			// Error captured in state, re-throw for chain
			throw error;
		});
	}

	/**
	 * Perform warmup - initialize SearchEngine with embedding provider.
	 */
	private async doWarmup(signal?: AbortSignal): Promise<SearchEngineV2> {
		this.warmupStartTime = Date.now();

		try {
			throwIfAborted(signal, 'Warmup cancelled');
			if (!this.config) {
				throw new Error('Config not loaded');
			}

			// Update state
			daemonState.updateNested('warmup', () => ({
				status: 'initializing' as const,
				provider: this.config!.embeddingProvider,
				error: null,
				startedAt: new Date().toISOString(),
				cancelRequestedAt: null,
				cancelledAt: null,
				cancelReason: null,
			}));

			this.log('info', `Warming up ${this.config.embeddingProvider} provider`);

			// Create v2 SearchEngine with shared storage
			const engine = new SearchEngineV2(this.projectRoot, {
				logger: this.logger ?? undefined,
				storage: this.storage ?? undefined,
			});

			// Timeout based on provider
			const isLocal = this.config.embeddingProvider.startsWith('local');
			const timeout = isLocal ? 180000 : 30000;

			const initPromise = engine.warmup(signal);
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(
						new Error(
							`Warmup timeout after ${timeout}ms. ` +
								`For local models, first run may take several minutes.`,
						),
					);
				}, timeout);
			});

			await Promise.race([initPromise, timeoutPromise]);
			throwIfAborted(signal, 'Warmup cancelled');

			const elapsed = Date.now() - this.warmupStartTime;
			this.searchEngine = engine;
			this.warmupAbortController = null;

			daemonState.updateNested('warmup', () => ({
				status: 'ready' as const,
				readyAt: new Date().toISOString(),
			}));

			this.log('info', `Warmup complete (${elapsed}ms)`);

			return engine;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			if (isAbortError(error) || signal?.aborted) {
				const cancelledAt = new Date().toISOString();
				daemonState.updateNested('warmup', () => ({
					status: 'cancelled' as const,
					error: message,
					cancelledAt,
					cancelReason: message,
				}));
				this.log('info', `Warmup cancelled: ${message}`);
				this.warmupPromise = null;
				this.warmupAbortController = null;
				throw error;
			}

			daemonState.updateNested('warmup', () => ({
				status: 'failed' as const,
				error: message,
			}));

			this.log('error', `Warmup failed: ${message}`);

			// Clear promise to allow retry
			this.warmupPromise = null;
			this.warmupAbortController = null;

			throw error;
		}
	}

	/**
	 * Get the initialized SearchEngine.
	 */
	private async getSearchEngine(): Promise<SearchEngineV2> {
		if (this.searchEngine) {
			return this.searchEngine;
		}
		if (this.warmupPromise) {
			return this.warmupPromise;
		}
		// Start warmup and wait
		this.startWarmup();
		if (!this.warmupPromise) {
			throw new Error('Warmup failed to start');
		}
		return this.warmupPromise;
	}

	// ==========================================================================
	// Operations
	// ==========================================================================

	/**
	 * Search the codebase.
	 */
	async search(
		query: string,
		options?: DaemonSearchOptions,
	): Promise<V2SearchResponse> {
		const engine = await this.getSearchEngine();
		return engine.search(query, options);
	}

	/**
	 * Fetch a symbol row by symbol_id.
	 */
	async getSymbol(symbolId: string): Promise<Record<string, unknown> | null> {
		const engine = await this.getSearchEngine();
		return engine.getSymbol(symbolId);
	}

	/**
	 * Find usages for a symbol name or symbol_id.
	 */
	async findUsages(
		options: V2FindUsagesOptions,
	): Promise<V2FindUsagesResponse> {
		const engine = await this.getSearchEngine();
		return engine.findUsages(options);
	}

	/**
	 * Run the v2 eval harness (quality + latency).
	 */
	async eval(options?: V2EvalOptions): Promise<V2EvalReport> {
		const engine = await this.getSearchEngine();
		if (!this.storage) {
			throw new Error('Storage not initialized');
		}
		return runV2Eval({engine, storage: this.storage, options});
	}

	/**
	 * Expand context for a hit (symbols/chunks/files).
	 */
	async expandContext(args: {
		table: 'symbols' | 'chunks' | 'files';
		id: string;
		limit?: number;
	}): Promise<Record<string, unknown>> {
		const engine = await this.getSearchEngine();
		return engine.expandContext(args);
	}

	/**
	 * Index the codebase.
	 */
	async index(options?: DaemonIndexOptions): Promise<V2IndexStats> {
		// Notify watcher that indexing is starting
		this.watcher?.setIndexingState(true);

		if (
			!this.indexingAbortController ||
			this.indexingAbortController.signal.aborted
		) {
			this.indexingAbortController = new AbortController();
		}
		const signal = this.indexingAbortController.signal;

		// Create IndexingService with shared storage
		const indexer = new IndexingServiceV2(this.projectRoot, {
			logger: this.logger ?? undefined,
			storage: this.storage ?? undefined,
			signal,
		});

		// Wire events to state
		this.wireIndexingEvents(indexer);

		try {
			// Handle force reindex - sync config dimensions
			if (options?.force && this.config) {
				const {PROVIDER_CONFIGS, saveConfig} = await import('./lib/config.js');
				const currentDimensions =
					PROVIDER_CONFIGS[this.config.embeddingProvider]?.dimensions;

				if (
					currentDimensions &&
					this.config.embeddingDimensions !== currentDimensions
				) {
					const updatedConfig = {
						...this.config,
						embeddingDimensions: currentDimensions,
						embeddingModel:
							PROVIDER_CONFIGS[this.config.embeddingProvider].model,
					};
					await saveConfig(this.projectRoot, updatedConfig);
					this.config = updatedConfig;
				}
			}

			const stats = await indexer.index({force: options?.force ?? false});
			daemonState.updateNested('indexing', () => ({
				lastStats: stats,
			}));
			return stats;
		} finally {
			indexer.close();
			this.watcher?.setIndexingState(false);
			this.indexingAbortController = null;
		}
	}

	/**
	 * Cancel any in-progress daemon activity (indexing or warmup).
	 */
	async cancelActivity(
		options: DaemonCancelOptions = {},
	): Promise<DaemonCancelResponse> {
		const target = options.target ?? 'all';
		const reason = options.reason?.trim();
		const cancelReason =
			reason && reason.length > 0 ? reason : 'cancel requested';
		const nowIso = new Date().toISOString();
		const targets: Array<'indexing' | 'warmup'> = [];
		const skipped: Array<'indexing' | 'warmup'> = [];

		if (target === 'all' || target === 'indexing') {
			const canCancelIndexing =
				this.indexingAbortController &&
				!this.indexingAbortController.signal.aborted;

			if (canCancelIndexing) {
				daemonState.updateNested('indexing', current => ({
					status: 'cancelling' as const,
					cancelRequestedAt: nowIso,
					cancelReason: cancelReason,
					stage: current.stage || 'Cancelling',
					lastProgressAt: nowIso,
				}));
				this.indexingAbortController!.abort(cancelReason);
				this.watcher?.pauseAutoIndexing(
					AUTO_INDEX_CANCEL_PAUSE_MS,
					cancelReason,
				);
				targets.push('indexing');
			} else {
				skipped.push('indexing');
			}
		}

		if (target === 'all' || target === 'warmup') {
			const canCancelWarmup =
				this.warmupAbortController &&
				!this.warmupAbortController.signal.aborted;

			if (canCancelWarmup) {
				daemonState.updateNested('warmup', () => ({
					status: 'cancelling' as const,
					cancelRequestedAt: nowIso,
					cancelReason: cancelReason,
				}));
				this.warmupAbortController!.abort(cancelReason);
				targets.push('warmup');
			} else {
				skipped.push('warmup');
			}
		}

		const cancelled = targets.length > 0;
		const message = cancelled
			? `Cancel requested for ${targets.join(' and ')}.`
			: 'No active operations to cancel.';

		if (cancelled) {
			this.log('info', message);
		}

		return {
			cancelled,
			targets,
			skipped,
			reason: reason ?? null,
			message,
		};
	}

	/**
	 * Get daemon status.
	 * Enhanced to support polling-based state synchronization.
	 */
	async getStatus(): Promise<DaemonStatus> {
		const state = daemonState.getSnapshot();
		const watcherStatus = this.watcher?.getStatus();

		// Calculate warmup elapsed time
		let warmupElapsedMs: number | undefined;
		const now = Date.now();
		if (this.warmupStartTime) {
			if (state.warmup.status === 'ready' || state.warmup.status === 'failed') {
				warmupElapsedMs = state.warmup.readyAt
					? new Date(state.warmup.readyAt).getTime() - this.warmupStartTime
					: now - this.warmupStartTime;
			} else if (
				state.warmup.status === 'cancelled' &&
				state.warmup.cancelledAt
			) {
				warmupElapsedMs =
					new Date(state.warmup.cancelledAt).getTime() - this.warmupStartTime;
			} else if (
				state.warmup.status === 'initializing' ||
				state.warmup.status === 'cancelling'
			) {
				warmupElapsedMs = now - this.warmupStartTime;
			}
		}

		const lastProgressAtMs = state.indexing.lastProgressAt
			? new Date(state.indexing.lastProgressAt).getTime()
			: null;
		const secondsSinceProgress =
			lastProgressAtMs !== null
				? Math.max(0, Math.round((now - lastProgressAtMs) / 1000))
				: null;
		const elapsedMs = state.indexing.startedAt
			? Math.max(0, now - new Date(state.indexing.startedAt).getTime())
			: null;

		const status: DaemonStatus = {
			initialized: await configExists(this.projectRoot),
			indexed: await v2ManifestExists(this.projectRoot),
			warmupStatus: state.warmup.status,
			warmupElapsedMs,
			warmupCancelRequestedAt: state.warmup.cancelRequestedAt,
			warmupCancelledAt: state.warmup.cancelledAt,
			warmupCancelReason: state.warmup.cancelReason,
			watcherStatus: watcherStatus ?? {
				watching: false,
				filesWatched: 0,
				pendingChanges: 0,
				pendingPaths: [],
				lastIndexUpdate: null,
				indexUpToDate: false,
				lastError: null,
				autoIndexPausedUntil: null,
				autoIndexPauseReason: null,
			},
			indexing: {
				status: state.indexing.status,
				phase: state.indexing.phase,
				current: state.indexing.current,
				total: state.indexing.total,
				unit: state.indexing.unit,
				stage: state.indexing.stage,
				chunksProcessed: state.indexing.chunksProcessed,
				throttleMessage: state.indexing.throttleMessage,
				error: state.indexing.error,
				startedAt: state.indexing.startedAt,
				lastCompleted: state.indexing.lastCompleted,
				lastStats: state.indexing.lastStats,
				lastProgressAt: state.indexing.lastProgressAt,
				cancelRequestedAt: state.indexing.cancelRequestedAt,
				cancelledAt: state.indexing.cancelledAt,
				lastCancelled: state.indexing.lastCancelled,
				cancelReason: state.indexing.cancelReason,
				secondsSinceProgress,
				elapsedMs,
				percent:
					state.indexing.total > 0
						? Math.round((state.indexing.current / state.indexing.total) * 100)
						: 0,
			},
			// Slot progress for concurrent embedding tracking
			slots: state.slots.map(s => ({
				state: s.state,
				batchInfo: s.batchInfo,
				retryInfo: s.retryInfo,
			})),
			// Failed batches after retries exhausted
			failures: state.failures.map(f => ({
				batchInfo: f.batchInfo,
				error: f.error,
				timestamp: f.timestamp,
				files: f.files,
				chunkCount: f.chunkCount,
			})),
		};

		// Add config info if available
		if (this.config) {
			status.embeddingProvider = this.config.embeddingProvider;
			status.embeddingModel = this.config.embeddingModel;
		}

		// Add manifest info if indexed
		if (status.indexed) {
			const manifest = await loadV2Manifest(this.projectRoot, {
				repoId: computeRepoId(this.projectRoot),
				revision: 'working',
			});
			status.version = manifest.version;
			status.createdAt = manifest.createdAt;
			status.updatedAt = manifest.updatedAt;
			status.totalFiles = manifest.stats.totalFiles;
			status.totalSymbols = manifest.stats.totalSymbols;
			status.totalChunks = manifest.stats.totalChunks;
			status.totalRefs = manifest.stats.totalRefs;
		}

		return status;
	}

	/**
	 * Get watcher status.
	 */
	getWatcherStatus(): WatcherStatus {
		return (
			this.watcher?.getStatus() ?? {
				watching: false,
				filesWatched: 0,
				pendingChanges: 0,
				pendingPaths: [],
				lastIndexUpdate: null,
				indexUpToDate: false,
				lastError: null,
				autoIndexPausedUntil: null,
				autoIndexPauseReason: null,
			}
		);
	}

	/**
	 * Get the file watcher (for direct access if needed).
	 */
	getWatcher(): FileWatcher | null {
		return this.watcher;
	}

	/**
	 * Get the project root.
	 */
	getProjectRoot(): string {
		return this.projectRoot;
	}

	// ==========================================================================
	// Helpers
	// ==========================================================================

	/**
	 * Get the socket path for this project.
	 */
	getSocketPath(): string {
		return getDaemonSocketPath(this.projectRoot);
	}

	/**
	 * Get the PID file path for this project.
	 */
	getPidPath(): string {
		return getDaemonPidPath(this.projectRoot);
	}

	/**
	 * Get the logger instance (for centralized error logging).
	 */
	getLogger(): Logger | null {
		return this.logger;
	}

	/**
	 * Log a message.
	 */
	private log(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
	): void {
		const prefix = '[Daemon]';
		if (this.logger) {
			this.logger[level](prefix, message);
		}
		if (level === 'error' || level === 'info') {
			console.error(`${prefix} ${message}`);
		}
	}
}

function computeRepoId(projectRoot: string): string {
	return crypto.createHash('sha256').update(projectRoot).digest('hex');
}
