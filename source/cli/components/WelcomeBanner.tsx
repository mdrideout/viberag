import React from 'react';
import {Box, Text} from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';

type Props = {
	version: string;
	cwd: string;
};

export default function WelcomeBanner({version, cwd}: Props) {
	return (
		<Box flexDirection="column" paddingX={1}>
			{/* Gradient Logo */}
			<Gradient colors={['#9D4EDD', '#00D9FF']}>
				<BigText text="VibeRAG" />
			</Gradient>

			{/* Info */}
			<Box flexDirection="column" marginTop={1}>
				<Text dimColor>v{version}</Text>
				<Text dimColor>{cwd}</Text>
			</Box>

			{/* Help hint */}
			<Box marginTop={1}>
				<Text dimColor>Type /help for available commands</Text>
			</Box>
		</Box>
	);
}
