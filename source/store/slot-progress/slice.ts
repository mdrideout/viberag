/**
 * Redux slice for slot progress during indexing.
 *
 * Separates trigger actions (intercepted by listeners) from mutation actions
 * (called directly by api-utils).
 */

import {createSlice, type PayloadAction} from '@reduxjs/toolkit';
import {CONCURRENCY} from '../../rag/constants.js';

// ============================================================================
// Types
// ============================================================================

export type SlotState = {
	state: 'idle' | 'processing' | 'rate-limited';
	batchInfo?: string;
	retryInfo?: string;
};

/**
 * Information about a batch that failed after exhausting all retries.
 */
export type FailedChunk = {
	/** Batch info (e.g., "chunks 15-20") */
	batchInfo: string;
	/** File paths for chunks in this batch */
	files: string[];
	/** Total chunk count in batch */
	chunkCount: number;
	/** Error message */
	error: string;
	/** ISO timestamp when failure occurred */
	timestamp: string;
};

export interface SlotProgressState {
	slots: SlotState[];
	/** Batches that failed after exhausting all retries */
	failures: FailedChunk[];
}

// ============================================================================
// Initial State
// ============================================================================

const createInitialSlots = (): SlotState[] =>
	Array(CONCURRENCY)
		.fill(null)
		.map(() => ({state: 'idle' as const}));

const initialState: SlotProgressState = {
	slots: createInitialSlots(),
	failures: [],
};

// ============================================================================
// Slice
// ============================================================================

export const slotProgressSlice = createSlice({
	name: 'slotProgress',
	initialState,
	reducers: {
		setSlotProcessing: (
			state,
			action: PayloadAction<{
				index: number;
				batchInfo: string;
			}>,
		) => {
			const {index, batchInfo} = action.payload;
			if (index >= 0 && index < state.slots.length) {
				state.slots[index] = {state: 'processing', batchInfo};
			}
		},

		setSlotRateLimited: (
			state,
			action: PayloadAction<{
				index: number;
				batchInfo: string;
				retryInfo: string;
			}>,
		) => {
			const {index, batchInfo, retryInfo} = action.payload;
			if (index >= 0 && index < state.slots.length) {
				state.slots[index] = {state: 'rate-limited', batchInfo, retryInfo};
			}
		},

		setSlotIdle: (state, action: PayloadAction<number>) => {
			const index = action.payload;
			if (index >= 0 && index < state.slots.length) {
				state.slots[index] = {state: 'idle'};
			}
		},

		resetSlots: state => {
			state.slots = createInitialSlots();
		},

		/**
		 * Record a batch failure after all retries exhausted.
		 */
		addFailure: (state, action: PayloadAction<FailedChunk>) => {
			state.failures.push(action.payload);
		},

		/**
		 * Clear all recorded failures (typically at start of new indexing run).
		 */
		clearFailures: state => {
			state.failures = [];
		},
	},
});

export const SlotProgressActions = slotProgressSlice.actions;
export const slotProgressReducer = slotProgressSlice.reducer;
