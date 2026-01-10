/**
 * Redux store configuration.
 *
 * Single store instance shared between React components (via Provider)
 * and Node.js code (via direct import).
 */

import {configureStore} from '@reduxjs/toolkit';
import {slotProgressReducer} from './slot-progress/slice.js';
import {slotProgressListenerMiddleware} from './slot-progress/listeners.js';
import {indexingReducer} from './indexing/slice.js';
import {indexingListenerMiddleware} from './indexing/listeners.js';
import {warmupReducer} from './warmup/slice.js';
import {watcherReducer} from './watcher/slice.js';
import {wizardReducer} from './wizard/slice.js';
import {appReducer} from './app/slice.js';

// ============================================================================
// Store Configuration
// ============================================================================

export const store = configureStore({
	reducer: {
		slotProgress: slotProgressReducer,
		indexing: indexingReducer,
		warmup: warmupReducer,
		watcher: watcherReducer,
		wizard: wizardReducer,
		app: appReducer,
	},
	middleware: getDefaultMiddleware =>
		getDefaultMiddleware()
			.prepend(slotProgressListenerMiddleware.middleware)
			.prepend(indexingListenerMiddleware.middleware),
});

// ============================================================================
// Type Exports
// ============================================================================

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
