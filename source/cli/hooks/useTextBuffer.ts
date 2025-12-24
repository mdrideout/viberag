import {useState, useCallback} from 'react';
import type {TextBufferState} from '../types.js';

export function useTextBuffer() {
	const [state, setState] = useState<TextBufferState>({
		lines: [''],
		cursorLine: 0,
		cursorCol: 0,
	});

	const insertChar = useCallback((char: string) => {
		setState(prev => {
			const newLines = [...prev.lines];
			const line = newLines[prev.cursorLine] ?? '';
			newLines[prev.cursorLine] =
				line.slice(0, prev.cursorCol) + char + line.slice(prev.cursorCol);
			return {
				...prev,
				lines: newLines,
				cursorCol: prev.cursorCol + char.length,
			};
		});
	}, []);

	const insertNewline = useCallback(() => {
		setState(prev => {
			const newLines = [...prev.lines];
			const line = newLines[prev.cursorLine] ?? '';
			const before = line.slice(0, prev.cursorCol);
			const after = line.slice(prev.cursorCol);
			newLines[prev.cursorLine] = before;
			newLines.splice(prev.cursorLine + 1, 0, after);
			return {
				lines: newLines,
				cursorLine: prev.cursorLine + 1,
				cursorCol: 0,
			};
		});
	}, []);

	const deleteChar = useCallback(() => {
		setState(prev => {
			if (prev.cursorCol === 0 && prev.cursorLine === 0) return prev;

			const newLines = [...prev.lines];

			if (prev.cursorCol === 0) {
				// Merge with previous line
				const currentLine = newLines[prev.cursorLine] ?? '';
				const prevLineLen = (newLines[prev.cursorLine - 1] ?? '').length;
				newLines[prev.cursorLine - 1] =
					(newLines[prev.cursorLine - 1] ?? '') + currentLine;
				newLines.splice(prev.cursorLine, 1);
				return {
					lines: newLines,
					cursorLine: prev.cursorLine - 1,
					cursorCol: prevLineLen,
				};
			} else {
				// Delete character before cursor
				const line = newLines[prev.cursorLine] ?? '';
				newLines[prev.cursorLine] =
					line.slice(0, prev.cursorCol - 1) + line.slice(prev.cursorCol);
				return {
					...prev,
					lines: newLines,
					cursorCol: prev.cursorCol - 1,
				};
			}
		});
	}, []);

	const moveCursor = useCallback(
		(direction: 'left' | 'right' | 'up' | 'down') => {
			setState(prev => {
				switch (direction) {
					case 'left':
						if (prev.cursorCol > 0) {
							return {...prev, cursorCol: prev.cursorCol - 1};
						} else if (prev.cursorLine > 0) {
							const prevLineLen = (prev.lines[prev.cursorLine - 1] ?? '')
								.length;
							return {
								...prev,
								cursorLine: prev.cursorLine - 1,
								cursorCol: prevLineLen,
							};
						}
						return prev;

					case 'right': {
						const lineLen = (prev.lines[prev.cursorLine] ?? '').length;
						if (prev.cursorCol < lineLen) {
							return {...prev, cursorCol: prev.cursorCol + 1};
						} else if (prev.cursorLine < prev.lines.length - 1) {
							return {...prev, cursorLine: prev.cursorLine + 1, cursorCol: 0};
						}
						return prev;
					}

					case 'up':
						if (prev.cursorLine > 0) {
							const newLineLen = (prev.lines[prev.cursorLine - 1] ?? '').length;
							return {
								...prev,
								cursorLine: prev.cursorLine - 1,
								cursorCol: Math.min(prev.cursorCol, newLineLen),
							};
						}
						return prev;

					case 'down':
						if (prev.cursorLine < prev.lines.length - 1) {
							const newLineLen = (prev.lines[prev.cursorLine + 1] ?? '').length;
							return {
								...prev,
								cursorLine: prev.cursorLine + 1,
								cursorCol: Math.min(prev.cursorCol, newLineLen),
							};
						}
						return prev;

					default:
						return prev;
				}
			});
		},
		[],
	);

	const clear = useCallback(() => {
		setState({lines: [''], cursorLine: 0, cursorCol: 0});
	}, []);

	const getText = useCallback(() => {
		return state.lines.join('\n');
	}, [state.lines]);

	const isEmpty = useCallback(() => {
		return state.lines.length === 1 && state.lines[0] === '';
	}, [state.lines]);

	return {
		state,
		insertChar,
		insertNewline,
		deleteChar,
		moveCursor,
		clear,
		getText,
		isEmpty,
	};
}
