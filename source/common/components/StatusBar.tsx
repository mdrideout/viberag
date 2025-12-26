import React from 'react';
import {Box, Text} from 'ink';

type Props = {
	message: string;
	indexingStatus?: string;
};

export default function StatusBar({message, indexingStatus}: Props) {
	// Don't render if no messages to show
	if (!message && !indexingStatus) {
		return null;
	}

	return (
		<Box paddingX={1} marginBottom={1}>
			{message ? (
				<Text color="yellow">{message}</Text>
			) : indexingStatus ? (
				<Text color="cyan">{indexingStatus}</Text>
			) : null}
		</Box>
	);
}
