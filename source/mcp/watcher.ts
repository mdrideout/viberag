/**
 * File Watcher for Auto-Indexing
 *
 * Watches the project directory for file changes and triggers
 * incremental indexing with debouncing and batching.
 */

import {watch, type FSWatcher} from 'chokidar';
import {
	Indexer,
	loadConfig,
	hasValidExtension,
	shouldExclude,
	createLogger,
	getLogsDir,
	type ViberagConfig,
	type IndexStats,
	type Logger,
} from '../rag/index.js';

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
 */
export class FileWatcher {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private watcher: FSWatcher | null = null;
	private logger: Logger | null = null;

	// Batching state
	private pendingChanges: Set<string> = new Set();
	private batchTimeout: ReturnType<typeof setTimeout> | null = null;
	private debounceTimeout: ReturnType<typeof setTimeout> | null = null;

	// Status tracking
	private filesWatched = 0;
	private lastIndexUpdate: string | null = null;
	private indexUpToDate = true;
	private lastError: string | null = null;
	private isIndexing = false;

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

		// Load config
		this.config = await loadConfig(this.projectRoot);
		const watchConfig = this.config.watch;

		if (!watchConfig.enabled) {
			this.log('info', 'File watching disabled in config');
			return;
		}

		// Initialize logger
		try {
			const logsDir = getLogsDir(this.projectRoot);
			this.logger = createLogger(logsDir);
		} catch {
			// Logs dir may not exist yet, that's ok
		}

		this.log('info', `Starting file watcher for ${this.projectRoot}`);

		// Build glob patterns for extensions
		const extensions = this.config.extensions;
		const patterns = extensions.map(ext => `**/*${ext}`);

		// Build ignore patterns
		const ignored = [
			...this.config.excludePatterns.map(p => `**/${p}/**`),
			'**/node_modules/**',
			'**/.git/**',
			'**/.viberag/**',
		];

		// Create watcher
		this.watcher = watch(patterns, {
			cwd: this.projectRoot,
			ignored,
			persistent: true,
			ignoreInitial: watchConfig.ignoreInitial,
			awaitWriteFinish: watchConfig.awaitWriteFinish
				? {
						stabilityThreshold: 300,
						pollInterval: 100,
					}
				: false,
			depth: 20, // Reasonable depth limit
		});

		// Track file count
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
			this.log('error', `Watcher error: ${message}`);
		});

		this.watcher.on('ready', () => {
			this.log(
				'info',
				`Watcher ready, watching ${this.filesWatched} files`,
			);
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

		await this.watcher.close();
		this.watcher = null;
		this.filesWatched = 0;
		this.pendingChanges.clear();
	}

	/**
	 * Get current watcher status.
	 */
	getStatus(): WatcherStatus {
		return {
			watching: this.watcher !== null,
			filesWatched: this.filesWatched,
			pendingChanges: this.pendingChanges.size,
			pendingPaths: Array.from(this.pendingChanges).slice(0, 10), // Limit to 10
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
		path: string,
	): void {
		if (!this.config) return;

		// Skip if file doesn't match our extensions (shouldn't happen due to glob, but double-check)
		if (
			event !== 'unlink' &&
			!hasValidExtension(path, this.config.extensions)
		) {
			return;
		}

		// Skip if path matches exclude patterns
		if (shouldExclude(path, this.config.excludePatterns)) {
			return;
		}

		this.log('debug', `File ${event}: ${path}`);

		// Add to pending changes
		this.pendingChanges.add(path);
		this.indexUpToDate = false;

		// Debounce: reset the debounce timer on each change
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
		}

		const watchConfig = this.config.watch;

		this.debounceTimeout = setTimeout(() => {
			this.debounceTimeout = null;

			// Start batch window if not already started
			if (!this.batchTimeout) {
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

		if (this.isIndexing) {
			this.log('debug', 'Index already in progress, skipping batch');
			return {success: false, error: 'Index in progress', filesProcessed: []};
		}

		const filesToProcess = Array.from(this.pendingChanges);
		this.pendingChanges.clear();

		this.log(
			'info',
			`Processing batch of ${filesToProcess.length} changed files`,
		);
		this.isIndexing = true;

		try {
			const indexer = new Indexer(this.projectRoot, this.logger ?? undefined);
			const stats = await indexer.index({force: false});
			indexer.close();

			this.lastIndexUpdate = new Date().toISOString();
			this.indexUpToDate = true;
			this.lastError = null;

			this.log(
				'info',
				`Index updated: ${stats.chunksAdded} added, ${stats.chunksDeleted} deleted`,
			);

			return {success: true, stats, filesProcessed: filesToProcess};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = message;
			this.log('error', `Index update failed: ${message}`);

			// Put files back in pending queue for retry
			filesToProcess.forEach(f => this.pendingChanges.add(f));

			return {success: false, error: message, filesProcessed: []};
		} finally {
			this.isIndexing = false;
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
