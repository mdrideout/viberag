/**
 * Redux store configuration.
 *
 * Single store instance shared between React components (via Provider)
 * and Node.js code (via direct import).
 */

import {configureStore} from '@reduxjs/toolkit';
import {slotProgressReducer} from './slot-progress/slice.js';
import {slotProgressListenerMiddleware} from './slot-progress/listeners.js';

// ============================================================================
// Store Configuration
// ============================================================================

export const store = configureStore({
	reducer: {
		slotProgress: slotProgressReducer,
	},
	middleware: getDefaultMiddleware =>
		getDefaultMiddleware().prepend(slotProgressListenerMiddleware.middleware),
});

// ============================================================================
// Type Exports
// ============================================================================

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
