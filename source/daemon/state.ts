/**
 * Daemon State - Simple observable state without Redux.
 *
 * Single source of truth for daemon process state.
 * Clients poll via status() RPC to read this state.
 *
 * Benefits over Redux:
 * - ~100 lines vs ~1100 lines
 * - No boilerplate (no slices, reducers, selectors, middleware)
 * - Type-safe updates with updateNested()
 * - Optional listeners for reactive updates
 * - Easy to test (just check state object)
 */

import type {IndexStats as IndexingRunStats} from './services/indexing.js';

// ============================================================================
// Type Definitions
// ============================================================================

export type WarmupStatus = 'not_started' | 'initializing' | 'ready' | 'failed';

export type IndexingStatus =
	| 'idle'
	| 'initializing'
	| 'scanning'
	| 'chunking'
	| 'embedding'
	| 'complete'
	| 'error';

export type SlotState = 'idle' | 'processing' | 'rate-limited';

export interface WarmupState {
	status: WarmupStatus;
	provider: string | null;
	error: string | null;
	startedAt: string | null;
	readyAt: string | null;
}

export interface IndexingState {
	status: IndexingStatus;
	current: number;
	total: number;
	stage: string;
	chunksProcessed: number;
	throttleMessage: string | null;
	error: string | null;
	lastCompleted: string | null;
	lastStats: IndexingRunStats | null;
}

export interface SlotInfo {
	state: SlotState;
	batchInfo: string | null;
	retryInfo: string | null;
}

export interface FailureInfo {
	batchInfo: string;
	error: string;
	timestamp: string;
	files: string[];
	chunkCount: number;
}

export interface WatcherState {
	watching: boolean;
	filesWatched: number;
	pendingChanges: number;
	lastIndexUpdate: string | null;
	indexUpToDate: boolean;
}

export interface DaemonState {
	warmup: WarmupState;
	indexing: IndexingState;
	slots: SlotInfo[];
	failures: FailureInfo[];
	watcher: WatcherState;
}

// ============================================================================
// Initial State Factory
// ============================================================================

const DEFAULT_SLOT_COUNT = 8;

function createInitialState(): DaemonState {
	return {
		warmup: {
			status: 'not_started',
			provider: null,
			error: null,
			startedAt: null,
			readyAt: null,
		},
		indexing: {
			status: 'idle',
			current: 0,
			total: 0,
			stage: '',
			chunksProcessed: 0,
			throttleMessage: null,
			error: null,
			lastCompleted: null,
			lastStats: null,
		},
		slots: Array.from({length: DEFAULT_SLOT_COUNT}, () => ({
			state: 'idle' as const,
			batchInfo: null,
			retryInfo: null,
		})),
		failures: [],
		watcher: {
			watching: false,
			filesWatched: 0,
			pendingChanges: 0,
			lastIndexUpdate: null,
			indexUpToDate: true,
		},
	};
}

// ============================================================================
// State Container
// ============================================================================

export type StateListener = (state: DaemonState) => void;

/**
 * Simple state container with optional change listeners.
 *
 * Usage:
 * ```typescript
 * // Update a top-level section
 * daemonState.updateNested('indexing', () => ({
 *   status: 'indexing',
 *   current: 5,
 *   total: 10,
 * }));
 *
 * // Update slots array
 * daemonState.update(state => ({
 *   slots: state.slots.map((s, i) =>
 *     i === 0 ? { state: 'processing', batchInfo: 'batch-1', retryInfo: null } : s
 *   ),
 * }));
 *
 * // Get current state
 * const snapshot = daemonState.getSnapshot();
 * ```
 */
export class StateContainer {
	private state: DaemonState = createInitialState();
	private listeners: Set<StateListener> = new Set();

	/**
	 * Get a snapshot of the current state.
	 */
	getSnapshot(): DaemonState {
		return this.state;
	}

	/**
	 * Update state with partial values.
	 * Calls all listeners after update.
	 */
	update(updater: (state: DaemonState) => Partial<DaemonState>): void {
		const partial = updater(this.state);
		this.state = {...this.state, ...partial};
		this.notifyListeners();
	}

	/**
	 * Update a nested state section with partial values.
	 * More ergonomic for common updates.
	 */
	updateNested<K extends keyof DaemonState>(
		key: K,
		updater: (value: DaemonState[K]) => Partial<DaemonState[K]>,
	): void {
		const current = this.state[key];
		const partial = updater(current);

		// Handle array types (slots, failures) differently
		if (Array.isArray(current)) {
			// For arrays, the updater should return the new array directly
			this.state = {
				...this.state,
				[key]: partial,
			};
		} else {
			// For objects, merge the partial
			this.state = {
				...this.state,
				[key]: {...current, ...partial},
			};
		}

		this.notifyListeners();
	}

	/**
	 * Subscribe to state changes.
	 * Returns an unsubscribe function.
	 */
	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Reset state to initial values.
	 */
	reset(): void {
		this.state = createInitialState();
		this.notifyListeners();
	}

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			listener(this.state);
		}
	}
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Singleton state container for the daemon process.
 *
 * Note: This is intentionally a singleton because the daemon process
 * is a single long-running Node.js process. Each project runs its own
 * daemon, so there's no conflict between projects.
 */
export const daemonState = new StateContainer();
