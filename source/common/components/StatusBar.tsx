import React from 'react';
import {Box, Text} from 'ink';
import type {AppStatus, IndexDisplayStats} from '../types.js';

type Props = {
	status: AppStatus;
	// undefined = not loaded yet, null = loaded but no manifest
	stats: IndexDisplayStats | null | undefined;
};

/**
 * Format status message for display.
 */
function formatStatus(status: AppStatus): {text: string; color: string} {
	switch (status.state) {
		case 'ready':
			return {text: 'Ready', color: 'green'};
		case 'indexing': {
			if (status.total === 0) {
				return {text: `${status.stage}...`, color: 'cyan'};
			}
			const percent = Math.round((status.current / status.total) * 100);
			return {
				text: `${status.stage} ${status.current}/${status.total} (${percent}%)`,
				color: 'cyan',
			};
		}
		case 'searching':
			return {text: 'Searching...', color: 'cyan'};
		case 'warning':
			return {text: status.message, color: 'yellow'};
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
	const {text, color} = formatStatus(status);
	const statsText = formatStats(stats);

	return (
		<Box paddingX={1} justifyContent="space-between">
			<Text color={color}>{text}</Text>
			<Text dimColor>{statsText}</Text>
		</Box>
	);
}
