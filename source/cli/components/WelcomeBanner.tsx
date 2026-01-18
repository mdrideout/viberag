import React from 'react';
import {Box, Text} from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import type {IndexDisplayStats} from '../../common/types.js';
import {useDaemonStatus} from '../contexts/DaemonStatusContext.js';

type Props = {
	version: string;
	cwd: string;
	isInitialized?: boolean;
	// undefined = not loaded yet, null = loaded but no manifest
	indexStats: IndexDisplayStats | null | undefined;
};

export default function WelcomeBanner({
	version,
	cwd,
	isInitialized,
	indexStats,
}: Props) {
	const daemonStatus = useDaemonStatus();

	// indexStats is only passed once fully loaded (undefined means still loading)
	const indexedFromDaemon =
		daemonStatus?.indexed === true && (daemonStatus.totalChunks ?? 0) > 0;
	const isIndexed =
		daemonStatus !== null
			? indexedFromDaemon
			: indexStats != null && indexStats.totalChunks > 0;
	const isIndexingActive =
		daemonStatus?.indexing.status === 'initializing' ||
		daemonStatus?.indexing.status === 'indexing' ||
		daemonStatus?.indexing.status === 'cancelling';

	return (
		<Box flexDirection="column" paddingX={1}>
			{/* Gradient Logo */}
			<Gradient colors={['#9D4EDD', '#00D9FF']}>
				<BigText text="VibeRAG" />
			</Gradient>

			{/* Info */}
			<Box flexDirection="column" marginTop={1}>
				<Box>
					<Text dimColor>v{version}</Text>
					{isInitialized === true && isIndexed && (
						<>
							<Text> </Text>
							<Text color="green">✓ Ready</Text>
						</>
					)}
				</Box>
				<Text dimColor>{cwd}</Text>
			</Box>

			{/* Help hint */}
			<Box marginTop={1}>
				<Text dimColor>Type /help for available commands</Text>
			</Box>

			{/* Status prompts */}
			{isInitialized === false && (
				<Box marginTop={1}>
					<Text color="yellow">Run /init to set up</Text>
				</Box>
			)}
			{isInitialized === true && !isIndexed && !isIndexingActive && (
				<Box marginTop={1}>
					<Text color="yellow">Run /index to build the code index</Text>
				</Box>
			)}
		</Box>
	);
}
