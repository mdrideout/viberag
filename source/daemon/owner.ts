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
import path from 'node:path';
import {loadConfig, configExists, type ViberagConfig} from './lib/config.js';
import {loadManifest, manifestExists} from './lib/manifest.js';
import {createServiceLogger, type Logger} from './lib/logger.js';
import {daemonState, type DaemonState} from './state.js';
import {SearchEngine} from './services/search/index.js';
import type {SearchResults} from './services/search/types.js';
import {IndexingService, type IndexStats} from './services/indexing.js';
import {FileWatcher, type WatcherStatus} from './services/watcher.js';
import {Storage} from './services/storage/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Search options passed from client.
 */
export interface DaemonSearchOptions {
	mode?: 'semantic' | 'exact' | 'hybrid' | 'definition' | 'similar';
	limit?: number;
	bm25Weight?: number;
	minScore?: number;
	filters?: Record<string, unknown>;
	codeSnippet?: string;
	symbolName?: string;
	autoBoost?: boolean;
	autoBoostThreshold?: number;
	returnDebug?: boolean;
}

/**
 * Index options passed from client.
 */
export interface DaemonIndexOptions {
	force?: boolean;
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
	totalChunks?: number;
	embeddingProvider?: string;
	embeddingModel?: string;
	warmupStatus: string;
	warmupElapsedMs?: number;
	watcherStatus: WatcherStatus;

