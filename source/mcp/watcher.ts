/**
 * File Watcher for Auto-Indexing
 *
 * Watches the project directory for file changes and triggers
 * incremental indexing with debouncing and batching.
 *
 * State is tracked in Redux for consistency with the rest of the codebase.
 */

import {watch, type FSWatcher} from 'chokidar';
// Direct imports for fast startup (avoid barrel file)
import {loadConfig, type ViberagConfig} from '../rag/config/index.js';
import {hasValidExtension} from '../rag/merkle/hash.js';
import {loadGitignore} from '../rag/gitignore/index.js';
import {createDebugLogger, type Logger} from '../rag/logger/index.js';
import {getIndexer} from './services/lazy-loader.js';
import type {IndexStats} from '../rag/indexer/types.js';
import {store, WatcherActions, selectIsIndexing} from '../store/index.js';

// Simplified Ignore interface (subset of the ignore package)
interface Ignore {
	ignores(pathname: string): boolean;
}

/**
 * Watcher status for reporting.
 */
export interface WatcherStatus {
	/** Whether the watcher is currently active */
	watching: boolean;
	/** Number of files being watched */
	filesWatched: number;
	/** Number of changes pending in the batch */
	pendingChanges: number;
	/** Paths of pending changes */
	pendingPaths: string[];
	/** Last index update timestamp (ISO string) */
	lastIndexUpdate: string | null;
	/** Whether the index is up to date */
	indexUpToDate: boolean;
	/** Last error message if any */
	lastError: string | null;
}

/**
 * Result of an index update triggered by the watcher.
 */
export interface WatcherIndexResult {
	success: boolean;
	stats?: IndexStats;
	error?: string;
	filesProcessed: string[];
}

/**
 * File watcher that triggers incremental indexing on changes.
 * State is tracked in Redux - class only holds references and batching logic.
 */
export class FileWatcher {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private watcher: FSWatcher | null = null;
	private logger: Logger | null = null;
	private gitignore: Ignore | null = null;

	// Batching state (internal, not in Redux)
	private pendingChanges: Set<string> = new Set();
	private batchTimeout: ReturnType<typeof setTimeout> | null = null;
	private debounceTimeout: ReturnType<typeof setTimeout> | null = null;

	// Status tracking is now in Redux - no local state fields

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	/**
	 * Start watching the project directory.
	 */
	async start(): Promise<void> {
		if (this.watcher) {
			return; // Already watching
		}

		// Dispatch to Redux: starting
		store.dispatch(WatcherActions.starting());

		// Load config
		this.config = await loadConfig(this.projectRoot);
		const watchConfig = this.config.watch;

		if (!watchConfig.enabled) {
			this.log('info', 'File watching disabled in config');
			store.dispatch(WatcherActions.stopped());
			return;
		}

		// Load gitignore rules
		this.gitignore = await loadGitignore(this.projectRoot);

		// Initialize debug logger (always-on logging to .viberag/debug.log)
		try {
			this.logger = createDebugLogger(this.projectRoot);
		} catch {
			// Viberag dir may not exist yet, that's ok
		}

		this.log('info', `Starting file watcher for ${this.projectRoot}`);

		// Chokidar v5: watch directory '.' instead of glob '**/*'
		// Paths are relative to cwd when cwd is set
		// ignored must be a function (glob arrays removed in v4+)
		const ignored = (filePath: string): boolean => {
			// Normalize path separators for cross-platform
			const normalized = filePath.replace(/\\/g, '/');

			// Check if path starts with or contains ignored directories
			// Paths are relative to cwd, e.g.: '.git', 'src/index.ts', 'node_modules/pkg/...'
			const ignoredDirs = ['.git', '.viberag', 'node_modules'];

			for (const dir of ignoredDirs) {
				if (
					normalized === dir ||
					normalized.startsWith(`${dir}/`) ||
					normalized.includes(`/${dir}/`) ||
					normalized.includes(`/${dir}`)
				) {
					return true;
				}
			}

			return false;
		};

		// Create watcher - watch '.' (current directory) recursively
		this.watcher = watch('.', {
			cwd: this.projectRoot,
			ignored,
			persistent: true,
			// Emit events for existing files so we can count them
			ignoreInitial: false,
			awaitWriteFinish: watchConfig.awaitWriteFinish
				? {
						stabilityThreshold: 300,
						pollInterval: 100,
					}
				: false,
			depth: 20, // Reasonable depth limit
		});

		// Wait for initial scan to complete before returning
		await new Promise<void>((resolve, reject) => {
			if (!this.watcher) {
				reject(new Error('Watcher not initialized'));
				return;
			}

			// Track file count via Redux
			this.watcher.on('add', path => {
				store.dispatch(WatcherActions.fileAdded());
				this.handleChange('add', path);
			});

			this.watcher.on('change', path => {
				this.handleChange('change', path);
			});

			this.watcher.on('unlink', path => {
				store.dispatch(WatcherActions.fileDeleted());
				this.handleChange('unlink', path);
			});

			this.watcher.on('error', error => {
				const message = error instanceof Error ? error.message : String(error);
				store.dispatch(WatcherActions.error({error: message}));
				this.log('error', `Watcher error: ${message}`);
				// Don't reject on error - watcher can continue with partial coverage
			});

			this.watcher.on('ready', () => {
				const filesWatched = store.getState().watcher.filesWatched;
				this.log('info', `Watcher ready, watching ${filesWatched} files`);
				// Dispatch to Redux: ready (with count from Redux)
				store.dispatch(WatcherActions.ready({filesWatched}));
				resolve();
			});
		});
	}

