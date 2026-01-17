/**
 * Redux slice for app-level state.
 *
 * Centralizes output items, initialization status, and index stats
 * that were previously managed via React useState in app.tsx.
 */

import {createSlice, type PayloadAction} from '@reduxjs/toolkit';
import type {
	OutputItem,
	IndexDisplayStats,
	AppStatus,
	SearchResultsData,
} from '../../../common/types.js';

// ============================================================================
// Types
// ============================================================================

export interface AppState {
	/** Initialization status: undefined = loading, false = not initialized, true = initialized */
	isInitialized: boolean | undefined;
	/** Index statistics: undefined = loading, null = no manifest, {...} = stats */
	indexStats: IndexDisplayStats | null | undefined;
	/** Current app status for the status bar */
	appStatus: AppStatus;
	/** Output items displayed in the CLI */
	outputItems: OutputItem[];
	/** Next ID for output items */
	nextOutputId: number;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: AppState = {
	isInitialized: undefined,
	indexStats: undefined,
	appStatus: {state: 'ready'},
	outputItems: [],
	nextOutputId: 0,
};

// ============================================================================
// Slice
// ============================================================================

export const appSlice = createSlice({
	name: 'app',
	initialState,
	reducers: {
		// ========================================
		// Initialization Status
		// ========================================

		/**
		 * Set initialization status.
		 */
		setInitialized: (state, action: PayloadAction<boolean>) => {
			state.isInitialized = action.payload;
		},

		/**
		 * Reset to uninitialized (after clean).
		 */
		resetInitialized: state => {
			state.isInitialized = false;
			state.indexStats = null;
		},

		// ========================================
		// Index Stats
		// ========================================

		/**
		 * Set index statistics.
		 */
		setIndexStats: (state, action: PayloadAction<IndexDisplayStats | null>) => {
			state.indexStats = action.payload;
		},

		// ========================================
		// App Status
		// ========================================

		/**
		 * Set app status for status bar.
		 */
		setAppStatus: (state, action: PayloadAction<AppStatus>) => {
			state.appStatus = action.payload;
		},

		/**
		 * Reset app status to ready.
		 */
		setReady: state => {
			state.appStatus = {state: 'ready'};
		},

		/**
		 * Set searching status.
		 * Note: Indexing status is derived from daemon status.
		 */
		setSearching: state => {
			state.appStatus = {state: 'searching'};
		},

		/**
		 * Set working status with message (spinner).
		 */
		setWorking: (state, action: PayloadAction<string>) => {
			state.appStatus = {state: 'working', message: action.payload};
		},

		/**
		 * Set warning status with message.
		 */
		setWarning: (state, action: PayloadAction<string>) => {
			state.appStatus = {state: 'warning', message: action.payload};
		},

		// ========================================
		// Output Items
		// ========================================

		/**
		 * Add a user or system output item.
		 */
		addOutput: (
			state,
			action: PayloadAction<{type: 'user' | 'system'; content: string}>,
		) => {
			const id = String(state.nextOutputId++);
			state.outputItems.push({
				id,
				type: action.payload.type,
				content: action.payload.content,
			});
		},

		/**
		 * Add search results output item.
		 */
		addSearchResults: (state, action: PayloadAction<SearchResultsData>) => {
			const id = String(state.nextOutputId++);
			state.outputItems.push({
				id,
				type: 'search-results',
				data: action.payload,
			});
		},

		/**
		 * Clear all output items.
		 */
		clearOutput: state => {
			state.outputItems = [];
		},
	},
});

export const AppActions = appSlice.actions;
export const appReducer = appSlice.reducer;
