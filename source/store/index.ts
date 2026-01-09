/**
 * Redux store exports.
 *
 * Central export point for all store-related items:
 * - Store instance
 * - Type definitions
 * - Typed hooks
 * - Actions and selectors
 */

// Store and types
export {store, type RootState, type AppDispatch} from './store.js';

// Typed hooks
export {useAppDispatch, useAppSelector} from './hooks.js';

// Slot progress slice
export {
	SlotProgressActions,
	slotProgressReducer,
	type SlotState,
	type SlotProgressState,
	type FailedChunk,
} from './slot-progress/slice.js';

// Slot progress selectors
export {
	selectSlot,
	selectSlots,
	selectIsIndexing,
	selectActiveSlots,
	selectSlotCount,
	selectError,
	selectFailures,
	selectHasRateLimitedSlots,
} from './slot-progress/selectors.js';
