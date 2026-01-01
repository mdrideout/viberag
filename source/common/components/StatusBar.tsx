import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';
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
 * Format status message for display.
 */
function formatStatus(status: AppStatus): {
	text: string;
	color: string;
	showSpinner: boolean;
} {
	switch (status.state) {
		case 'ready':
			return {text: 'Ready', color: 'green', showSpinner: false};
		case 'indexing': {
			if (status.total === 0) {
				return {text: `${status.stage}`, color: 'cyan', showSpinner: true};
			}
			const percent = Math.round((status.current / status.total) * 100);
			return {
				text: `${status.stage} ${status.current}/${status.total} (${percent}%)`,
				color: 'cyan',
				showSpinner: true,
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
	const {text, color, showSpinner} = formatStatus(status);
	const statsText = formatStats(stats);

	return (
		<Box paddingX={1} justifyContent="space-between">
			<Box>
				{showSpinner && <Spinner color={color} />}
				<Text color={color}>{text}</Text>
			</Box>
			<Text dimColor>{statsText}</Text>
		</Box>
	);
}
