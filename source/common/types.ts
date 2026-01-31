/**
 * V2 search explain channel.
 */
export type SearchExplainChannel = {
	channel: 'fts' | 'vector';
	source: string;
	rank: number;
	rawScore: number;
};

/**
 * V2 search explain payload (why a hit matched).
 */
export type SearchExplain = {
	channels: SearchExplainChannel[];
	priors: Array<{name: string; value: number; note: string}>;
};

/**
 * A single search hit for display (v2 grouped search).
 */
export type SearchHit = {
	table: 'symbols' | 'chunks' | 'files' | 'refs';
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	title: string;
	snippet: string;
	score: number;
	why?: SearchExplain;
};

/**
 * Search results data for display.
 */
export type SearchResultsData = {
	query: string;
	intentUsed:
		| 'definition'
		| 'usage'
		| 'concept'
		| 'exact_text'
		| 'similar_code';
	elapsedMs: number;
	filtersApplied: {
		path_prefix?: string[];
		path_contains?: string[];
		path_not_contains?: string[];
		extension?: string[];
	};
	groups: {
		definitions: SearchHit[];
		usages: SearchHit[];
		files: SearchHit[];
		blocks: SearchHit[];
	};
	suggestedNextActions: Array<{
		tool:
			| 'get_symbol_details'
			| 'read_file_lines'
			| 'get_surrounding_code'
			| 'find_references';
		args: Record<string, unknown>;
	}>;
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
 *
 * Note: Indexing state is derived from daemon status.
 * Do NOT use appStatus for indexing - use DaemonStatusContext instead.
 */
export type AppStatus =
	| {state: 'ready'}
	| {state: 'searching'}
	| {state: 'working'; message: string}
	| {state: 'warning'; message: string};

/**
 * Index statistics for display.
 */
export type IndexDisplayStats = {
	totalFiles: number;
	totalSymbols: number;
	totalChunks: number;
	totalRefs: number;
};

/**
 * Embedding provider types.
 *
 * Local provider (no API key required):
 * - local: Qwen3-Embedding-0.6B Q8 (1024d) - ~700MB download, ~1.2GB RAM
 *
 * API providers:
 * - gemini: gemini-embedding-001 (1536d) - Free tier
 * - mistral: codestral-embed (1536d) - Code-optimized
 * - openai: text-embedding-3-large (1536d) - Highest quality
 */
export type EmbeddingProviderType = 'local' | 'gemini' | 'mistral' | 'openai';

/**
 * OpenAI API regional endpoints for data residency.
 */
export type OpenAIRegion = 'default' | 'us' | 'eu';

/**
 * Configuration collected from the init wizard.
 */
export type InitWizardConfig = {
	provider: EmbeddingProviderType;
	/**
	 * Selected global API key id (stored under ~/.local/share/viberag/secrets).
	 * This is the preferred way to configure cloud providers.
	 */
	apiKeyId?: string;
	/**
	 * New API key entered during the wizard. This is written to the global
	 * secrets store and is never persisted to the per-project config.
	 */
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
