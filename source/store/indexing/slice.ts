/**
 * Redux slice for indexing progress.
 *
 * Replaces the callback chain for progress updates:
 * - Indexer dispatches actions directly to Redux
 * - StatusBar reads from Redux via selectors
 * - Eliminates: progressCallback → handlers.ts → useRagCommands → setAppStatus
 */

import {createSlice, type PayloadAction} from '@reduxjs/toolkit';

// ============================================================================
// Types
// ============================================================================

export type IndexingStatus =
	| 'idle'
	| 'initializing'
	| 'indexing'
	| 'complete'
	| 'error';

export interface IndexingState {
	/** Current status of the indexing operation */
	status: IndexingStatus;
	/** Current file being processed (0-indexed) */
	current: number;
	/** Total files to process */
	total: number;
	/** Current stage description (e.g., "Scanning files", "Indexing files") */
	stage: string;
	/** Rate limit/throttle message (null when not throttled) */
	throttleMessage: string | null;
	/** Number of chunks embedded so far */
	chunksProcessed: number;
	/** Error message if status is 'error' */
	error: string | null;
	/** ISO timestamp of last completed indexing */
	lastCompleted: string | null;
	/** Current batch number (1-indexed) */
	currentBatch: number;
	/** Total number of batches */
	totalBatches: number;
	/** Current batch chunk range (e.g., "chunks 51-100") */
	batchChunkRange: string | null;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: IndexingState = {
	status: 'idle',
	current: 0,
	total: 0,
	stage: '',
	throttleMessage: null,
	chunksProcessed: 0,
	error: null,
	lastCompleted: null,
	currentBatch: 0,
	totalBatches: 0,
	batchChunkRange: null,
};

// ============================================================================
// Slice
// ============================================================================

export const indexingSlice = createSlice({
	name: 'indexing',
	initialState,
	reducers: {
		/**
		 * Start a new indexing operation.
		 * Resets all progress fields and sets status to 'initializing'.
		 */
		start: state => {
			state.status = 'initializing';
			state.current = 0;
			state.total = 0;
			state.stage = 'Starting';
			state.throttleMessage = null;
			state.chunksProcessed = 0;
			state.error = null;
			state.currentBatch = 0;
			state.totalBatches = 0;
			state.batchChunkRange = null;
		},

		/**
		 * Update progress during indexing.
		 */
		setProgress: (
			state,
			action: PayloadAction<{
				current: number;
				total: number;
				stage: string;
				chunksProcessed?: number;
			}>,
		) => {
			const {current, total, stage, chunksProcessed} = action.payload;
			state.status = 'indexing';
			state.current = current;
			state.total = total;
			state.stage = stage;
			if (chunksProcessed !== undefined) {
				state.chunksProcessed = chunksProcessed;
			}
		},

		/**
		 * Set throttle/rate limit message.
		 * Pass null to clear throttle status.
		 */
		setThrottle: (state, action: PayloadAction<string | null>) => {
			state.throttleMessage = action.payload;
		},

		/**
		 * Update batch-level progress during indexing.
		 * Shows which batch is being processed and the chunk range.
		 */
		setBatchProgress: (
			state,
			action: PayloadAction<{
				currentBatch: number;
				totalBatches: number;
				chunkStart: number;
				chunkEnd: number;
			}>,
		) => {
			const {currentBatch, totalBatches, chunkStart, chunkEnd} = action.payload;
			state.currentBatch = currentBatch;
			state.totalBatches = totalBatches;
			state.batchChunkRange = `chunks ${chunkStart}-${chunkEnd}`;
		},

		/**
		 * Mark indexing as complete.
		 */
		complete: state => {
			state.status = 'complete';
			state.lastCompleted = new Date().toISOString();
			state.throttleMessage = null;
		},

		/**
		 * Mark indexing as failed with error.
		 */
		fail: (state, action: PayloadAction<string>) => {
			state.status = 'error';
			state.error = action.payload;
			state.throttleMessage = null;
		},
	},
});

export const IndexingActions = indexingSlice.actions;
export const indexingReducer = indexingSlice.reducer;
