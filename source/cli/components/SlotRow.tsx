/**
 * Individual slot row component for displaying batch processing progress.
 *
 * Each SlotRow reads its slot from DaemonStatusContext and renders independently.
 * This follows the Single Responsibility Principle - each row manages its own
 * rendering logic based on its slot index.
 */

import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import {useDaemonStatus} from '../contexts/DaemonStatusContext.js';
import type {SlotState} from '../../client/types.js';

// ============================================================================
// Constants
// ============================================================================

/** Braille dots spinner frames */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Default idle slot state */
const IDLE_SLOT: SlotState = {state: 'idle', batchInfo: null, retryInfo: null};

// ============================================================================
// Component
// ============================================================================

type Props = {
	/** The slot index (0 to CONCURRENCY-1) */
	slotIndex: number;
	/** Whether this is the last visible slot (for tree-drawing) */
	isLast: boolean;
};

/**
 * Renders a single slot's progress status.
 *
 * Always renders a fixed-height row to prevent UI jumping when slots
 * become active/idle. Idle slots show an empty placeholder.
 */
export function SlotRow({slotIndex, isLast}: Props): React.ReactElement {
	const daemonStatus = useDaemonStatus();
	const slot = daemonStatus?.slots[slotIndex] ?? IDLE_SLOT;
	const [frame, setFrame] = useState(0);

	// Spinner animation - only runs when processing
	useEffect(() => {
		if (slot.state !== 'processing') return;

		const timer = setInterval(() => {
			setFrame(f => (f + 1) % SPINNER_FRAMES.length);
		}, 80);

		return () => clearInterval(timer);
	}, [slot.state]);

	// Tree-drawing prefix
	const prefix = isLast ? '└ ' : '├ ';

	// Idle slots render empty placeholder to maintain fixed height
	if (slot.state === 'idle') {
		return (
			<Box>
				<Text dimColor>{prefix}</Text>
				<Text dimColor>·</Text>
			</Box>
		);
	}

	return (
		<Box>
			<Text dimColor>{prefix}</Text>
			{slot.state === 'rate-limited' ? (
				<Text color="yellow">
					⚠ {slot.batchInfo}
					{slot.retryInfo && ` · ${slot.retryInfo}`}
				</Text>
			) : (
				<>
					<Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
					<Text dimColor>{slot.batchInfo}</Text>
				</>
			)}
		</Box>
	);
}
