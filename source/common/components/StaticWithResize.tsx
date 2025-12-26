import React, {useState, useRef, useEffect, useCallback} from 'react';
import {Static, useStdout} from 'ink';
import {useTerminalResize} from '../hooks/useTerminalResize.js';

/**
 * ANSI escape sequences for terminal control.
 */
const ANSI = {
	/** Clear visible screen */
	CLEAR_SCREEN: '\x1B[2J',
	/** Clear scrollback buffer */
	CLEAR_SCROLLBACK: '\x1B[3J',
	/** Move cursor to top-left */
	CURSOR_HOME: '\x1B[H',
} as const;

export type StaticWithResizeProps<T extends {id: string}> = {
	/**
	 * Items to render statically.
	 */
	items: T[];
	/**
	 * Render function for each item.
	 */
	children: (item: T, index: number) => React.ReactNode;
};

/**
 * Drop-in replacement for Ink's <Static> that handles terminal resize.
 *
 * On resize, clears the terminal and forces Static to remount,
 * which causes Ink to re-render all items with proper formatting.
 */
export function StaticWithResize<T extends {id: string}>({
	items,
	children,
}: StaticWithResizeProps<T>): React.ReactElement {
	const {stdout} = useStdout();
	const [generation, setGeneration] = useState(0);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Debounced resize handler that clears terminal and forces remount
	const handleResize = useCallback(() => {
		if (resizeTimerRef.current) {
			clearTimeout(resizeTimerRef.current);
		}

		resizeTimerRef.current = setTimeout(() => {
			if (stdout && items.length > 0) {
				// Clear terminal
				stdout.write(ANSI.CLEAR_SCREEN + ANSI.CLEAR_SCROLLBACK + ANSI.CURSOR_HOME);
				// Force Static to remount by changing key - this re-renders all items
				setGeneration(g => g + 1);
			}
			resizeTimerRef.current = null;
		}, 150); // Wait for resize to fully settle
	}, [stdout, items.length]);

	// Cleanup timer on unmount
	useEffect(() => {
		return () => {
			if (resizeTimerRef.current) {
				clearTimeout(resizeTimerRef.current);
			}
		};
	}, []);

	// Handle resize events
	useTerminalResize({
		onResize: (dimensions, previousDimensions) => {
			if (
				previousDimensions &&
				(dimensions.rows !== previousDimensions.rows ||
					dimensions.columns !== previousDimensions.columns)
			) {
				handleResize();
			}
		},
		debounceMs: 100,
	});

	// Key forces remount of Static, causing all items to re-render
	return (
		<Static key={generation} items={items}>
			{(item, index) => children(item, index)}
		</Static>
	);
}

export default StaticWithResize;