	/**
	 * Stop the file watcher.
	 */
	async stop(): Promise<void> {
		if (!this.watcher) {
			return;
		}

		this.log('info', 'Stopping file watcher');

		// Clear any pending timeouts
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = null;
		}
		if (this.batchTimeout) {
			clearTimeout(this.batchTimeout);
			this.batchTimeout = null;
		}

		// Flush pending changes before stopping (check indexing slice - single source of truth)
		const isIndexing = selectIsIndexing(store.getState());
		if (this.pendingChanges.size > 0 && !isIndexing) {
			this.log('info', 'Flushing pending changes before stop');
			await this.processBatch();
		}

		try {
			await this.watcher.close();
		} catch (error) {
			this.log(
				'error',
				`Error closing watcher: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.watcher = null;
			this.pendingChanges.clear();
			// Dispatch to Redux: stopped (resets all state)
			store.dispatch(WatcherActions.stopped());
		}
	}

	/**
	 * Get current watcher status from Redux.
	 */
	getStatus(): WatcherStatus {
		const state = store.getState().watcher;
		return {
			watching: this.watcher !== null,
			filesWatched: state.filesWatched,
			pendingChanges: this.pendingChanges.size,
			pendingPaths: Array.from(this.pendingChanges).slice(0, 10), // Limit to 10
			lastIndexUpdate: state.lastIndexUpdate,
			indexUpToDate: state.indexUpToDate && this.pendingChanges.size === 0,
			lastError: state.lastError,
		};
	}

	/**
	 * Check if watcher is active.
	 */
	isWatching(): boolean {
		return this.watcher !== null;
	}

	/**
	 * Handle a file change event.
	 */
	private handleChange(event: 'add' | 'change' | 'unlink', path: string): void {
		if (!this.config || !this.gitignore) return;

		// Skip if path is ignored by gitignore
		if (this.gitignore.ignores(path)) {
			return;
		}

		// If extensions configured, filter by extension
		// Empty extensions array means watch all files
		if (
			event !== 'unlink' &&
			this.config.extensions.length > 0 &&
			!hasValidExtension(path, this.config.extensions)
		) {
			return;
		}

		this.log('debug', `File ${event}: ${path}`);

		// Add to pending changes
		this.pendingChanges.add(path);

		// Dispatch to Redux: debouncing with pending paths (sets indexUpToDate=false)
		store.dispatch(
			WatcherActions.debouncing({
				pendingPaths: Array.from(this.pendingChanges),
			}),
		);

		// Debounce: reset the debounce timer on each change
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
		}

		const watchConfig = this.config.watch;

		this.debounceTimeout = setTimeout(() => {
			this.debounceTimeout = null;

			// Start batch window if not already started
			if (!this.batchTimeout) {
				// Dispatch to Redux: batching
				store.dispatch(WatcherActions.batching());
				this.batchTimeout = setTimeout(() => {
					this.batchTimeout = null;
					this.processBatch();
				}, watchConfig.batchWindowMs);
			}
		}, watchConfig.debounceMs);
	}

	/**
	 * Process the batch of pending changes.
	 */
	private async processBatch(): Promise<WatcherIndexResult> {
		if (this.pendingChanges.size === 0) {
			return {success: true, filesProcessed: []};
		}

		// Check indexing slice (single source of truth) - don't trigger if already indexing
		if (selectIsIndexing(store.getState())) {
			this.log('debug', 'Index already in progress, deferring batch');
			// Don't clear pendingChanges - keep them for next attempt
			return {success: false, error: 'Index in progress', filesProcessed: []};
		}

		const filesToProcess = Array.from(this.pendingChanges);
		this.pendingChanges.clear();

		this.log(
			'info',
			`Processing batch of ${filesToProcess.length} changed files`,
		);

		// Transition watcher back to 'watching' BEFORE triggering indexer.
		// The indexer will update indexing.status (single source of truth),
		// not watcher.status. This allows watcher to continue detecting
		// and queuing new changes while indexing runs.
		const filesWatched = store.getState().watcher.filesWatched;
		store.dispatch(WatcherActions.ready({filesWatched}));

		try {
			// Lazy load Indexer to avoid loading tree-sitter at server startup
			const Indexer = await getIndexer();
			const indexer = new Indexer(this.projectRoot, this.logger ?? undefined);
			const stats = await indexer.index({force: false});
			indexer.close();

			// Dispatch to Redux: indexed (sets lastIndexUpdate, indexUpToDate, clears error)
			store.dispatch(
				WatcherActions.indexed({
					chunksAdded: stats.chunksAdded,
					chunksDeleted: stats.chunksDeleted,
				}),
			);

			this.log(
				'info',
				`Index updated: ${stats.chunksAdded} added, ${stats.chunksDeleted} deleted`,
			);

			return {success: true, stats, filesProcessed: filesToProcess};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			// Dispatch to Redux: indexFailed (sets lastError)
			store.dispatch(WatcherActions.indexFailed({error: message}));

			this.log('error', `Index update failed: ${message}`);

			// Put files back in pending queue for retry
			filesToProcess.forEach(f => this.pendingChanges.add(f));

			return {success: false, error: message, filesProcessed: []};
		}
	}

	/**
	 * Force an immediate index update.
	 */
	async forceUpdate(): Promise<WatcherIndexResult> {
		// Clear timeouts
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = null;
		}
		if (this.batchTimeout) {
			clearTimeout(this.batchTimeout);
			this.batchTimeout = null;
		}

		return this.processBatch();
	}

	/**
	 * Log a message.
	 */
	private log(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
	): void {
		const prefix = '[Watcher]';
		if (this.logger) {
			this.logger[level](prefix, message);
		}
		// Also log to stderr for MCP visibility
		if (level === 'error') {
			console.error(`${prefix} ${message}`);
		}
	}
}
