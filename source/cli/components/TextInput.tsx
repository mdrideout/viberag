import React from 'react';
import {Box, Text, useInput} from 'ink';
import {useTextBuffer} from '../hooks/useTextBuffer.js';

type Props = {
	onSubmit: (text: string) => void;
	onCtrlC: () => void;
};

export default function TextInput({onSubmit, onCtrlC}: Props) {
	const {
		state,
		insertChar,
		insertNewline,
		deleteChar,
		moveCursor,
		clear,
		getText,
		isEmpty,
	} = useTextBuffer();

	useInput((input, key) => {
		// Ctrl+C handling
		if (key.ctrl && input === 'c') {
			if (!isEmpty()) {
				clear();
			} else {
				onCtrlC();
			}
			return;
		}

		// Submit on Enter (without shift)
		if (key.return && !key.shift) {
			const text = getText();
			if (text.trim()) {
				onSubmit(text);
				clear();
			}
			return;
		}

		// Shift+Enter for newline
		if (key.return && key.shift) {
			insertNewline();
			return;
		}

		// Backspace
		if (key.backspace) {
			deleteChar();
			return;
		}

		// Delete key
		if (key.delete) {
			// For now, treat delete same as backspace
			// A proper implementation would delete forward
			deleteChar();
			return;
		}

		// Arrow keys
		if (key.leftArrow) {
			moveCursor('left');
			return;
		}
		if (key.rightArrow) {
			moveCursor('right');
			return;
		}
		if (key.upArrow) {
			moveCursor('up');
			return;
		}
		if (key.downArrow) {
			moveCursor('down');
			return;
		}

		// Escape - clear input
		if (key.escape) {
			clear();
			return;
		}

		// Regular character input (ignore control sequences)
		if (input && !key.ctrl && !key.meta) {
			insertChar(input);
		}
	});

	// Render lines with cursor
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="blue"
			paddingX={1}
		>
			{state.lines.map((line, lineIdx) => {
				const isCurrentLine = lineIdx === state.cursorLine;
				const prefix = lineIdx === 0 ? '> ' : '  ';

				if (!isCurrentLine) {
					return (
						<Box key={lineIdx}>
							<Text color="blue">{prefix}</Text>
							<Text>{line || ' '}</Text>
						</Box>
					);
				}

				// Current line with cursor - render as three parts on same line
				const beforeCursor = line.slice(0, state.cursorCol);
				const cursorChar = line[state.cursorCol] ?? ' ';
				const afterCursor = line.slice(state.cursorCol + 1);

				return (
					<Box key={lineIdx}>
						<Text color="blue">{prefix}</Text>
						<Text>{beforeCursor}</Text>
						<Text inverse>{cursorChar}</Text>
						<Text>{afterCursor}</Text>
					</Box>
				);
			})}
		</Box>
	);
}
