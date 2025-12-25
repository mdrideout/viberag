import React, {useState, useMemo} from 'react';
import {Box, Text, useInput} from 'ink';
import {useTextBuffer} from '../hooks/useTextBuffer.js';
import CommandSuggestions from './CommandSuggestions.js';

type Props = {
	onSubmit: (text: string) => void;
	onCtrlC: () => void;
	commands?: string[];
	navigateHistoryUp?: () => string | null;
	navigateHistoryDown?: () => string | null;
	resetHistoryIndex?: () => void;
};

function filterCommands(input: string, commands: string[]): string[] {
	if (!input.startsWith('/')) return [];
	const lower = input.toLowerCase();
	return commands.filter(cmd => cmd.toLowerCase().startsWith(lower));
}

export default function TextInput({
	onSubmit,
	onCtrlC,
	commands = [],
	navigateHistoryUp,
	navigateHistoryDown,
	resetHistoryIndex,
}: Props) {
	const {
		state,
		insertChar,
		insertNewline,
		deleteChar,
		moveCursor,
		clear,
		setText,
		getText,
		isEmpty,
	} = useTextBuffer();

	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

	// Filter commands based on current input
	const currentText = getText();
	const suggestions = useMemo(
		() => filterCommands(currentText, commands),
		[currentText, commands],
	);
	const suggestionsVisible = suggestions.length > 0;

	useInput((input, key) => {
		// Reset history index when user types
		if (input && !key.ctrl && !key.meta) {
			resetHistoryIndex?.();
		}

		// Ctrl+C handling
		if (key.ctrl && input === 'c') {
			if (!isEmpty()) {
				clear();
				setSelectedSuggestionIndex(0);
			} else {
				onCtrlC();
			}
			return;
		}

		// Tab - accept suggestion
		if (key.tab && suggestionsVisible) {
			const selected = suggestions[selectedSuggestionIndex];
			if (selected) {
				setText(selected);
				setSelectedSuggestionIndex(0);
			}
			return;
		}

		// Submit on Enter (without shift)
		if (key.return && !key.shift) {
			let text = getText();

			// If suggestions visible, complete AND submit in one action
			if (suggestionsVisible) {
				const selected = suggestions[selectedSuggestionIndex];
				if (selected) {
					text = selected;
				}
			}

			// Submit
			if (text.trim()) {
				onSubmit(text);
				clear();
				setSelectedSuggestionIndex(0);
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
			setSelectedSuggestionIndex(0);
			return;
		}

		// Delete key
		if (key.delete) {
			deleteChar();
			setSelectedSuggestionIndex(0);
			return;
		}

		// Up arrow
		if (key.upArrow) {
			if (suggestionsVisible) {
				// Navigate suggestions
				setSelectedSuggestionIndex(i => Math.max(0, i - 1));
			} else if (isEmpty() && navigateHistoryUp) {
				// Navigate history when input is empty
				const prev = navigateHistoryUp();
				if (prev !== null) {
					setText(prev);
				}
			} else {
				// Move cursor in multi-line
				moveCursor('up');
			}
			return;
		}

		// Down arrow
		if (key.downArrow) {
			if (suggestionsVisible) {
				// Navigate suggestions
				setSelectedSuggestionIndex(i =>
					Math.min(suggestions.length - 1, i + 1),
				);
			} else if (isEmpty() && navigateHistoryDown) {
				// Navigate history when input is empty
				const next = navigateHistoryDown();
				if (next !== null) {
					setText(next);
				} else {
					clear();
				}
			} else {
				// Move cursor in multi-line
				moveCursor('down');
			}
			return;
		}

		// Left/Right arrows
		if (key.leftArrow) {
			moveCursor('left');
			return;
		}
		if (key.rightArrow) {
			moveCursor('right');
			return;
		}

		// Escape - clear input or hide suggestions
		if (key.escape) {
			clear();
			setSelectedSuggestionIndex(0);
			return;
		}

		// Regular character input (ignore control sequences)
		if (input && !key.ctrl && !key.meta) {
			insertChar(input);
			setSelectedSuggestionIndex(0);
		}
	});

	// Render lines with cursor
	return (
		<Box flexDirection="column">
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

			{/* Autocomplete suggestions dropdown */}
			<CommandSuggestions
				suggestions={suggestions}
				selectedIndex={selectedSuggestionIndex}
				visible={suggestionsVisible}
			/>
		</Box>
	);
}
