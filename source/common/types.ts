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
	| {
			state: 'indexing';
			current: number;
			total: number;
			stage: string;
			/** Rate limit message (shown in yellow when set) */
			throttleMessage?: string | null;
			/** Number of chunks embedded so far */
			chunksProcessed?: number;
	  }
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
 *
 * Local providers (no API key required):
 * - local: Qwen3-Embedding-0.6B Q8 (1024d) - ~700MB download, ~1.2GB RAM
 * - local-4b: Qwen3-Embedding-4B FP32 (2560d) - ~8GB download, ~8GB RAM
 *
 * API providers:
 * - gemini: gemini-embedding-001 (1536d) - Free tier
 * - mistral: codestral-embed (1536d) - Code-optimized
 * - openai: text-embedding-3-small (1536d) - Fast API
 */
export type EmbeddingProviderType =
	| 'local'
	| 'local-4b'
	| 'gemini'
	| 'mistral'
	| 'openai';

/**
 * OpenAI API regional endpoints for data residency.
 */
export type OpenAIRegion = 'default' | 'us' | 'eu';

/**
 * Configuration collected from the init wizard.
 */
export type InitWizardConfig = {
	provider: EmbeddingProviderType;
	/** API key for cloud providers (gemini, mistral, openai) */
	apiKey?: string;
	/** OpenAI regional endpoint (for corporate accounts with data residency) */
	openaiRegion?: OpenAIRegion;
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
	| 'jetbrains'
	| 'opencode';

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
	selectedEditor: McpEditorId | null;
	selectedScope: 'global' | 'project' | null;
	result: McpSetupResultType | null;
};

/**
 * MCP setup wizard step types.
 */
export type McpSetupStep =
	| 'prompt'
	| 'select'
	| 'scope'
	| 'configure'
	| 'summary';

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
	  }
	| {
			active: true;
			type: 'clean';
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

/**
 * Command info for autocomplete with descriptions.
 */
export type CommandInfo = {
	command: string;
	description: string;
};
