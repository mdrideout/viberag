/**
 * File Watcher Service for Auto-Indexing
 *
 * Watches the project directory for file changes and triggers
 * incremental indexing with debouncing and batching.
 *
 * Emits events for state changes instead of dispatching to Redux.
 */

import {watch, type FSWatcher} from 'chokidar';
import {loadConfig, type ViberagConfig} from '../lib/config.js';
import {hasValidExtension} from '../lib/merkle/hash.js';
import {loadGitignore} from '../lib/gitignore.js';
import {createServiceLogger, type Logger} from '../lib/logger.js';
import {TypedEmitter, type WatcherEvents} from './types.js';

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
 * Callback for triggering indexing.
 */
export type IndexTrigger = () => Promise<{
	chunksAdded: number;
	chunksDeleted: number;
}>;

/**
 * File watcher that triggers incremental indexing on changes.
 * Emits events for state changes - daemon owner wires events to state.
 */
export class FileWatcher extends TypedEmitter<WatcherEvents> {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private watcher: FSWatcher | null = null;
	private logger: Logger | null = null;
	private gitignore: Ignore | null = null;

	// Internal status tracking
	private filesWatched = 0;
	private lastIndexUpdate: string | null = null;
	private indexUpToDate = true;
	private lastError: string | null = null;

	// Batching state
	private pendingChanges: Set<string> = new Set();
	private batchTimeout: ReturnType<typeof setTimeout> | null = null;
	private debounceTimeout: ReturnType<typeof setTimeout> | null = null;

	// Indexing callback (set by daemon owner)
	private indexTrigger: IndexTrigger | null = null;
	private isIndexing = false;

	constructor(projectRoot: string) {
		super();
		this.projectRoot = projectRoot;
	}

	/**
	 * Set the indexing trigger callback.
	 * Called when the watcher needs to trigger an index update.
	 */
	setIndexTrigger(trigger: IndexTrigger): void {
		this.indexTrigger = trigger;
	}

	/**
	 * Notify watcher that indexing has started/stopped (called by daemon owner).
	 * When indexing completes, checks for accumulated changes and reschedules batch.
	 */
	setIndexingState(isIndexing: boolean): void {
		const wasIndexing = this.isIndexing;
		this.isIndexing = isIndexing;

		// When indexing completes, check if changes accumulated during indexing
		if (wasIndexing && !isIndexing && this.pendingChanges.size > 0) {
			this.log(
				'debug',
				`Changes accumulated during indexing (${this.pendingChanges.size}), scheduling batch`,
			);
			// Start a new batch timer to process accumulated changes
			if (!this.batchTimeout) {
				const watchConfig = this.config?.watch ?? {batchWindowMs: 2000};
				this.batchTimeout = setTimeout(() => {
					this.batchTimeout = null;
					this.processBatch();
				}, watchConfig.batchWindowMs);
			}
		}
	}

