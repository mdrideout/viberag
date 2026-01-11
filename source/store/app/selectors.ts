/**
 * Memoized selectors for app state.
 */

import {createSelector} from '@reduxjs/toolkit';
import type {AppState} from './slice.js';
import type {
	OutputItem,
	IndexDisplayStats,
	AppStatus,
} from '../../common/types.js';

// ============================================================================
// Root State Type (matches store.ts RootState)
// ============================================================================

type RootState = {
	app: AppState;
};

// ============================================================================
// Basic Selectors
// ============================================================================

export const selectAppState = (state: RootState): AppState => state.app;

export const selectIsInitialized = (state: RootState): boolean | undefined =>
	state.app.isInitialized;

export const selectIndexStats = (
	state: RootState,
): IndexDisplayStats | null | undefined => state.app.indexStats;

export const selectAppStatus = (state: RootState): AppStatus =>
	state.app.appStatus;

export const selectOutputItems = (state: RootState): OutputItem[] =>
	state.app.outputItems;

// ============================================================================
// Memoized Selectors
// ============================================================================

/**
 * Check if app startup is complete (both init status and stats loaded).
 */
export const selectStartupLoaded = createSelector(
	[selectIsInitialized, selectIndexStats],
	(isInitialized, indexStats): boolean =>
		isInitialized !== undefined && indexStats !== undefined,
);

/**
 * Check if the app is in a busy state (searching).
 * Note: For indexing state, use selectIsIndexing from indexing selectors.
 */
export const selectIsBusy = createSelector(
	[selectAppStatus],
	(status): boolean => status.state === 'searching',
);

/**
 * Get output item count.
 */
export const selectOutputCount = createSelector(
	[selectOutputItems],
	(items): number => items.length,
);
