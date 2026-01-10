/**
 * Memoized selectors for watcher state.
 */

import {createSelector} from '@reduxjs/toolkit';
import type {WatcherState, WatcherStatus} from './slice.js';

// ============================================================================
// Root State Type (matches store.ts RootState)
// ============================================================================

type RootState = {
	watcher: WatcherState;
};

// ============================================================================
// Basic Selectors
// ============================================================================

export const selectWatcherState = (state: RootState): WatcherState =>
	state.watcher;

export const selectWatcherStatus = (state: RootState): WatcherStatus =>
	state.watcher.status;

export const selectFilesWatched = (state: RootState): number =>
	state.watcher.filesWatched;

export const selectPendingPaths = (state: RootState): string[] =>
	state.watcher.pendingPaths;

export const selectLastIndexUpdate = (state: RootState): string | null =>
	state.watcher.lastIndexUpdate;

export const selectIsIndexUpToDate = (state: RootState): boolean =>
	state.watcher.indexUpToDate;

export const selectWatcherError = (state: RootState): string | null =>
	state.watcher.lastError;

// ============================================================================
// Memoized Selectors
// ============================================================================

/**
 * Check if watcher is active (any status except stopped).
 */
export const selectIsWatching = createSelector(
	[selectWatcherStatus],
	(status): boolean => status !== 'stopped',
);

/**
 * Check if watcher is busy (debouncing, batching, or indexing).
 */
export const selectIsWatcherBusy = createSelector(
	[selectWatcherStatus],
	(status): boolean =>
		status === 'debouncing' || status === 'batching' || status === 'indexing',
);

/**
 * Get pending change count.
 */
export const selectPendingChangeCount = createSelector(
	[selectPendingPaths],
	(paths): number => paths.length,
);

/**
 * Get display-friendly status text.
 */
export const selectWatcherStatusText = createSelector(
	[selectWatcherState],
	(state): string => {
		switch (state.status) {
			case 'stopped':
				return 'Stopped';
			case 'starting':
				return 'Starting...';
			case 'watching':
				return state.indexUpToDate
					? `Watching ${state.filesWatched} files`
					: `Watching ${state.filesWatched} files (pending changes)`;
			case 'debouncing':
				return `Debouncing (${state.pendingPaths.length} changes)`;
			case 'batching':
				return `Batching (${state.pendingPaths.length} changes)`;
			case 'indexing':
				return 'Indexing changes...';
		}
	},
);
