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
 * Embedding provider types (API-based only).
 * - gemini: text-embedding-004 (768d) - Free tier available
 * - mistral: mistral-embed (1024d) - Good for code
 * - openai: text-embedding-3-large (3072d) - Highest quality
 */
export type EmbeddingProviderType = 'gemini' | 'mistral' | 'openai';

/**
 * Configuration collected from the init wizard.
 */
export type InitWizardConfig = {
	provider: EmbeddingProviderType;
};

/**
 * MCP editor identifiers.
 */
export type McpEditorId =
	| 'claude-code'
	| 'vscode'
	| 'cursor'
	| 'windsurf'
	| 'roo-code'
	| 'zed'
	| 'gemini-cli'
	| 'codex'
	| 'jetbrains';

/**
 * MCP setup result.
 */
export type McpSetupResultType = {
	success: boolean;
	editor: McpEditorId;
	method: 'file-created' | 'file-merged' | 'cli-command' | 'instructions-shown';
	configPath?: string;
	error?: string;
};

/**
 * Configuration collected from the MCP setup wizard.
 */
export type McpSetupWizardConfig = {
	selectedEditors: McpEditorId[];
	results: McpSetupResultType[];
};

/**
 * MCP setup wizard step types.
 */
export type McpSetupStep = 'prompt' | 'select' | 'configure' | 'summary';

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
	  }
	| {
			active: true;
			type: 'mcp-setup';
			step: McpSetupStep;
			config: Partial<McpSetupWizardConfig>;
			showPrompt: boolean;
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
