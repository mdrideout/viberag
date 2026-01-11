/**
 * Daemon Resource Owner
 *
 * Single owner of all mutable project state. The daemon owns:
 * - LanceDB connection (via Storage)
 * - FileWatcher (auto-indexing on file changes)
 * - SearchEngine (singleton, shared across requests)
 * - Indexer (on-demand, exclusive access via mutex)
 *
 * CLI and MCP clients access these resources via IPC.
 */

import * as crypto from 'node:crypto';
import path from 'node:path';
// Direct imports for fast startup
import {loadConfig, configExists} from '../rag/config/index.js';
import type {ViberagConfig} from '../rag/config/index.js';
import {loadManifest, manifestExists} from '../rag/manifest/index.js';
import {createDebugLogger, type Logger} from '../rag/logger/index.js';
import type {SearchResults} from '../rag/search/types.js';
import type {IndexStats} from '../rag/indexer/types.js';
import {store, WarmupActions} from '../store/index.js';
import {FileWatcher, type WatcherStatus} from '../mcp/watcher.js';

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
 * Status response for clients.
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
}

// ============================================================================
// Lazy Loader (avoid loading heavy modules at import time)
// ============================================================================

type SearchEngineType = typeof import('../rag/search/index.js').SearchEngine;
type IndexerType = typeof import('../rag/indexer/indexer.js').Indexer;

let SearchEngineClass: SearchEngineType | null = null;
let IndexerClass: IndexerType | null = null;

async function getSearchEngineClass(): Promise<SearchEngineType> {
	if (!SearchEngineClass) {
		const mod = await import('../rag/search/index.js');
		SearchEngineClass = mod.SearchEngine;
	}
	return SearchEngineClass;
}

async function getIndexerClass(): Promise<IndexerType> {
	if (!IndexerClass) {
		const mod = await import('../rag/indexer/indexer.js');
		IndexerClass = mod.Indexer;
	}
	return IndexerClass;
}

// ============================================================================
// Daemon Owner
// ============================================================================

/**
 * Owns and manages all daemon resources.
 */
export class DaemonOwner {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private logger: Logger | null = null;
	private watcher: FileWatcher | null = null;

	// SearchEngine singleton (lazy initialized)
	private searchEngine: InstanceType<SearchEngineType> | null = null;
	private warmupPromise: Promise<InstanceType<SearchEngineType>> | null = null;

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

		// Create debug logger
		try {
			this.logger = createDebugLogger(this.projectRoot);
		} catch {
			// Ignore - debug logging is optional
		}

		this.log('info', `Daemon initializing for ${this.projectRoot}`);

		// Start watcher (if enabled)
		if (this.config.watch?.enabled !== false) {
			this.watcher = new FileWatcher(this.projectRoot);
			await this.watcher.start();
			this.log('info', 'File watcher started');
		}

		// Start warmup in background (don't await)
		this.startWarmup();

		this.log('info', 'Daemon initialized');
	}

	/**
	 * Shutdown the daemon owner.
	 * Stops watcher, closes search engine.
	 */
	async shutdown(): Promise<void> {
		this.log('info', 'Daemon shutting down');

		// Stop watcher
		if (this.watcher) {
			await this.watcher.stop();
			this.watcher = null;
		}

		// Close search engine
		if (this.searchEngine) {
			this.searchEngine.close();
			this.searchEngine = null;
		}
		this.warmupPromise = null;

		this.log('info', 'Daemon shutdown complete');
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
	private async doWarmup(): Promise<InstanceType<SearchEngineType>> {
		const startTime = Date.now();

		try {
			if (!this.config) {
				throw new Error('Config not loaded');
			}

			// Dispatch to Redux
			store.dispatch(
				WarmupActions.start({provider: this.config.embeddingProvider}),
			);
			this.log('info', `Warming up ${this.config.embeddingProvider} provider`);

			// Lazy load SearchEngine
			const SearchEngine = await getSearchEngineClass();
			const engine = new SearchEngine(this.projectRoot);

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

			const elapsed = Date.now() - startTime;
			this.searchEngine = engine;

			store.dispatch(WarmupActions.ready({elapsedMs: elapsed}));
			this.log('info', `Warmup complete (${elapsed}ms)`);

			return engine;
		} catch (error) {
			const elapsed = Date.now() - startTime;
			const message = error instanceof Error ? error.message : String(error);

			store.dispatch(
				WarmupActions.failed({error: message, elapsedMs: elapsed}),
			);
			this.log('error', `Warmup failed: ${message}`);

			// Clear promise to allow retry
			this.warmupPromise = null;

			throw error;
		}
	}

	/**
	 * Get the initialized SearchEngine.
	 */
	private async getSearchEngine(): Promise<InstanceType<SearchEngineType>> {
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
		const Indexer = await getIndexerClass();
		const indexer = new Indexer(this.projectRoot, this.logger ?? undefined);

		try {
			// Handle force reindex - sync config dimensions
			if (options?.force && this.config) {
				const {PROVIDER_CONFIGS, saveConfig} =
					await import('../rag/config/index.js');
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
		}
	}

	/**
	 * Get daemon status.
	 */
	async getStatus(): Promise<DaemonStatus> {
		const warmupState = store.getState().warmup;

		const status: DaemonStatus = {
			initialized: await configExists(this.projectRoot),
			indexed: await manifestExists(this.projectRoot),
			warmupStatus: warmupState.status,
			warmupElapsedMs: warmupState.elapsedMs ?? undefined,
			watcherStatus: this.watcher?.getStatus() ?? {
				watching: false,
				filesWatched: 0,
				pendingChanges: 0,
				pendingPaths: [],
				lastIndexUpdate: null,
				indexUpToDate: false,
				lastError: null,
			},
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