	/**
	 * Start watching the project directory.
	 */
	async start(): Promise<void> {
		if (this.watcher) {
			return; // Already watching
		}

		this.emit('watcher-start');

		// Load config
		this.config = await loadConfig(this.projectRoot);
		const watchConfig = this.config.watch;

		if (!watchConfig.enabled) {
			this.log('info', 'File watching disabled in config');
			this.emit('watcher-stopped');
			return;
		}

		// Load gitignore rules
		this.gitignore = await loadGitignore(this.projectRoot);

		// Initialize service logger
		try {
			this.logger = createServiceLogger(this.projectRoot, 'daemon');
		} catch {
			// Viberag dir may not exist yet, that's ok
		}

		this.log('info', `Starting file watcher for ${this.projectRoot}`);

		// Chokidar v5: watch directory '.' instead of glob '**/*'
		const ignored = (filePath: string): boolean => {
			const normalized = filePath.replace(/\\/g, '/');
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

		// Create watcher
		this.watcher = watch('.', {
			cwd: this.projectRoot,
			ignored,
			persistent: true,
			ignoreInitial: false,
			awaitWriteFinish: watchConfig.awaitWriteFinish
				? {
						stabilityThreshold: 300,
						pollInterval: 100,
					}
				: false,
			depth: 20,
		});

		// Wait for initial scan to complete
		await new Promise<void>((resolve, reject) => {
			if (!this.watcher) {
				reject(new Error('Watcher not initialized'));
				return;
			}

			this.watcher.on('add', path => {
				this.filesWatched++;
				this.handleChange('add', path);
			});

			this.watcher.on('change', path => {
				this.handleChange('change', path);
			});

			this.watcher.on('unlink', path => {
				this.filesWatched = Math.max(0, this.filesWatched - 1);
				this.handleChange('unlink', path);
			});

			this.watcher.on('error', error => {
				const message = error instanceof Error ? error.message : String(error);
				this.lastError = message;
				this.emit('watcher-error', {error: message});
				this.log('error', `Watcher error: ${message}`);
			});

			this.watcher.on('ready', () => {
				this.log('info', `Watcher ready, watching ${this.filesWatched} files`);
				this.emit('watcher-ready', {filesWatched: this.filesWatched});
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

		// Flush pending changes before stopping
		if (this.pendingChanges.size > 0 && !this.isIndexing) {
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
			this.filesWatched = 0;
			this.emit('watcher-stopped');
		}
	}

	/**
	 * Get current watcher status.
	 */
	getStatus(): WatcherStatus {
		return {
			watching: this.watcher !== null,
			filesWatched: this.filesWatched,
			pendingChanges: this.pendingChanges.size,
			pendingPaths: Array.from(this.pendingChanges).slice(0, 10),
			lastIndexUpdate: this.lastIndexUpdate,
			indexUpToDate: this.indexUpToDate && this.pendingChanges.size === 0,
			lastError: this.lastError,
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
	private handleChange(
		event: 'add' | 'change' | 'unlink',
		filePath: string,
	): void {
		if (!this.config || !this.gitignore) return;

		const normalizedPath = filePath.replace(/\\/g, '/');

		// Skip if path is ignored by gitignore
		if (this.gitignore.ignores(normalizedPath)) {
			return;
		}

		// If extensions configured, filter by extension
		if (
			event !== 'unlink' &&
			this.config.extensions.length > 0 &&
			!hasValidExtension(normalizedPath, this.config.extensions)
		) {
			return;
		}

		this.log('debug', `File ${event}: ${normalizedPath}`);

		// Add to pending changes
		this.pendingChanges.add(normalizedPath);
		this.indexUpToDate = false;

		// Emit debouncing event
		this.emit('watcher-debouncing', {
			pendingPaths: Array.from(this.pendingChanges),
		});

		// Debounce: reset the debounce timer on each change
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
		}

		const watchConfig = this.config.watch;

		this.debounceTimeout = setTimeout(() => {
			this.debounceTimeout = null;

			// Start batch window if not already started
			if (!this.batchTimeout) {
				this.emit('watcher-batching');
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
	private async processBatch(): Promise<void> {
		if (this.pendingChanges.size === 0) {
			return;
		}

		// Don't trigger if already indexing
		if (this.isIndexing) {
			this.log('debug', 'Index already in progress, deferring batch');
			return;
		}

		const filesToProcess = Array.from(this.pendingChanges);
		this.pendingChanges.clear();

		this.log(
			'info',
			`Processing batch of ${filesToProcess.length} changed files`,
		);

		if (!this.indexTrigger) {
			this.log('warn', 'No index trigger set, skipping batch');
			return;
		}

		try {
			const result = await this.indexTrigger();

			this.lastIndexUpdate = new Date().toISOString();
			this.indexUpToDate = true;
			this.lastError = null;

			this.emit('watcher-indexed', {
				chunksAdded: result.chunksAdded,
				chunksDeleted: result.chunksDeleted,
			});

			this.log(
				'info',
				`Index updated: ${result.chunksAdded} added, ${result.chunksDeleted} deleted`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = message;
			this.emit('watcher-error', {error: message});
			this.log('error', `Index update failed: ${message}`);

			// Put files back in pending queue for retry
			filesToProcess.forEach(f => this.pendingChanges.add(f));
		}
	}

	/**
	 * Force an immediate index update.
	 */
	async forceUpdate(): Promise<void> {
		// Clear timeouts
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = null;
		}
		if (this.batchTimeout) {
			clearTimeout(this.batchTimeout);
			this.batchTimeout = null;
		}

		await this.processBatch();
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
