/**
 * File Watcher Service for Auto-Indexing
 *
 * Watches the project directory for file changes and triggers
 * incremental indexing with debouncing and batching.
 *
 * Emits events for state changes instead of dispatching to Redux.
 */

import {watch, type FSWatcher} from 'chokidar';
import path from 'node:path';
import {loadConfig, type ViberagConfig} from '../lib/config.js';
import {hasValidExtension} from '../lib/merkle/hash.js';
import {
	ALWAYS_IGNORED_DIRS,
	clearGitignoreCache,
	loadGitignore,
} from '../lib/gitignore.js';
import {isAbortError} from '../lib/abort.js';
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
	/** When auto-indexing resumes (ISO string) */
	autoIndexPausedUntil: string | null;
	/** Reason for auto-index pause */
	autoIndexPauseReason: string | null;
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
	private gitignoreReloadPromise: Promise<void> | null = null;
	private autoIndexPausedUntil: number | null = null;
	private autoIndexPauseReason: string | null = null;
	private autoIndexResumeTimeout: ReturnType<typeof setTimeout> | null = null;

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
			if (this.isAutoIndexingPaused()) {
				this.log(
					'debug',
					'Auto-indexing paused, deferring accumulated changes',
				);
				this.scheduleAutoIndexResume();
				return;
			}
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
	 * Pause auto-indexing for a short cooldown window.
	 */
	pauseAutoIndexing(durationMs: number, reason?: string): void {
		const now = Date.now();
		const nextUntil = now + Math.max(0, durationMs);
		const pausedUntil = this.autoIndexPausedUntil
			? Math.max(this.autoIndexPausedUntil, nextUntil)
			: nextUntil;
		this.autoIndexPausedUntil = pausedUntil;
		this.autoIndexPauseReason = reason ?? 'paused';

		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = null;
		}
		if (this.batchTimeout) {
			clearTimeout(this.batchTimeout);
			this.batchTimeout = null;
		}
		if (this.autoIndexResumeTimeout) {
			clearTimeout(this.autoIndexResumeTimeout);
			this.autoIndexResumeTimeout = null;
		}

		this.scheduleAutoIndexResume();
		const remainingSeconds = Math.max(
			0,
			Math.round((pausedUntil - now) / 1000),
		);
		this.log(
			'info',
			`Auto-indexing paused for ${remainingSeconds}s (${this.autoIndexPauseReason})`,
		);
	}

	private isAutoIndexingPaused(): boolean {
		if (!this.autoIndexPausedUntil) {
			return false;
		}
		if (Date.now() >= this.autoIndexPausedUntil) {
			this.clearAutoIndexPause();
			return false;
		}
		return true;
	}

	private clearAutoIndexPause(): void {
		if (this.autoIndexResumeTimeout) {
			clearTimeout(this.autoIndexResumeTimeout);
			this.autoIndexResumeTimeout = null;
		}
		this.autoIndexPausedUntil = null;
		this.autoIndexPauseReason = null;
	}

	private scheduleAutoIndexResume(): void {
		if (!this.autoIndexPausedUntil) {
			return;
		}
		const delay = Math.max(0, this.autoIndexPausedUntil - Date.now());
		if (this.autoIndexResumeTimeout) {
			clearTimeout(this.autoIndexResumeTimeout);
		}
		this.autoIndexResumeTimeout = setTimeout(() => {
			this.autoIndexResumeTimeout = null;
			if (this.isAutoIndexingPaused()) {
				this.scheduleAutoIndexResume();
				return;
			}
			if (!this.isIndexing && this.pendingChanges.size > 0) {
				void this.processBatch();
			}
		}, delay);
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
			const {relativePath, isOutside} = this.normalizePathForIgnore(filePath);
			if (isOutside) {
				return true;
			}

			if (!relativePath) {
				return false;
			}

			for (const dir of ALWAYS_IGNORED_DIRS) {
				if (
					relativePath === dir ||
					relativePath.startsWith(`${dir}/`) ||
					relativePath.includes(`/${dir}/`) ||
					relativePath.includes(`/${dir}`)
				) {
					return true;
				}
			}

			return this.gitignore?.ignores(relativePath) ?? false;
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
		const paused = this.isAutoIndexingPaused();
		const pausedUntil =
			paused && this.autoIndexPausedUntil
				? new Date(this.autoIndexPausedUntil).toISOString()
				: null;

		return {
			watching: this.watcher !== null,
			filesWatched: this.filesWatched,
			pendingChanges: this.pendingChanges.size,
			pendingPaths: Array.from(this.pendingChanges).slice(0, 10),
			lastIndexUpdate: this.lastIndexUpdate,
			indexUpToDate: this.indexUpToDate && this.pendingChanges.size === 0,
			lastError: this.lastError,
			autoIndexPausedUntil: pausedUntil,
			autoIndexPauseReason: paused ? this.autoIndexPauseReason : null,
		};
	}

	/**
	 * Check if watcher is active.
	 */
	isWatching(): boolean {
		return this.watcher !== null;
	}

	/**
	 * Normalize a path to a gitignore-safe relative path.
	 */
	private normalizePathForIgnore(filePath: string): {
		relativePath: string | null;
		isOutside: boolean;
	} {
		if (!filePath) {
			return {relativePath: null, isOutside: false};
		}

		if (path.isAbsolute(filePath)) {
			const relative = path.relative(this.projectRoot, filePath);
			if (!relative) {
				return {relativePath: null, isOutside: false};
			}

			const normalizedRelative = relative
				.replace(/\\/g, '/')
				.replace(/^\.\//, '');
			if (normalizedRelative === '.') {
				return {relativePath: null, isOutside: false};
			}

			if (
				normalizedRelative === '..' ||
				normalizedRelative.startsWith('..') ||
				path.isAbsolute(relative)
			) {
				return {relativePath: null, isOutside: true};
			}

			return {relativePath: normalizedRelative, isOutside: false};
		}

		const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
		if (!normalized || normalized === '.' || normalized === '..') {
			return {relativePath: null, isOutside: false};
		}

		if (normalized.startsWith('/')) {
			return {relativePath: normalized.slice(1), isOutside: false};
		}

		return {relativePath: normalized, isOutside: false};
	}

	/**
	 * Handle a file change event.
	 */
	private handleChange(
		event: 'add' | 'change' | 'unlink',
		filePath: string,
	): void {
		if (!this.config || !this.gitignore) return;

		const {relativePath, isOutside} = this.normalizePathForIgnore(filePath);
		if (isOutside || !relativePath) {
			return;
		}

		const normalizedPath = relativePath;
		const isGitignore = normalizedPath === '.gitignore';

		if (isGitignore) {
			this.reloadGitignore();
		}

		// Skip if path is ignored by gitignore
		if (!isGitignore && this.gitignore.ignores(normalizedPath)) {
			return;
		}

		// If extensions configured, filter by extension
		if (
			event !== 'unlink' &&
			this.config.extensions.length > 0 &&
			!isGitignore &&
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

		if (this.isAutoIndexingPaused()) {
			this.log('debug', 'Auto-indexing paused, deferring changes');
			this.scheduleAutoIndexResume();
			return;
		}

		// Debounce: reset the debounce timer on each change
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
		}

		const watchConfig = this.config.watch;

		this.debounceTimeout = setTimeout(() => {
			this.debounceTimeout = null;

			if (this.isAutoIndexingPaused()) {
				this.log('debug', 'Auto-indexing paused, deferring batch window');
				this.scheduleAutoIndexResume();
				return;
			}

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
		if (this.isAutoIndexingPaused()) {
			this.log('debug', 'Auto-indexing paused, deferring batch');
			this.scheduleAutoIndexResume();
			return;
		}

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
			if (isAbortError(error)) {
				this.log('info', 'Index update cancelled, deferring pending changes');
				this.lastError = null;
				this.indexUpToDate = false;
				filesToProcess.forEach(f => this.pendingChanges.add(f));
				this.emit('watcher-debouncing', {
					pendingPaths: Array.from(this.pendingChanges),
				});
				this.scheduleAutoIndexResume();
				return;
			}

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

	/**
	 * Reload gitignore rules when .gitignore changes.
	 */
	private reloadGitignore(): void {
		if (this.gitignoreReloadPromise) {
			return;
		}

		this.gitignoreReloadPromise = (async () => {
			clearGitignoreCache(this.projectRoot);
			this.gitignore = await loadGitignore(this.projectRoot);
			this.log('info', 'Reloaded .gitignore rules');
		})()
			.catch(error => {
				const message = error instanceof Error ? error.message : String(error);
				this.log('error', `Failed to reload .gitignore: ${message}`);
			})
			.finally(() => {
				this.gitignoreReloadPromise = null;
			});
	}
}
