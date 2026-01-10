/**
 * Redux slice for warmup state.
 *
 * Manages the state of the embedding provider warmup process.
 * The WarmupManager dispatches actions to this slice to track status.
 */

import {createSlice, type PayloadAction} from '@reduxjs/toolkit';

// ============================================================================
// Types
// ============================================================================

export type WarmupStatus =
	| 'not_started'
	| 'not_initialized'
	| 'initializing'
	| 'ready'
	| 'failed';

export interface WarmupState {
	/** Current warmup status */
	status: WarmupStatus;
	/** Embedding provider name (e.g., 'gemini', 'openai', 'local') */
	provider: string | null;
	/** ISO timestamp when warmup started */
	startedAt: string | null;
	/** ISO timestamp when warmup completed */
	readyAt: string | null;
	/** Time taken to warm up in milliseconds */
	elapsedMs: number | null;
	/** Error message if warmup failed */
	error: string | null;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: WarmupState = {
	status: 'not_started',
	provider: null,
	startedAt: null,
	readyAt: null,
	elapsedMs: null,
	error: null,
};

// ============================================================================
// Slice
// ============================================================================

export const warmupSlice = createSlice({
	name: 'warmup',
	initialState,
	reducers: {
		/**
		 * Project is not initialized.
		 */
		setNotInitialized: state => {
			state.status = 'not_initialized';
			state.provider = null;
			state.startedAt = null;
			state.readyAt = null;
			state.elapsedMs = null;
			state.error = null;
		},

		/**
		 * Start warmup process.
		 */
		start: (state, action: PayloadAction<{provider: string}>) => {
			state.status = 'initializing';
			state.provider = action.payload.provider;
			state.startedAt = new Date().toISOString();
			state.readyAt = null;
			state.elapsedMs = null;
			state.error = null;
		},

		/**
		 * Warmup completed successfully.
		 */
		ready: (state, action: PayloadAction<{elapsedMs: number}>) => {
			state.status = 'ready';
			state.readyAt = new Date().toISOString();
			state.elapsedMs = action.payload.elapsedMs;
			state.error = null;
		},

		/**
		 * Warmup failed with error.
		 */
		failed: (
			state,
			action: PayloadAction<{error: string; elapsedMs: number}>,
		) => {
			state.status = 'failed';
			state.elapsedMs = action.payload.elapsedMs;
			state.error = action.payload.error;
		},

		/**
		 * Reset state for retry.
		 */
		reset: () => initialState,
	},
});

export const WarmupActions = warmupSlice.actions;
export const warmupReducer = warmupSlice.reducer;
