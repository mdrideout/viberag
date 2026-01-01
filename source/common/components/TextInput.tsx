import React, {useState, useMemo, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import {useTextBuffer} from '../hooks/useTextBuffer.js';
import CommandSuggestions from './CommandSuggestions.js';
import type {CommandInfo} from '../types.js';

type Props = {
	onSubmit: (text: string) => void;
	onCtrlC: () => void;
	commands?: CommandInfo[];
	navigateHistoryUp?: () => string | null;
	navigateHistoryDown?: () => string | null;
	resetHistoryIndex?: () => void;
};

function filterCommands(input: string, commands: CommandInfo[]): CommandInfo[] {
	if (!input.startsWith('/')) return [];
	const lower = input.toLowerCase();
	return commands.filter(cmd => cmd.command.toLowerCase().startsWith(lower));
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
		deleteCharBefore,
		moveCursor,
		clear,
		setText,
		getText,
		isEmpty,
	} = useTextBuffer();

	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

	// Track ESC key timing for ESC+Enter newline detection
	// (used by /terminal-setup which sends \u001b\r for Shift+Enter)
	const escPressedTimeRef = useRef<number>(0);

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
			}
			// Always call onCtrlC so the quit timer starts even when clearing text
			onCtrlC();
			return;
		}

		// === CSI u detection for iTerm2/Kitty with enhanced keyboard mode ===
		// When "Report modifiers using CSI u" is enabled:
		//   Shift+Enter sends: \x1b[13;2u (keycode=13/Enter, modifier=2/Shift)
		//   Alt+Enter sends: \x1b[13;3u (modifier=3/Alt)
		// Ink strips the ESC prefix, leaving: [13;2u or [13;3u
		if (input === '[13;2u' || input === '[13;3u') {
			insertNewline();
			setSelectedSuggestionIndex(0);
			escPressedTimeRef.current = 0;
			return;
		}

		// === ESC+LF/CR detection for VS Code (via /terminal-setup) ===
		// VS Code keybinding sends ESC (0x1B) + LF (0x0A) or ESC + CR (0x0D)
		// Ink's parseKeypress doesn't recognize this 2-byte sequence, so:
		// - keypress.name stays empty → key.return = false
		// - ESC is stripped → input = '\n' or '\r'
		// Detection: input is newline char BUT key.return is false (unrecognized sequence)
		if (
			(input === '\n' || input === '\r') &&
			!key.return &&
			!key.ctrl &&
			!key.shift
		) {
			insertNewline();
			setSelectedSuggestionIndex(0);
			escPressedTimeRef.current = 0;
			return;
		}

		// Also handle when escape/meta flag is set (fallback for terminals that do parse it)
		if ((key.escape || key.meta) && (input === '\n' || input === '\r')) {
			insertNewline();
			setSelectedSuggestionIndex(0);
			escPressedTimeRef.current = 0;
			return;
		}

		// Ctrl+J - explicit handling for terminals that report it as ctrl+j
		// (Most terminals send raw LF which is caught by the ESC+LF detection above)
		if (key.ctrl && input === 'j') {
			insertNewline();
			setSelectedSuggestionIndex(0);
			return;
		}

		// Tab - accept suggestion
		if (key.tab && suggestionsVisible) {
			const selected = suggestions[selectedSuggestionIndex];
			if (selected) {
				setText(selected.command);
				setSelectedSuggestionIndex(0);
			}
			return;
		}

		// Submit on Enter (without shift) - but check for ESC+Enter and backslash first
		if (key.return && !key.shift && !key.meta) {
			// Timing-based ESC+Enter detection (for terminals that send separately)
			if (Date.now() - escPressedTimeRef.current < 150) {
				insertNewline();
				setSelectedSuggestionIndex(0);
				escPressedTimeRef.current = 0;
				return;
			}

			// Method 1: Backslash + Enter (universal newline)
			const currentLine = state.lines[state.cursorLine] ?? '';
			const charBeforeCursor = currentLine[state.cursorCol - 1];

			if (charBeforeCursor === '\\') {
				// Remove backslash and insert newline
				deleteCharBefore();
				insertNewline();
				setSelectedSuggestionIndex(0);
				return;
			}

			let text = getText();

			// If suggestions visible, complete AND submit in one action
			if (suggestionsVisible) {
				const selected = suggestions[selectedSuggestionIndex];
				if (selected) {
					text = selected.command;
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

		// Method 2: Shift+Enter for newline (Kitty terminals)
		if (key.return && key.shift) {
			insertNewline();
			setSelectedSuggestionIndex(0);
			return;
		}

		// Method 4: Alt/Option+Enter for newline (most terminals)
		if (key.return && key.meta) {
			insertNewline();
			setSelectedSuggestionIndex(0);
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

		// Plain ESC key - clear input after a delay
		// (ESC+LF for Shift+Enter is already handled above)
		if (key.escape && !input) {
			escPressedTimeRef.current = Date.now();
			setTimeout(() => {
				if (escPressedTimeRef.current !== 0) {
					clear();
					setSelectedSuggestionIndex(0);
					escPressedTimeRef.current = 0;
				}
			}, 150);
			return;
		}

		// Regular character input (ignore control sequences and newlines)
		if (
			input &&
			!key.ctrl &&
			!key.meta &&
			!key.escape &&
			input !== '\n' &&
			input !== '\r'
		) {
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
