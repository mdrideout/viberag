import {useState, useCallback, useRef} from 'react';

export function useCommandHistory() {
	const [history, setHistory] = useState<string[]>([]);
	const indexRef = useRef<number>(-1);

	const addToHistory = useCallback((command: string) => {
		// Don't add empty or duplicate consecutive commands
		setHistory(prev => {
			if (!command.trim() || prev[prev.length - 1] === command) {
				return prev;
			}
			return [...prev, command];
		});
		// Reset index when adding new command
		indexRef.current = -1;
	}, []);

	const navigateUp = useCallback((): string | null => {
		if (history.length === 0) return null;

		// If not navigating yet, start from the end
		if (indexRef.current === -1) {
			indexRef.current = history.length - 1;
		} else if (indexRef.current > 0) {
			indexRef.current -= 1;
		}

		return history[indexRef.current] ?? null;
	}, [history]);

	const navigateDown = useCallback((): string | null => {
		if (history.length === 0 || indexRef.current === -1) return null;

		if (indexRef.current < history.length - 1) {
			indexRef.current += 1;
			return history[indexRef.current] ?? null;
		} else {
			// At the end, reset and return null to clear input
			indexRef.current = -1;
			return null;
		}
	}, [history]);

	const resetIndex = useCallback(() => {
		indexRef.current = -1;
	}, []);

	return {
		history,
		addToHistory,
		navigateUp,
		navigateDown,
		resetIndex,
	};
}
