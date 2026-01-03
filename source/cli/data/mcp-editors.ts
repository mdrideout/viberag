/**
 * MCP Editor Configuration Data
 *
 * Configuration for all supported AI coding tools and their MCP setup.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Supported editor/agent identifiers.
 */
export type EditorId =
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
 * Configuration for an editor/agent's MCP setup.
 */
export interface EditorConfig {
	/** Unique identifier */
	id: EditorId;
	/** Display name */
	name: string;
	/** Global config path (null = no global file config, ~ expanded at runtime) */
	globalConfigPath: string | null;
	/** Project config path (null = no project file config) */
	projectConfigPath: string | null;
	/** Config file format */
	configFormat: 'json' | 'toml' | 'ui';
	/** Whether editor supports global config */
	supportsGlobal: boolean;
	/** Whether editor supports project config */
	supportsProject: boolean;
	/** Default/recommended scope */
	defaultScope: 'global' | 'project' | 'ui';
	/** Whether we can auto-create the config */
	canAutoCreate: boolean;
	/** CLI command if available (null = none) */
	cliCommand: string | null;
	/** Official documentation URL */
	docsUrl: string;
	/** JSON key for servers object */
	jsonKey: string;
	/** Restart/reload instructions */
	restartInstructions: string;
	/** Verification steps */
	verificationSteps: string[];
	/** Instructions for UI-only global setup (VS Code, Roo Code) */
	globalUiInstructions?: string;
	/** Required post-setup steps (e.g., enabling agent mode in VS Code) */
	postSetupInstructions?: string[];
}

/**
 * All supported editors with their MCP configurations.
 * Sorted alphabetically by name.
 */
