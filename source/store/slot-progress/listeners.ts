/**
 * Listener middleware for slot progress.
 *
 * Sets up the listener middleware infrastructure. Currently minimal,
 * as slot mutations are dispatched directly from api-utils.ts.
 *
 * The existing callback flow handles main progress bar state (current/total/stage),
 * while Redux handles the slot-level progress for multi-line display.
 *
 * Future extensions could add listeners for:
 * - Debouncing rapid slot updates
 * - Logging/analytics
 * - Complex async orchestration
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
type AppDispatch = any; // Simplified for initial setup

// ============================================================================
// Listener Middleware
// ============================================================================

export const slotProgressListenerMiddleware = createListenerMiddleware();

// Typed listener starter for future use
export const startAppListening =
	slotProgressListenerMiddleware.startListening.withTypes<
		RootState,
		AppDispatch
	>();

// ============================================================================
// Listeners
// ============================================================================

// Currently no active listeners - slot mutations are dispatched directly
// from api-utils.ts. The middleware is set up for future extensibility.

// Example listener (commented out for reference):
// startAppListening({
//   actionCreator: SlotProgressActions.setSlotProcessing,
//   effect: async (action, listenerApi) => {
//     // Could log, debounce, or trigger side effects
//     console.log('Slot processing:', action.payload);
//   },
// });
