/**
 * StatusBar Component
 *
 * Displays current status and indexing progress.
 * Uses DaemonStatusContext for daemon state instead of Redux.
 */

import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
import {useDaemonStatus} from '../contexts/DaemonStatusContext.js';
import {getServiceLogsDir} from '../../daemon/lib/constants.js';
import type {DaemonStatusResponse} from '../../client/types.js';
import type {AppStatus, IndexDisplayStats} from '../../common/types.js';

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
 * Note: Indexing state is derived from daemon status.
 * This function only handles non-indexing app states.
 */
function formatNonIndexingStatus(status: AppStatus): {
	text: string;
	color: string;
	showSpinner: boolean;
} {
	switch (status.state) {
		case 'ready':
			return {text: 'Ready', color: 'green', showSpinner: false};
		case 'searching':
			return {text: 'Searching', color: 'cyan', showSpinner: true};
		case 'working':
			return {text: status.message, color: 'cyan', showSpinner: true};
		case 'warning':
			return {text: status.message, color: 'yellow', showSpinner: false};
	}
}

/**
 * Format stats for display.
 */
function formatStats(
	stats: IndexDisplayStats | null | undefined,
	daemonStatus: DaemonStatusResponse | null,
	isIndexingActive: boolean,
): string {
	if (daemonStatus) {
		if (daemonStatus.indexed) {
			const totalFiles = daemonStatus.totalFiles ?? 0;
			const totalSymbols = daemonStatus.totalSymbols ?? 0;
			const totalChunks = daemonStatus.totalChunks ?? 0;
			const totalRefs = daemonStatus.totalRefs ?? 0;
			return `${totalFiles} files · ${totalSymbols} symbols · ${totalChunks} chunks · ${totalRefs} refs`;
		}
		if (isIndexingActive) {
			return 'Indexing...';
		}
		return 'Not indexed';
	}
	if (stats === undefined) {
		return 'Loading...';
	}
	if (stats === null) {
		return 'Not indexed';
	}
	return `${stats.totalFiles} files · ${stats.totalSymbols} symbols · ${stats.totalChunks} chunks · ${stats.totalRefs} refs`;
}

/**
 * Derive display values from daemon indexing state.
 */
function deriveIndexingDisplay(indexing: {
	status: string;
	phase: string | null;
	current: number;
	total: number;
	unit: string | null;
	stage: string;
	chunksProcessed: number;
	throttleMessage: string | null;
	percent: number;
	secondsSinceProgress?: number | null;
}) {
	const isActive =
		indexing.status === 'initializing' ||
		indexing.status === 'indexing' ||
		indexing.status === 'cancelling';
	const showProgressBar =
		isActive && indexing.total > 0 && indexing.status !== 'cancelling';
	const hasUnit = Boolean(indexing.unit) && indexing.unit !== 'percent';
	const progressInfo =
		showProgressBar && hasUnit
			? `${indexing.current}/${indexing.total} ${indexing.unit}`
			: undefined;
	const chunkInfo =
		progressInfo === undefined && indexing.chunksProcessed > 0
			? `${indexing.chunksProcessed} chunks`
			: undefined;
	const stallSeconds = indexing.secondsSinceProgress ?? null;
	const stalled =
		isActive && stallSeconds !== null && stallSeconds > 60
			? stallSeconds
			: null;
	const color =
		indexing.status === 'cancelling' || stalled !== null
			? 'yellow'
			: indexing.throttleMessage !== null
				? 'yellow'
				: 'cyan';
	const fallbackStage =
		indexing.status === 'cancelling'
			? 'Cancelling'
			: indexing.phase === 'init'
				? 'Initializing'
				: indexing.phase === 'scan'
					? 'Scanning files'
					: indexing.phase === 'chunk'
						? 'Chunking files'
						: indexing.phase === 'embed'
							? 'Embedding chunks'
							: indexing.phase === 'persist'
								? 'Writing index'
								: indexing.phase === 'finalize'
									? 'Finalizing manifest'
									: '';

	return {
		isActive,
		showProgressBar,
		percent: indexing.percent,
		stage: indexing.stage || fallbackStage,
		chunkInfo,
		progressInfo,
		throttleInfo: indexing.throttleMessage,
		stallInfo: stalled ? `No progress ${stalled}s` : null,
		color,
	};
}

export default function StatusBar({status, stats}: Props) {
	// Get daemon status from context
	const daemonStatus = useDaemonStatus();

	// Derive indexing display from daemon status
	const indexingDisplay = daemonStatus
		? deriveIndexingDisplay(daemonStatus.indexing)
		: {
				isActive: false,
				showProgressBar: false,
				percent: 0,
				stage: '',
				progressInfo: undefined,
				chunkInfo: undefined,
				throttleInfo: null,
				stallInfo: null,
				color: 'cyan',
			};

	const isIndexingActive = indexingDisplay.isActive;
	const statsText = formatStats(stats, daemonStatus, isIndexingActive);

	// Get failures from daemon status
	const failures = daemonStatus?.failures ?? [];

	// Determine display values based on state source
	const nonIndexingStatus = formatNonIndexingStatus(status);

	// Use daemon status for indexing display, props for everything else
	const displayValues = isIndexingActive
		? {
				text: indexingDisplay.stage,
				color: indexingDisplay.color,
				showSpinner: true,
				showProgressBar: indexingDisplay.showProgressBar,
				percent: indexingDisplay.percent,
				stage: indexingDisplay.stage,
				progressInfo: indexingDisplay.progressInfo,
				chunkInfo: indexingDisplay.chunkInfo,
				throttleInfo: indexingDisplay.throttleInfo,
				stallInfo: indexingDisplay.stallInfo,
			}
		: {
				text: nonIndexingStatus.text,
				color: nonIndexingStatus.color,
				showSpinner: nonIndexingStatus.showSpinner,
				showProgressBar: false,
				percent: 0,
				stage: '',
				progressInfo: undefined as string | undefined,
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
		progressInfo,
		chunkInfo,
		throttleInfo,
		stallInfo,
	} = displayValues;

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
							{progressInfo && <Text dimColor> · {progressInfo}</Text>}
							{chunkInfo && <Text dimColor> · {chunkInfo}</Text>}
							{throttleInfo && <Text color="yellow"> · {throttleInfo}</Text>}
							{stallInfo && <Text color="yellow"> · {stallInfo}</Text>}
						</>
					) : (
						<Text color={color}>{text}</Text>
					)}
				</Box>
				<Text dimColor>{statsText}</Text>
			</Box>

			{/* Failure summary - shown after indexing completes with errors */}
			{hasFailures && (
				<Box paddingLeft={2}>
					<Text color="red">
						⚠ {failures.length} batch(es) failed - see{' '}
						{getServiceLogsDir(process.cwd(), 'indexer')}
					</Text>
				</Box>
			)}
		</Box>
	);
}