export const EDITORS: EditorConfig[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		globalConfigPath: '~/.claude.json',
		projectConfigPath: '.mcp.json',
		configFormat: 'json',
		supportsGlobal: true,
		supportsProject: true,
		defaultScope: 'global',
		canAutoCreate: true,
		cliCommand: 'claude mcp add viberag -- npx viberag-mcp',
		docsUrl: 'https://code.claude.com/docs/en/mcp',
		jsonKey: 'mcpServers',
		restartInstructions:
			'Restart Claude Code or run: claude mcp restart viberag',
		verificationSteps: [
			'Run /mcp in Claude Code',
			'Look for "viberag: connected"',
		],
	},
	{
		id: 'cursor',
		name: 'Cursor',
		globalConfigPath: '~/.cursor/mcp.json',
		projectConfigPath: '.cursor/mcp.json',
		configFormat: 'json',
		supportsGlobal: true,
		supportsProject: true,
		defaultScope: 'global',
		canAutoCreate: true,
		cliCommand: null,
		docsUrl: 'https://cursor.com/docs/context/mcp',
		jsonKey: 'mcpServers',
		restartInstructions: 'Restart Cursor or reload window',
		verificationSteps: [
			'Settings → Cursor Settings → MCP',
			'Verify "viberag" shows with toggle enabled',
		],
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		globalConfigPath: '~/.gemini/settings.json',
		projectConfigPath: '.gemini/settings.json',
		configFormat: 'json',
		supportsGlobal: true,
		supportsProject: true,
		defaultScope: 'global',
		canAutoCreate: false, // Has CLI command
		cliCommand: 'gemini mcp add viberag -- npx viberag-mcp',
		docsUrl: 'https://geminicli.com/docs/tools/mcp-server/',
		jsonKey: 'mcpServers',
		restartInstructions: 'Restart Gemini CLI session',
		verificationSteps: [
			'Run /mcp in Gemini CLI',
			'Look for "viberag" in server list',
		],
	},
	{
		id: 'jetbrains',
		name: 'JetBrains IDEs',
		globalConfigPath: null, // UI-only configuration
		projectConfigPath: null,
		configFormat: 'ui',
		supportsGlobal: true, // UI-based
		supportsProject: false,
		defaultScope: 'ui',
		canAutoCreate: false,
		cliCommand: null,
		docsUrl: 'https://www.jetbrains.com/help/ai-assistant/mcp.html',
		jsonKey: 'mcpServers',
		restartInstructions: 'No restart needed - changes apply immediately',
		verificationSteps: [
			'Settings → Tools → AI Assistant → MCP',
			'Verify "viberag" shows green in Status column',
		],
	},
	{
		id: 'codex',
		name: 'OpenAI Codex',
		globalConfigPath: '~/.codex/config.toml',
		projectConfigPath: null,
		configFormat: 'toml',
		supportsGlobal: true,
		supportsProject: false,
		defaultScope: 'global',
		canAutoCreate: false, // Has CLI command
		cliCommand: 'codex mcp add viberag -- npx viberag-mcp',
		docsUrl: 'https://developers.openai.com/codex/mcp/',
		jsonKey: 'mcp_servers', // TOML section name
		restartInstructions: 'Restart Codex session',
		verificationSteps: [
			'Run /mcp in Codex TUI',
			'Look for "viberag" in server list',
		],
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		globalConfigPath: '~/.config/opencode/opencode.json',
		projectConfigPath: 'opencode.json',
		configFormat: 'json',
		supportsGlobal: true,
		supportsProject: true,
		defaultScope: 'global',
		canAutoCreate: false,
		cliCommand: null,
		docsUrl: 'https://opencode.ai/docs/mcp-servers/',
		jsonKey: 'mcp',
		restartInstructions: 'Restart OpenCode session',
		verificationSteps: [
			'Check MCP servers list in OpenCode',
			'Verify "viberag" appears and is enabled',
		],
	},
	{
		id: 'roo-code',
		name: 'Roo Code',
		globalConfigPath: null, // Global is UI-only
		projectConfigPath: '.roo/mcp.json',
		configFormat: 'json',
		supportsGlobal: true, // But UI-only
		supportsProject: true,
		defaultScope: 'global',
		canAutoCreate: true, // For project scope only
		cliCommand: null,
		docsUrl: 'https://docs.roocode.com/features/mcp/using-mcp-in-roo',
		jsonKey: 'mcpServers',
		restartInstructions: 'Reload VS Code window',
		verificationSteps: [
			'Click MCP icon in Roo Code pane header',
			'Verify "viberag" appears in server list',
		],
		globalUiInstructions:
			'Click MCP icon → Edit Global MCP → Add viberag config',
	},
	{
		id: 'vscode',
		name: 'VS Code Copilot',
		globalConfigPath: null, // Global requires manual settings.json edit
		projectConfigPath: '.vscode/mcp.json',
		configFormat: 'json',
		supportsGlobal: true, // But manual only (no auto-config)
		supportsProject: true,
		defaultScope: 'global',
		canAutoCreate: true, // For project scope only
		cliCommand: null,
		docsUrl:
			'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
		jsonKey: 'servers', // VS Code uses 'servers', not 'mcpServers'
		restartInstructions:
			'Reload VS Code window (Cmd/Ctrl+Shift+P → "Reload Window")',
		verificationSteps: [
			'Cmd/Ctrl+Shift+P → "MCP: List Servers"',
			'Verify "viberag" appears with status',
		],
		globalUiInstructions: 'Open Settings (JSON) and add under "mcp.servers"',
		postSetupInstructions: [
			'Enable Agent Mode: Settings → "chat.agent.enabled" → check the box',
		],
	},
	{
		id: 'windsurf',
		name: 'Windsurf',
		globalConfigPath: '~/.codeium/windsurf/mcp_config.json',
		projectConfigPath: null,
		configFormat: 'json',
		supportsGlobal: true,
		supportsProject: false,
		defaultScope: 'global',
		canAutoCreate: false, // Needs merge with existing config
		cliCommand: null,
		docsUrl: 'https://docs.windsurf.com/windsurf/cascade/mcp',
		jsonKey: 'mcpServers',
		restartInstructions: 'Click refresh in Cascade Plugins panel, then restart',
		verificationSteps: [
			'Click Plugins icon in Cascade panel',
			'Verify "viberag" shows in plugin list',
		],
	},
	{
		id: 'zed',
		name: 'Zed',
		globalConfigPath: '~/.config/zed/settings.json', // Resolved at runtime via getZedSettingsPath
		projectConfigPath: '.zed/settings.json',
		configFormat: 'json',
		supportsGlobal: true,
		supportsProject: true,
		defaultScope: 'global',
		canAutoCreate: false, // JSONC merge required
		cliCommand: null,
		docsUrl: 'https://zed.dev/docs/ai/mcp',
		jsonKey: 'context_servers',
		restartInstructions: 'Restart Zed',
		verificationSteps: [
			'Open Agent Panel settings',
			'Verify "viberag" shows green indicator',
		],
	},
];

