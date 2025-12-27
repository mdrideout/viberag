/**
 * A single search result item for display.
 */
export type SearchResultItem = {
	type: string;
	name: string;
	filepath: string;
	filename: string;
	startLine: number;
	endLine: number;
	score: number;
	text: string;
};

/**
 * Search results data for display.
 */
export type SearchResultsData = {
	query: string;
	elapsedMs: number;
	results: SearchResultItem[];
};

/**
 * Output items for the CLI display.
 */
export type OutputItem =
	| {id: string; type: 'user'; content: string}
	| {id: string; type: 'system'; content: string}
	| {id: string; type: 'welcome'; content: string}
	| {id: string; type: 'search-results'; data: SearchResultsData};

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

/**
 * Embedding provider types.
 * - local: jina-embeddings-v2-base-code (768d, 8K context, ~70% accuracy)
 * - gemini: gemini-embedding-001 (768d, 2K context, 74.66% accuracy)
 * - mistral: codestral-embed-2505 (1024d, 8K context, 85% accuracy)
 */
export type EmbeddingProviderType = 'local' | 'gemini' | 'mistral';

/**
 * Configuration collected from the init wizard.
 */
export type InitWizardConfig = {
	provider: EmbeddingProviderType;
};

/**
 * Wizard mode state for the app.
 */
export type WizardMode =
	| {active: false}
	| {
			active: true;
			type: 'init';
			step: number;
			config: Partial<InitWizardConfig>;
			isReinit: boolean;
	  };

/**
 * Provider configuration with model specs.
 */
export type ProviderConfig = {
	name: string;
	model: string;
	dimensions: number;
	context: string;
	performance: string;
	pricing: string;
	description: string;
};
