import React from 'react';
import {Box, Text} from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';

type Props = {
	version: string;
	cwd: string;
	isInitialized?: boolean;
};

export default function WelcomeBanner({version, cwd, isInitialized}: Props) {
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
					<Text> </Text>
					{isInitialized === true && <Text color="green">✓ Ready</Text>}
					{isInitialized === false && <Text color="yellow">Run /init to set up</Text>}
				</Box>
				<Text dimColor>{cwd}</Text>
			</Box>

			{/* Help hint */}
			<Box marginTop={1}>
				<Text dimColor>Type /help for available commands</Text>
			</Box>
		</Box>
	);
}
