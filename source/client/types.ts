/**
 * Client Types
 *
 * Types for daemon client communication.
 * Simplified for polling-based architecture.
 */

import type {SearchResults} from '../daemon/services/search/types.js';
import type {IndexStats} from '../daemon/services/indexing.js';
import type {WatcherStatus} from '../daemon/services/watcher.js';

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
		lastStats: IndexStats | null;
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

// Re-export for convenience
export type {SearchResults, IndexStats, WatcherStatus};
