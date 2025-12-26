import React from 'react';
import {Box, Text} from 'ink';

type Props = {
	suggestions: string[];
	selectedIndex: number;
	visible: boolean;
};

export default function CommandSuggestions({
	suggestions,
	selectedIndex,
	visible,
}: Props) {
	if (!visible || suggestions.length === 0) {
		return null;
	}

	return (
		<Box flexDirection="column" marginLeft={2} marginTop={0}>
			{suggestions.map((suggestion, index) => (
				<Box key={suggestion}>
					<Text
						color={index === selectedIndex ? 'cyan' : undefined}
						inverse={index === selectedIndex}
					>
						{' '}
						{suggestion}{' '}
					</Text>
				</Box>
			))}
		</Box>
	);
}
