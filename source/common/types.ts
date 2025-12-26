export type OutputItem = {
	id: string;
	type: 'user' | 'system' | 'welcome';
	content: string;
};

/**
 * Terminal dimensions for resize handling.
 */
export type TerminalDimensions = {
	rows: number;
	columns: number;
};

export type TextBufferState = {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
};

/**
 * App status for the status bar.
 */
export type AppStatus =
	| {state: 'ready'}
	| {state: 'indexing'; current: number; total: number; stage: string}
	| {state: 'searching'}
	| {state: 'warning'; message: string};

/**
 * Index statistics for display.
 */
export type IndexDisplayStats = {
	totalFiles: number;
	totalChunks: number;
};
