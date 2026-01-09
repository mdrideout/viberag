/**
 * Memoized selectors for slot progress state.
 */

import {createSelector} from '@reduxjs/toolkit';
import type {SlotState, SlotProgressState, FailedChunk} from './slice.js';

// ============================================================================
// Root State Type (matches store.ts RootState)
// ============================================================================

type RootState = {
	slotProgress: SlotProgressState;
};

// ============================================================================
// Basic Selectors
// ============================================================================

export const selectSlotProgress = (state: RootState): SlotProgressState =>
	state.slotProgress;

export const selectSlots = (state: RootState): SlotState[] =>
	state.slotProgress.slots;

export const selectIsIndexing = (state: RootState): boolean =>
	state.slotProgress.isIndexing;

export const selectError = (state: RootState): string | null =>
	state.slotProgress.error;

export const selectFailures = (state: RootState): FailedChunk[] =>
	state.slotProgress.failures;

// ============================================================================
// Parameterized Selectors
// ============================================================================

/**
 * Select a specific slot by index.
 */
export const selectSlot = (state: RootState, index: number): SlotState =>
	state.slotProgress.slots[index] ?? {state: 'idle'};

/**
 * Get the number of slots (matches CONCURRENCY).
 */
export const selectSlotCount = (state: RootState): number =>
	state.slotProgress.slots.length;

// ============================================================================
// Memoized Selectors
// ============================================================================

/**
 * Select only active (non-idle) slots with their indices.
 * Memoized to prevent unnecessary re-renders.
 */
export const selectActiveSlots = createSelector(
	[selectSlots],
	(slots): Array<{index: number; slot: SlotState}> =>
		slots
			.map((slot, index) => ({index, slot}))
			.filter(({slot}) => slot.state !== 'idle'),
);

/**
 * Check if any slot is rate-limited.
 */
export const selectHasRateLimitedSlots = createSelector(
	[selectSlots],
	(slots): boolean => slots.some(slot => slot.state === 'rate-limited'),
);
