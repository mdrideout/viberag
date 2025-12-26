import {useEffect, useState, useRef, useCallback} from 'react';
import {useStdout} from 'ink';
import type {TerminalDimensions} from '../types.js';

export type UseTerminalResizeOptions = {
	/**
	 * Callback invoked on resize (after debounce).
	 */
	onResize?: (
		dimensions: TerminalDimensions,
		previousDimensions: TerminalDimensions | null,
	) => void;
	/**
	 * Debounce delay in milliseconds. Default: 50
	 */
	debounceMs?: number;
};

export type UseTerminalResizeResult = {
	/**
	 * Current terminal dimensions.
	 */
	dimensions: TerminalDimensions;
	/**
	 * Previous terminal dimensions (null on first render).
	 */
	previousDimensions: TerminalDimensions | null;
};

/**
 * Hook to detect terminal resize events.
 *
 * Subscribes to stdout 'resize' events and provides current/previous dimensions.
 * Debounces rapid resize events to avoid excessive re-renders.
 */
export function useTerminalResize(
	options: UseTerminalResizeOptions = {},
): UseTerminalResizeResult {
	const {onResize, debounceMs = 50} = options;
	const {stdout} = useStdout();

	const getDimensions = useCallback((): TerminalDimensions => {
		return {
			rows: stdout?.rows ?? 24,
			columns: stdout?.columns ?? 80,
		};
	}, [stdout]);

	const [dimensions, setDimensions] =
		useState<TerminalDimensions>(getDimensions);
	const [previousDimensions, setPreviousDimensions] =
		useState<TerminalDimensions | null>(null);

	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onResizeRef = useRef(onResize);

	// Keep callback ref up to date
	useEffect(() => {
		onResizeRef.current = onResize;
	}, [onResize]);

	useEffect(() => {
		const handleResize = () => {
			// Clear any pending debounce
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}

			debounceTimerRef.current = setTimeout(() => {
				const newDimensions = getDimensions();
				setDimensions(prev => {
					setPreviousDimensions(prev);
					onResizeRef.current?.(newDimensions, prev);
					return newDimensions;
				});
				debounceTimerRef.current = null;
			}, debounceMs);
		};

		process.stdout.on('resize', handleResize);

		return () => {
			process.stdout.off('resize', handleResize);
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, [getDimensions, debounceMs]);

	return {dimensions, previousDimensions};
}
