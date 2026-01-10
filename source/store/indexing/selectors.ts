/**
 * Memoized selectors for indexing state.
 */

import {createSelector} from '@reduxjs/toolkit';
import type {IndexingState, IndexingStatus} from './slice.js';

// ============================================================================
// Root State Type (matches store.ts RootState)
// ============================================================================

type RootState = {
	indexing: IndexingState;
};

// ============================================================================
// Basic Selectors
// ============================================================================

export const selectIndexingState = (state: RootState): IndexingState =>
	state.indexing;

export const selectIndexingStatus = (state: RootState): IndexingStatus =>
	state.indexing.status;

export const selectIndexingStage = (state: RootState): string =>
	state.indexing.stage;

export const selectIndexingCurrent = (state: RootState): number =>
	state.indexing.current;

export const selectIndexingTotal = (state: RootState): number =>
	state.indexing.total;

export const selectThrottleMessage = (state: RootState): string | null =>
	state.indexing.throttleMessage;

export const selectChunksProcessed = (state: RootState): number =>
	state.indexing.chunksProcessed;

export const selectIndexingError = (state: RootState): string | null =>
	state.indexing.error;

// ============================================================================
// Memoized Selectors
// ============================================================================

/**
 * Check if indexing is currently active.
 */
export const selectIsIndexing = createSelector(
	[selectIndexingStatus],
	(status): boolean => status === 'initializing' || status === 'indexing',
);

/**
 * Calculate progress percentage.
 * Returns 0 if total is 0.
 */
export const selectIndexingPercent = createSelector(
	[selectIndexingCurrent, selectIndexingTotal],
	(current, total): number => {
		if (total === 0) return 0;
		return Math.round((current / total) * 100);
	},
);

/**
 * Check if currently throttled/rate-limited.
 */
export const selectIsThrottled = createSelector(
	[selectThrottleMessage],
	(message): boolean => message !== null,
);

/**
 * Get display color based on throttle status.
 * Returns 'yellow' when throttled, 'cyan' otherwise.
 */
export const selectIndexingColor = createSelector(
	[selectIsThrottled],
	(isThrottled): string => (isThrottled ? 'yellow' : 'cyan'),
);

/**
 * Derived state for StatusBar consumption.
 * Combines all relevant fields for efficient rendering.
 */
export const selectIndexingDisplay = createSelector(
	[selectIndexingState],
	(
		state,
	): {
		isActive: boolean;
		showProgressBar: boolean;
		percent: number;
		stage: string;
		chunkInfo: string | undefined;
		throttleInfo: string | null;
		color: string;
		batchInfo: string | null;
	} => {
		const isActive =
			state.status === 'initializing' || state.status === 'indexing';
		const showProgressBar = isActive && state.total > 0;
		const percent =
			state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
		const chunkInfo =
			state.chunksProcessed > 0 ? `${state.chunksProcessed} chunks` : undefined;
		const color = state.throttleMessage !== null ? 'yellow' : 'cyan';

		// Build batch info string: "batch X/Y · chunks A-B"
		let batchInfo: string | null = null;
		if (state.totalBatches > 0) {
			batchInfo = `batch ${state.currentBatch}/${state.totalBatches}`;
			if (state.batchChunkRange) {
				batchInfo += ` · ${state.batchChunkRange}`;
			}
		}

		return {
			isActive,
			showProgressBar,
			percent,
			stage: state.stage,
			chunkInfo,
			throttleInfo: state.throttleMessage,
			color,
			batchInfo,
		};
	},
);
