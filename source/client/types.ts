/**
 * Client Types
 *
 * Types for daemon client communication.
 */

import type {SearchResults} from '../rag/search/types.js';
import type {IndexStats} from '../rag/indexer/types.js';
import type {WatcherStatus} from '../mcp/watcher.js';

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
	/** Maximum reconnect attempts (default: 3) */
	reconnectAttempts?: number;
}

// ============================================================================
// Connection State
// ============================================================================

/**
 * Client connection state.
 */
export type ConnectionState =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'reconnecting';

// ============================================================================
// Event Types
// ============================================================================

/**
 * Index progress event data.
 */
export interface IndexProgressEvent {
	status: string;
	current: number;
	total: number;
	stage: string;
	chunksProcessed: number;
	throttleMessage?: string;
}

/**
 * Index complete event data.
 */
export interface IndexCompleteEvent {
	success: boolean;
	stats?: IndexStats;
	error?: string;
}

/**
 * Watcher event data.
 */
export interface WatcherEvent {
	type: 'add' | 'change' | 'unlink';
	path: string;
}

/**
 * Shutting down event data.
 */
export interface ShuttingDownEvent {
	reason: string;
}

/**
 * Client event types.
 */
export interface DaemonClientEvents {
	connect: () => void;
	disconnect: (reason: string) => void;
	reconnect: () => void;
	reconnectFailed: () => void;
	error: (error: Error) => void;
	indexProgress: (event: IndexProgressEvent) => void;
	indexComplete: (event: IndexCompleteEvent) => void;
	watcherEvent: (event: WatcherEvent) => void;
	shuttingDown: (event: ShuttingDownEvent) => void;
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
 * Daemon status response.
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
}

/**
 * Subscribe response.
 */
export interface SubscribeResponse {
	subscribed: boolean;
	protocolVersion: number;
	status: DaemonStatusResponse;
	indexingState: {
		status: string;
		current: number;
		total: number;
		stage: string;
	};
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
