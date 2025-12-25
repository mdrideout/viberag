import React from 'react';
import {Box, Text} from 'ink';
import type {OutputItem} from '../types.js';

type Props = {
	items: OutputItem[];
};

export default function OutputArea({items}: Props) {
	return (
		<Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
			{items.map(item => (
				<Box key={item.id} marginBottom={1}>
					{item.type === 'user' ? (
						<Text color="cyan">&gt; {item.content}</Text>
					) : (
						<Text>{item.content}</Text>
					)}
				</Box>
			))}
		</Box>
	);
}
