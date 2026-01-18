/**
 * Client Types
 *
 * Types for daemon client communication.
 * Simplified for polling-based architecture.
 */

import type {SearchResults} from '../daemon/services/search/types.js';
import type {IndexStats} from '../daemon/services/indexing.js';
import type {WatcherStatus} from '../daemon/services/watcher.js';
import type {IndexingPhase, IndexingUnit} from '../daemon/services/types.js';

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

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Options for DaemonClient constructor.
 */
export interface DaemonClientOptions {
	/** Project root directory */
	projectRoot: string;
	/** Auto-start daemon if not running (default: true) */
	autoStart?: boolean;
	/** Connection timeout in ms (default: 5000) */
	connectTimeout?: number;
}

// ============================================================================
// API Types
// ============================================================================

/**
 * Search options for client.
 */
export interface ClientSearchOptions {
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
 * Index options for client.
 */
export interface ClientIndexOptions {
	force?: boolean;
}

/**
 * Index start response for async indexing.
 */
export interface IndexStartResponse {
	started: boolean;
	reason?: 'in_progress';
}

/**
 * Daemon status response.
 * Enhanced to support polling-based state synchronization.
 */
export interface DaemonStatusResponse {
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
		lastStats: IndexStats | null;
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

/**
 * Ping response.
 */
export interface PingResponse {
	pong: boolean;
	timestamp: number;
	protocolVersion: number;
}

/**
 * Cancel response for daemon activity cancellation.
 */
export interface CancelResponse {
	cancelled: boolean;
	targets: Array<'indexing' | 'warmup'>;
	skipped: Array<'indexing' | 'warmup'>;
	reason: string | null;
	message: string;
}

// Re-export for convenience
export type {SearchResults, IndexStats, WatcherStatus};
