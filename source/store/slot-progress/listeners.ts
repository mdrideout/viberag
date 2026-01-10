/**
 * Listener middleware for slot progress.
 *
 * Infrastructure for Redux listener middleware. Add listeners here for:
 * - Debouncing rapid updates
 * - Async orchestration (e.g., wizard completion → indexing → next step)
 * - Side effects triggered by state changes
 */

import {createListenerMiddleware} from '@reduxjs/toolkit';
import type {SlotProgressState} from './slice.js';

// ============================================================================
// Type Definitions
// ============================================================================

type RootState = {
	slotProgress: SlotProgressState;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppDispatch = any; // Will be properly typed when store grows

// ============================================================================
// Listener Middleware
// ============================================================================

export const slotProgressListenerMiddleware = createListenerMiddleware();

/**
 * Typed listener starter for adding new listeners.
 * Usage:
 *   startAppListening({
 *     actionCreator: SomeAction,
 *     effect: async (action, listenerApi) => { ... }
 *   });
 */
export const startAppListening =
	slotProgressListenerMiddleware.startListening.withTypes<
		RootState,
		AppDispatch
	>();

// ============================================================================
// Listeners
// ============================================================================

// Add listeners here as needed. Example:
//
// startAppListening({
//   actionCreator: SlotProgressActions.addFailure,
//   effect: async (action, listenerApi) => {
//     // Log failures to analytics, trigger notifications, etc.
//   },
// });
