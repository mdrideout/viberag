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

export const selectSlots = (state: RootState): SlotState[] =>
	state.slotProgress.slots;

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
 * Check if any slot is rate-limited.
 */
export const selectHasRateLimitedSlots = createSelector(
	[selectSlots],
	(slots): boolean => slots.some(slot => slot.state === 'rate-limited'),
);
