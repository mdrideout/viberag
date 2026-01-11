import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import {useAppSelector} from '../../store/hooks.js';
import {
	selectSlotCount,
	selectFailures,
	selectHasActiveSlots,
} from '../../store/slot-progress/selectors.js';
import {
	selectIndexingDisplay,
	selectIsIndexing,
} from '../../store/indexing/selectors.js';
import {SlotRow} from './SlotRow.js';
import type {AppStatus, IndexDisplayStats} from '../types.js';

type Props = {
	status: AppStatus;
	// undefined = not loaded yet, null = loaded but no manifest
	stats: IndexDisplayStats | null | undefined;
};

/** Braille dots spinner frames */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Simple spinner component using interval-based animation.
 */
function Spinner({color}: {color: string}): React.ReactElement {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame(f => (f + 1) % SPINNER_FRAMES.length);
		}, 80);
		return () => clearInterval(timer);
	}, []);

	return <Text color={color}>{SPINNER_FRAMES[frame]} </Text>;
}

/**
 * Progress bar component for visual progress indication.
 */
function ProgressBar({
	percent,
	width = 20,
}: {
	percent: number;
	width?: number;
}): React.ReactElement {
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	return (
		<Text>
			<Text color="cyan">{'█'.repeat(filled)}</Text>
			<Text dimColor>{'░'.repeat(empty)}</Text>
		</Text>
	);
}

/**
 * Format status message for display.
 * Note: Indexing progress is now read from Redux via selectIndexingDisplay.
 * This function only handles non-indexing states.
 */
function formatNonIndexingStatus(status: AppStatus): {
	text: string;
	color: string;
	showSpinner: boolean;
} | null {
	switch (status.state) {
		case 'ready':
			return {text: 'Ready', color: 'green', showSpinner: false};
		case 'indexing':
			// Handled by Redux - return null to signal caller
			return null;
		case 'searching':
			return {text: 'Searching', color: 'cyan', showSpinner: true};
		case 'warning':
			return {text: status.message, color: 'yellow', showSpinner: false};
	}
}

/**
 * Format stats for display.
 */
function formatStats(stats: IndexDisplayStats | null | undefined): string {
	if (stats === undefined) {
		return 'Loading...';
	}
	if (stats === null) {
		return 'Not indexed';
	}
	return `${stats.totalFiles} files · ${stats.totalChunks} chunks`;
}

export default function StatusBar({status, stats}: Props) {
	const statsText = formatStats(stats);

	// Redux selectors for indexing progress
	const indexingDisplay = useAppSelector(selectIndexingDisplay);
	const isIndexingActive = useAppSelector(selectIsIndexing);

	// Redux selectors for slot progress
	const slotCount = useAppSelector(selectSlotCount);
	const failures = useAppSelector(selectFailures);
	const hasActiveSlots = useAppSelector(selectHasActiveSlots);

	// Determine display values based on state source
	// For indexing: use Redux state (primary source of truth)
	// For other states: use props
	const nonIndexingStatus = formatNonIndexingStatus(status);

	// Use Redux for indexing display, props for everything else
	const displayValues = isIndexingActive
		? {
				text: indexingDisplay.stage,
				color: indexingDisplay.color,
				showSpinner: true,
				showProgressBar: indexingDisplay.showProgressBar,
				percent: indexingDisplay.percent,
				stage: indexingDisplay.stage,
				chunkInfo: indexingDisplay.chunkInfo,
				throttleInfo: indexingDisplay.throttleInfo,
			}
		: {
				text: nonIndexingStatus?.text ?? 'Ready',
				color: nonIndexingStatus?.color ?? 'green',
				showSpinner: nonIndexingStatus?.showSpinner ?? false,
				showProgressBar: false,
				percent: 0,
				stage: '',
				chunkInfo: undefined as string | undefined,
				throttleInfo: null as string | null,
			};

	const {
		text,
		color,
		showSpinner,
		showProgressBar,
		percent,
		stage,
		chunkInfo,
		throttleInfo,
	} = displayValues;

	// Only show slots when there's actual activity (API providers use slots, local doesn't)
	const showSlots = isIndexingActive && hasActiveSlots;

	// Show failure summary if any batches failed
	const hasFailures = failures.length > 0;

	return (
		<Box flexDirection="column">
			{/* Main progress line */}
			<Box paddingX={1} justifyContent="space-between">
				<Box>
					{showSpinner && <Spinner color={color} />}
					{showProgressBar ? (
						<>
							<Text color={color}>{stage} </Text>
							<Text>[</Text>
							<ProgressBar percent={percent} />
							<Text>] </Text>
							<Text color={color}>{percent}%</Text>
							{chunkInfo && <Text dimColor> · {chunkInfo}</Text>}
							{throttleInfo && <Text color="yellow"> · {throttleInfo}</Text>}
						</>
					) : (
						<Text color={color}>{text}</Text>
					)}
				</Box>
				<Text dimColor>{statsText}</Text>
			</Box>

			{/* Per-slot lines - fixed height layout during indexing */}
			{showSlots && (
				<Box flexDirection="column" paddingLeft={2}>
					{Array.from({length: slotCount}, (_, i) => (
						<SlotRow key={i} slotIndex={i} isLast={i === slotCount - 1} />
					))}
				</Box>
			)}

			{/* Failure summary - shown after indexing completes with errors */}
			{hasFailures && (
				<Box paddingLeft={2}>
					<Text color="red">
						⚠ {failures.length} batch(es) failed - see .viberag/debug.log
					</Text>
				</Box>
			)}
		</Box>
	);
}