/**
 * Get editor by ID.
 */
export function getEditor(id: EditorId): EditorConfig | undefined {
	return EDITORS.find(e => e.id === id);
}

/**
 * Get editors that have CLI commands.
 */
export function getCliCommandEditors(): EditorConfig[] {
	return EDITORS.filter(e => e.cliCommand !== null);
}

/**
 * Expand ~ to home directory in path.
 */
export function expandPath(configPath: string): string {
	if (configPath.startsWith('~/')) {
		return path.join(os.homedir(), configPath.slice(2));
	}
	return configPath;
}

/**
 * Check if scope selection is needed for this editor.
 * Returns true if editor supports both global and project scopes.
 */
export function needsScopeSelection(editor: EditorConfig): boolean {
	return editor.supportsGlobal && editor.supportsProject;
}

/**
 * Get available scopes for an editor.
 */
export function getAvailableScopes(
	editor: EditorConfig,
): ('global' | 'project')[] {
	const scopes: ('global' | 'project')[] = [];
	if (editor.supportsGlobal && editor.defaultScope !== 'ui') {
		scopes.push('global');
	}
	if (editor.supportsProject) {
		scopes.push('project');
	}
	return scopes;
}

/**
 * Check if global config requires manual setup (no auto-config).
 * True for VS Code (settings.json) and Roo Code (UI-based global).
 */
export function isGlobalManualOnly(editor: EditorConfig): boolean {
	return editor.supportsGlobal && !editor.globalConfigPath;
}

/**
 * Get the absolute config path for an editor based on scope.
 * For project scope, projectRoot is required.
 */
export function getConfigPath(
	editor: EditorConfig,
	scope: 'global' | 'project',
	projectRoot?: string,
): string | null {
	if (scope === 'project') {
		if (!editor.projectConfigPath) return null;
		if (!projectRoot) {
			throw new Error(
				`Project root required for ${editor.name} project config`,
			);
		}
		return path.join(projectRoot, editor.projectConfigPath);
	}

	// Global scope - handle platform-specific paths
	if (!editor.globalConfigPath) return null;

	// Special platform handling for specific editors
	if (editor.id === 'zed') {
		return getZedSettingsPath();
	}
	if (editor.id === 'windsurf') {
		return getWindsurfConfigPath();
	}
	if (editor.id === 'opencode') {
		return getOpenCodeConfigPath();
	}

	return expandPath(editor.globalConfigPath);
}

/**
 * Get Zed settings path based on platform.
 * Zed uses ~/.config/zed/settings.json on macOS and Linux.
 */
export function getZedSettingsPath(): string {
	const platform = process.platform;
	if (platform === 'darwin' || platform === 'linux') {
		return path.join(os.homedir(), '.config/zed/settings.json');
	} else {
		// Windows - best guess
		return path.join(os.homedir(), 'AppData/Roaming/Zed/settings.json');
	}
}

/**
 * Get Windsurf config path based on platform.
 */
export function getWindsurfConfigPath(): string {
	const platform = process.platform;
	if (platform === 'win32') {
		return path.join(os.homedir(), '.codeium/windsurf/mcp_config.json');
	}
	return path.join(os.homedir(), '.codeium/windsurf/mcp_config.json');
}

/**
 * Get OpenCode config path based on platform.
 */
export function getOpenCodeConfigPath(): string {
	const platform = process.platform;
	if (platform === 'win32') {
		// Windows uses APPDATA for config
		return path.join(os.homedir(), 'AppData/Roaming/opencode/opencode.json');
	}
	// macOS, Linux, etc. use ~/.config/opencode/
	return path.join(os.homedir(), '.config/opencode/opencode.json');
}
