import React from 'react';
import {Box, Text} from 'ink';
import type {CommandInfo} from '../types.js';

type Props = {
	suggestions: CommandInfo[];
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

	// Calculate max command width for alignment
	const maxCmdWidth = Math.max(...suggestions.map(s => s.command.length));

	return (
		<Box flexDirection="column" marginLeft={2} marginTop={0}>
			{suggestions.map((suggestion, index) => {
				const isSelected = index === selectedIndex;
				const paddedCmd = suggestion.command.padEnd(maxCmdWidth);

				return (
					<Box key={suggestion.command}>
						<Text
							color={isSelected ? 'cyan' : undefined}
							inverse={isSelected}
						>
							{' '}
							{paddedCmd}
						</Text>
						<Text dimColor={!isSelected} color={isSelected ? 'gray' : undefined}>
							{' '}
							{suggestion.description}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}
