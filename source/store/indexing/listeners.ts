/**
 * Listener middleware for indexing.
 *
 * Infrastructure for Redux listener middleware. Add listeners here for:
 * - Coordination between indexing completion and other systems
 * - Auto-clearing slot progress on indexing start
 * - Triggering notifications on errors
 */

import {createListenerMiddleware} from '@reduxjs/toolkit';
import type {IndexingState} from './slice.js';
import type {SlotProgressState} from '../slot-progress/slice.js';

// ============================================================================
// Type Definitions
// ============================================================================

type RootState = {
	indexing: IndexingState;
	slotProgress: SlotProgressState;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppDispatch = any; // Will be properly typed when store grows

// ============================================================================
// Listener Middleware
// ============================================================================

export const indexingListenerMiddleware = createListenerMiddleware();

/**
 * Typed listener starter for adding new listeners.
 * Usage:
 *   startAppListening({
 *     actionCreator: IndexingActions.start,
 *     effect: async (action, listenerApi) => { ... }
 *   });
 */
export const startIndexingListening =
	indexingListenerMiddleware.startListening.withTypes<RootState, AppDispatch>();

// ============================================================================
// Listeners
// ============================================================================

// Future listeners can be added here. Examples:
//
// import { IndexingActions } from './slice.js';
// import { SlotProgressActions } from '../slot-progress/slice.js';
//
// // Clear slot progress failures when starting new index
// startIndexingListening({
//   actionCreator: IndexingActions.start,
//   effect: async (_action, listenerApi) => {
//     listenerApi.dispatch(SlotProgressActions.clearFailures());
//     listenerApi.dispatch(SlotProgressActions.resetSlots());
//   },
// });
//
// // Log indexing completion
// startIndexingListening({
//   actionCreator: IndexingActions.complete,
//   effect: async (_action, _listenerApi) => {
//     console.log('Indexing completed at', new Date().toISOString());
//   },
// });
