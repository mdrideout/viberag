/**
 * Redux store configuration.
 *
 * CLI-only store for wizard and app state.
 * Daemon state is managed separately via daemon/state.ts.
 */

import {configureStore} from '@reduxjs/toolkit';
import {wizardReducer} from './wizard/slice.js';
import {appReducer} from './app/slice.js';

// ============================================================================
// Store Configuration
// ============================================================================

export const store = configureStore({
	reducer: {
		wizard: wizardReducer,
		app: appReducer,
	},
});

// ============================================================================
// Type Exports
// ============================================================================

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