	// Indexing state for polling-based updates
	indexing: {
		status: 'idle' | 'initializing' | 'indexing' | 'complete' | 'error';
		current: number;
		total: number;
		stage: string;
		chunksProcessed: number;
		throttleMessage: string | null;
		error: string | null;
		lastCompleted: string | null;
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

	// Shared Storage instance (owned by DaemonOwner)
	private storage: Storage | null = null;

	// SearchEngine singleton (lazy initialized)
	private searchEngine: SearchEngine | null = null;
	private warmupPromise: Promise<SearchEngine> | null = null;
	private warmupStartTime: number | null = null;

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
		// Check if project is initialized
		if (!(await configExists(this.projectRoot))) {
			throw new Error(
				`VibeRAG not initialized in ${this.projectRoot}. ` +
					`Run 'npx viberag' and use /init command first.`,
			);
		}

		// Load config
		this.config = await loadConfig(this.projectRoot);

		// Create service logger (writes to .viberag/logs/daemon/)
		try {
			this.logger = createServiceLogger(this.projectRoot, 'daemon');
		} catch {
			// Ignore - debug logging is optional
		}

		this.log('info', `Daemon initializing for ${this.projectRoot}`);

		// Create and connect shared Storage instance
		this.storage = new Storage(
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
					chunksAdded: stats.chunksAdded,
					chunksDeleted: stats.chunksDeleted,
				};
			});

			await this.watcher.start();
			this.log('info', 'File watcher started');
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
	private wireIndexingEvents(indexer: IndexingService): void {
		indexer.on('start', () => {
			daemonState.updateNested('indexing', () => ({
				status: 'initializing' as const,
				current: 0,
				total: 0,
				stage: '',
				chunksProcessed: 0,
				throttleMessage: null,
				error: null,
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

		indexer.on('progress', ({current, total, stage}) => {
			let status: 'scanning' | 'chunking' | 'embedding' = 'embedding';
			if (stage.toLowerCase().includes('scan')) {
				status = 'scanning';
			} else if (stage.toLowerCase().includes('chunk')) {
				status = 'chunking';
			}
			daemonState.updateNested('indexing', () => ({
				status,
				current,
				total,
				stage,
			}));
		});

		indexer.on('chunk-progress', ({chunksProcessed}) => {
			daemonState.updateNested('indexing', () => ({
				chunksProcessed,
			}));
		});

		indexer.on('throttle', ({message}) => {
			daemonState.updateNested('indexing', () => ({
				throttleMessage: message,
			}));
		});

		indexer.on('complete', () => {
			daemonState.updateNested('indexing', () => ({
				status: 'complete' as const,
				lastCompleted: new Date().toISOString(),
				throttleMessage: null,
			}));
			// Reset to idle after a short delay
			setTimeout(() => {
				const state = daemonState.getSnapshot();
				if (state.indexing.status === 'complete') {
					daemonState.updateNested('indexing', () => ({
						status: 'idle' as const,
					}));
				}
			}, 1000);
		});

		indexer.on('error', ({error}) => {
			daemonState.updateNested('indexing', () => ({
				status: 'error' as const,
				error: error.message,
			}));
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

		indexer.on('slot-failure', ({batchInfo, error}) => {
			daemonState.update(state => ({
				failures: [
					...state.failures,
					{batchInfo, error, timestamp: new Date().toISOString()},
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
				failures: [],
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

		this.warmupPromise = this.doWarmup().catch(error => {
			// Error captured in state, re-throw for chain
			throw error;
		});
	}

	/**
	 * Perform warmup - initialize SearchEngine with embedding provider.
	 */
	private async doWarmup(): Promise<SearchEngine> {
		this.warmupStartTime = Date.now();

		try {
			if (!this.config) {
				throw new Error('Config not loaded');
			}

			// Update state
			daemonState.updateNested('warmup', () => ({
				status: 'initializing' as const,
				provider: this.config!.embeddingProvider,
				error: null,
				startedAt: new Date().toISOString(),
			}));

			this.log('info', `Warming up ${this.config.embeddingProvider} provider`);

			// Create SearchEngine with shared storage
			const engine = new SearchEngine(this.projectRoot, {
				logger: this.logger ?? undefined,
				storage: this.storage ?? undefined,
			});

			// Timeout based on provider
			const isLocal = this.config.embeddingProvider.startsWith('local');
			const timeout = isLocal ? 180000 : 30000;

			const initPromise = engine.warmup();
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

			const elapsed = Date.now() - this.warmupStartTime;
			this.searchEngine = engine;

			daemonState.updateNested('warmup', () => ({
				status: 'ready' as const,
				readyAt: new Date().toISOString(),
			}));

			this.log('info', `Warmup complete (${elapsed}ms)`);

			return engine;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			daemonState.updateNested('warmup', () => ({
				status: 'failed' as const,
				error: message,
			}));

			this.log('error', `Warmup failed: ${message}`);

			// Clear promise to allow retry
			this.warmupPromise = null;

			throw error;
		}
	}

	/**
	 * Get the initialized SearchEngine.
	 */
	private async getSearchEngine(): Promise<SearchEngine> {
		if (this.searchEngine) {
			return this.searchEngine;
		}
		if (this.warmupPromise) {
			return this.warmupPromise;
		}
		// Start warmup and wait
		this.warmupPromise = this.doWarmup();
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
	): Promise<SearchResults> {
		const engine = await this.getSearchEngine();
		return engine.search(query, options);
	}

	/**
	 * Index the codebase.
	 */
	async index(options?: DaemonIndexOptions): Promise<IndexStats> {
		// Notify watcher that indexing is starting
		this.watcher?.setIndexingState(true);

		// Create IndexingService with shared storage
		const indexer = new IndexingService(this.projectRoot, {
			logger: this.logger ?? undefined,
			storage: this.storage ?? undefined,
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
			return stats;
		} finally {
			indexer.close();
			this.watcher?.setIndexingState(false);
		}
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
		if (this.warmupStartTime) {
			if (state.warmup.status === 'ready' || state.warmup.status === 'failed') {
				warmupElapsedMs = state.warmup.readyAt
					? new Date(state.warmup.readyAt).getTime() - this.warmupStartTime
					: Date.now() - this.warmupStartTime;
			} else if (state.warmup.status === 'initializing') {
				warmupElapsedMs = Date.now() - this.warmupStartTime;
			}
		}

		const status: DaemonStatus = {
			initialized: await configExists(this.projectRoot),
			indexed: await manifestExists(this.projectRoot),
			warmupStatus: state.warmup.status,
			warmupElapsedMs,
			watcherStatus: watcherStatus ?? {
				watching: false,
				filesWatched: 0,
				pendingChanges: 0,
				pendingPaths: [],
				lastIndexUpdate: null,
				indexUpToDate: false,
				lastError: null,
			},
			// Map indexing status for backwards compatibility
			indexing: {
				status: this.mapIndexingStatus(state.indexing.status),
				current: state.indexing.current,
				total: state.indexing.total,
				stage: state.indexing.stage,
				chunksProcessed: state.indexing.chunksProcessed,
				throttleMessage: state.indexing.throttleMessage,
				error: state.indexing.error,
				lastCompleted: state.indexing.lastCompleted,
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
			})),
		};

		// Add config info if available
		if (this.config) {
			status.embeddingProvider = this.config.embeddingProvider;
			status.embeddingModel = this.config.embeddingModel;
		}

		// Add manifest info if indexed
		if (status.indexed) {
			const manifest = await loadManifest(this.projectRoot);
			status.version = manifest.version;
			status.createdAt = manifest.createdAt;
			status.updatedAt = manifest.updatedAt;
			status.totalFiles = manifest.stats.totalFiles;
			status.totalChunks = manifest.stats.totalChunks;
		}

		return status;
	}

	/**
	 * Map internal indexing status to client-facing status.
	 */
	private mapIndexingStatus(
		status: DaemonState['indexing']['status'],
	): 'idle' | 'initializing' | 'indexing' | 'complete' | 'error' {
		switch (status) {
			case 'idle':
				return 'idle';
			case 'initializing':
				return 'initializing';
			case 'scanning':
			case 'chunking':
			case 'embedding':
				return 'indexing';
			case 'complete':
				return 'complete';
			case 'error':
				return 'error';
			default:
				return 'idle';
		}
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
		if (process.platform === 'win32') {
			// Windows named pipe - hash project root for unique name
			const hash = crypto
				.createHash('md5')
				.update(this.projectRoot)
				.digest('hex')
				.slice(0, 8);
			return `\\\\.\\pipe\\viberag-${hash}`;
		}
		return path.join(this.projectRoot, '.viberag', 'daemon.sock');
	}

	/**
	 * Get the PID file path for this project.
	 */
	getPidPath(): string {
		return path.join(this.projectRoot, '.viberag', 'daemon.pid');
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
