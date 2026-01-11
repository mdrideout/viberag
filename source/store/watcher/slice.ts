/**
 * Redux slice for file watcher state.
 *
 * Tracks the observable state of the file watcher for auto-indexing.
 * The FileWatcher class dispatches actions to this slice to report status.
 */

import {createSlice, type PayloadAction} from '@reduxjs/toolkit';

// ============================================================================
// Types
// ============================================================================

/**
 * WatcherStatus tracks ONLY watcher-specific concerns:
 * - stopped: Watcher not running
 * - starting: Watcher initializing
 * - watching: Actively watching, ready to detect changes
 * - debouncing: Change detected, waiting for more changes
 * - batching: Debounce done, collecting final batch before triggering index
 *
 * Note: 'indexing' is NOT included here. Whether indexing is in progress
 * is tracked by the `indexing` slice (single source of truth).
 * Use selectIsIndexing() from indexing/selectors.ts to check indexing status.
 */
export type WatcherStatus =
	| 'stopped'
	| 'starting'
	| 'watching'
	| 'debouncing'
	| 'batching';

export interface WatcherState {
	/** Current watcher status */
	status: WatcherStatus;
	/** Number of files being watched */
	filesWatched: number;
	/** Paths of pending changes (limited to first 10) */
	pendingPaths: string[];
	/** ISO timestamp of last index update */
	lastIndexUpdate: string | null;
	/** Whether the index is up to date */
	indexUpToDate: boolean;
	/** Last error message if any */
	lastError: string | null;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: WatcherState = {
	status: 'stopped',
	filesWatched: 0,
	pendingPaths: [],
	lastIndexUpdate: null,
	indexUpToDate: true,
	lastError: null,
};

// ============================================================================
// Slice
// ============================================================================

export const watcherSlice = createSlice({
	name: 'watcher',
	initialState,
	reducers: {
		/**
		 * Watcher is starting up.
		 */
		starting: state => {
			state.status = 'starting';
			state.lastError = null;
		},

		/**
		 * Watcher is ready and watching.
		 */
		ready: (state, action: PayloadAction<{filesWatched: number}>) => {
			state.status = 'watching';
			state.filesWatched = action.payload.filesWatched;
			state.lastError = null;
		},

		/**
		 * File change detected, entering debounce period.
		 */
		debouncing: (state, action: PayloadAction<{pendingPaths: string[]}>) => {
			state.status = 'debouncing';
			state.pendingPaths = action.payload.pendingPaths.slice(0, 10);
			state.indexUpToDate = false;
		},

		/**
		 * Debounce complete, entering batch window.
		 */
		batching: state => {
			state.status = 'batching';
		},

		/**
		 * Index update completed successfully.
		 * Transitions from batching back to watching.
		 */
		indexed: (
			state,
			action: PayloadAction<{
				chunksAdded: number;
				chunksDeleted: number;
			}>,
		) => {
			state.status = 'watching';
			state.lastIndexUpdate = new Date().toISOString();
			state.indexUpToDate = true;
			state.pendingPaths = [];
			state.lastError = null;
			// Log to action payload for debugging, not stored in state
			void action.payload;
		},

		/**
		 * Index update failed.
		 */
		indexFailed: (state, action: PayloadAction<{error: string}>) => {
			state.status = 'watching';
			state.lastError = action.payload.error;
		},

		/**
		 * File was added (increment count).
		 */
		fileAdded: state => {
			state.filesWatched++;
		},

		/**
		 * File was deleted (decrement count).
		 */
		fileDeleted: state => {
			state.filesWatched = Math.max(0, state.filesWatched - 1);
		},

		/**
		 * Error occurred in watcher.
		 */
		error: (state, action: PayloadAction<{error: string}>) => {
			state.lastError = action.payload.error;
		},

		/**
		 * Watcher stopped.
		 */
		stopped: () => initialState,
	},
});

export const WatcherActions = watcherSlice.actions;
export const watcherReducer = watcherSlice.reducer;
