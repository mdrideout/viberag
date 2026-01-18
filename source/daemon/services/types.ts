/**
 * Service Types - Event interfaces and utilities for daemon services.
 *
 * All services emit events instead of dispatching Redux actions.
 * The daemon owner wires these events to state updates.
 */

import {EventEmitter} from 'node:events';

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Base service interface with lifecycle methods.
 */
export interface Service {
	/** Initialize the service (load resources, connect to DB, etc.) */
	initialize(): Promise<void>;
	/** Clean up resources */
	close(): Promise<void>;
}

// ============================================================================
// Index Stats
// ============================================================================

/**
 * Statistics returned from an indexing operation.
 */
export interface IndexStats {
	/** Number of files processed */
	filesProcessed: number;
	/** Number of new chunks added to the index */
	chunksAdded: number;
	/** Number of chunks deleted from the index */
	chunksDeleted: number;
	/** Number of chunks that were unchanged */
	chunksUnchanged: number;
	/** Total duration of the indexing operation in milliseconds */
	durationMs: number;
}

// ============================================================================
// Indexing Events
// ============================================================================

/**
 * Indexing phases for structured progress updates.
 */
export type IndexingPhase =
	| 'init'
	| 'scan'
	| 'chunk'
	| 'embed'
	| 'persist'
	| 'finalize';

/**
 * Units for progress reporting.
 */
export type IndexingUnit = 'files' | 'chunks' | 'percent';

/**
 * Progress events emitted by IndexingService.
 */
export interface IndexingEvents {
	/** Indexing started */
	start: [];

	/** Progress update during indexing */
	progress: [
		data: {
			phase: IndexingPhase;
			current: number;
			total: number;
			unit: IndexingUnit | null;
			stage: string;
		},
	];

	/** Chunk processing progress */
	'chunk-progress': [data: {chunksProcessed: number}];

	/** Rate limiting message from embedding provider (null clears) */
	throttle: [data: {message: string | null}];

	/** Indexing completed successfully */
	complete: [data: {stats: IndexStats}];

	/** Indexing failed */
	error: [data: {error: Error}];

	/** Indexing cancelled */
	cancelled: [data: {reason: string | null}];
}

// ============================================================================
// Slot Events (Embedding Concurrency)
// ============================================================================

/**
 * Events for concurrent embedding slot tracking.
 */
export interface SlotEvents {
	/** Slot started processing a batch */
	'slot-processing': [data: {slot: number; batchInfo: string}];

	/** Slot is rate-limited, waiting to retry */
	'slot-rate-limited': [data: {slot: number; retryInfo: string}];

	/** Slot completed successfully */
	'slot-success': [data: {slot: number}];

	/** Slot failed after retries */
	'slot-failure': [
		data: {
			slot: number;
			error: string;
			batchInfo: string;
			files: string[];
			chunkCount: number;
		},
	];

	/** Slot returned to idle state */
	'slot-idle': [data: {slot: number}];

	/** Reset all slots to idle */
	'slots-reset': [];
}

// ============================================================================
// Search Events
// ============================================================================

/**
 * Events emitted by SearchService.
 */
export interface SearchEvents {
	/** Search started */
	'search-start': [data: {query: string}];

	/** Search completed */
	'search-complete': [data: {resultCount: number; durationMs: number}];
}

// ============================================================================
// Watcher Events
// ============================================================================

/**
 * Events emitted by FileWatcher service.
 */
export interface WatcherEvents {
	/** Watcher started */
	'watcher-start': [];

	/** Watcher is ready (initial scan complete) */
	'watcher-ready': [data: {filesWatched: number}];

	/** File change detected, debouncing */
	'watcher-debouncing': [data: {pendingPaths: string[]}];

	/** Starting to process batched changes */
	'watcher-batching': [];

	/** Index update completed from watcher */
	'watcher-indexed': [data: {chunksAdded: number; chunksDeleted: number}];

	/** Watcher stopped */
	'watcher-stopped': [];

	/** Watcher error */
	'watcher-error': [data: {error: string}];
}

// ============================================================================
// Warmup Events
// ============================================================================

/**
 * Events emitted during embedding provider warmup.
 */
export interface WarmupEvents {
	/** Warmup started */
	'warmup-start': [data: {provider: string}];

	/** Warmup completed successfully */
	'warmup-ready': [data: {elapsedMs: number}];

	/** Warmup failed */
	'warmup-failed': [data: {error: string; elapsedMs: number}];
}

// ============================================================================
// Typed Event Emitter
// ============================================================================

/**
 * Type-safe event emitter for services.
 *
 * Usage:
 * ```typescript
 * class MyService extends TypedEmitter<IndexingEvents & SlotEvents> {
 *   doWork() {
 *     this.emit('progress', {
 *       phase: 'embed',
 *       current: 5,
 *       total: 10,
 *       unit: 'chunks',
 *       stage: 'Embedding chunks',
 *     });
 *   }
 * }
 *
 * const service = new MyService();
 * service.on('progress', ({ current, total, stage, unit }) => {
 *   console.log(`${current}/${total} ${unit ?? ''}: ${stage}`);
 * });
 * ```
 */
export class TypedEmitter<
	T extends {[K in keyof T]: unknown[]},
> extends EventEmitter {
	/**
	 * Emit a typed event.
	 */
	override emit<K extends keyof T & string>(event: K, ...args: T[K]): boolean {
		return super.emit(event, ...args);
	}

	/**
	 * Subscribe to a typed event.
	 */
	override on<K extends keyof T & string>(
		event: K,
		listener: (...args: T[K]) => void,
	): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}

	/**
	 * Subscribe to a typed event (once).
	 */
	override once<K extends keyof T & string>(
		event: K,
		listener: (...args: T[K]) => void,
	): this {
		return super.once(event, listener as (...args: unknown[]) => void);
	}

	/**
	 * Remove a typed event listener.
	 */
	override off<K extends keyof T & string>(
		event: K,
		listener: (...args: T[K]) => void,
	): this {
		return super.off(event, listener as (...args: unknown[]) => void);
	}
}

// ============================================================================
// Combined Event Types
// ============================================================================

/**
 * All daemon service events combined.
 */
export type AllDaemonEvents = IndexingEvents &
	SlotEvents &
	SearchEvents &
	WatcherEvents &
	WarmupEvents;
