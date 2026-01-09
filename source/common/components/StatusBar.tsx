import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import {useAppSelector} from '../../store/hooks.js';
import {
	selectSlotCount,
	selectFailures,
} from '../../store/slot-progress/selectors.js';
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
 * Note: Slot progress is now handled via Redux, not passed through status.
 */
function formatStatus(status: AppStatus): {
	color: string;
	showSpinner: boolean;
	percent?: number;
	stage?: string;
	chunkInfo?: string;
	throttleInfo?: string;
	text?: string;
} {
	switch (status.state) {
		case 'ready':
			return {text: 'Ready', color: 'green', showSpinner: false};
		case 'indexing': {
			let color: string = 'cyan';

			if (status.total === 0) {
				return {
					text: status.stage,
					color,
					showSpinner: true,
				};
			}

			const percent = Math.round((status.current / status.total) * 100);
			const chunkInfo =
				status.chunksProcessed !== undefined
					? `${status.chunksProcessed} chunks`
					: undefined;

			// Rate limit info (turns status yellow)
			let throttleInfo: string | undefined;
			if (status.throttleMessage) {
				throttleInfo = status.throttleMessage;
				color = 'yellow';
			}

			return {
				color,
				showSpinner: true,
				percent,
				stage: status.stage,
				chunkInfo,
				throttleInfo,
			};
		}
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
	const {text, color, showSpinner, percent, stage, chunkInfo, throttleInfo} =
		formatStatus(status);
	const statsText = formatStats(stats);

	// Redux selectors for slot progress
	const slotCount = useAppSelector(selectSlotCount);
	const failures = useAppSelector(selectFailures);

	// Progress bar mode (indexing with known total)
	const showProgressBar = percent !== undefined;

	// Always show all slots during indexing (fixed height layout)
	const showSlots = status.state === 'indexing';

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
