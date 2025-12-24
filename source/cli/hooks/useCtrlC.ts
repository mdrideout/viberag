import {useRef, useCallback, useEffect} from 'react';
import {useApp} from 'ink';

type Options = {
	onFirstPress: () => void;
	onStatusClear: () => void;
	timeout?: number;
};

export function useCtrlC({
	onFirstPress,
	onStatusClear,
	timeout = 2000,
}: Options) {
	const {exit} = useApp();
	const lastPressTime = useRef<number>(0);
	const timeoutId = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cleanup timeout on unmount
	useEffect(() => {
		return () => {
			if (timeoutId.current) {
				clearTimeout(timeoutId.current);
			}
		};
	}, []);

	const handleCtrlC = useCallback(() => {
		const now = Date.now();
		const timeSinceLastPress = now - lastPressTime.current;

		if (timeSinceLastPress < timeout && lastPressTime.current !== 0) {
			// Second press within timeout - exit
			if (timeoutId.current) {
				clearTimeout(timeoutId.current);
			}
			exit();
		} else {
			// First press - show message and start timer
			lastPressTime.current = now;
			onFirstPress();

			// Clear the message after timeout
			if (timeoutId.current) {
				clearTimeout(timeoutId.current);
			}
			timeoutId.current = setTimeout(() => {
				lastPressTime.current = 0;
				onStatusClear();
			}, timeout);
		}
	}, [exit, onFirstPress, onStatusClear, timeout]);

	return {handleCtrlC};
}
