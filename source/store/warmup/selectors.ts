/**
 * Memoized selectors for warmup state.
 */

import {createSelector} from '@reduxjs/toolkit';
import type {WarmupState, WarmupStatus} from './slice.js';

// ============================================================================
// Root State Type (matches store.ts RootState)
// ============================================================================

type RootState = {
	warmup: WarmupState;
};

// ============================================================================
// Basic Selectors
// ============================================================================

export const selectWarmupState = (state: RootState): WarmupState =>
	state.warmup;

export const selectWarmupStatus = (state: RootState): WarmupStatus =>
	state.warmup.status;

export const selectWarmupProvider = (state: RootState): string | null =>
	state.warmup.provider;

export const selectWarmupError = (state: RootState): string | null =>
	state.warmup.error;

export const selectWarmupElapsedMs = (state: RootState): number | null =>
	state.warmup.elapsedMs;

// ============================================================================
// Memoized Selectors
// ============================================================================

/**
 * Check if warmup is ready (engine available for searches).
 */
export const selectIsWarmupReady = createSelector(
	[selectWarmupStatus],
	(status): boolean => status === 'ready',
);

/**
 * Check if warmup is in progress.
 */
export const selectIsWarmingUp = createSelector(
	[selectWarmupStatus],
	(status): boolean => status === 'initializing',
);

/**
 * Check if warmup failed.
 */
export const selectIsWarmupFailed = createSelector(
	[selectWarmupStatus],
	(status): boolean => status === 'failed',
);

/**
 * Get display-friendly status text.
 */
export const selectWarmupStatusText = createSelector(
	[selectWarmupState],
	(state): string => {
		switch (state.status) {
			case 'not_started':
				return 'Not started';
			case 'not_initialized':
				return 'Project not initialized';
			case 'initializing':
				return `Warming up ${state.provider ?? 'provider'}...`;
			case 'ready':
				return `Ready (${state.provider}, ${state.elapsedMs}ms)`;
			case 'failed':
				return `Failed: ${state.error ?? 'Unknown error'}`;
		}
	},
);
