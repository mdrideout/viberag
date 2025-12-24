export type OutputItem = {
	id: string;
	type: 'user' | 'system';
	content: string;
};

export type TextBufferState = {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
};
