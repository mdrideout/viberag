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
	| 'jetbrains';

/**
 * Configuration for an editor/agent's MCP setup.
 */
export interface EditorConfig {
	/** Unique identifier */
	id: EditorId;
	/** Display name */
	name: string;
	/** Config file path (null = no file config, ~ expanded at runtime) */
	configPath: string | null;
	/** Config file format */
	configFormat: 'json' | 'toml' | 'ui';
	/** Configuration scope */
	scope: 'project' | 'global' | 'ui';
	/** Whether we can auto-create the config */
	canAutoCreate: boolean;
	/** CLI command if available (null = none) */
	cliCommand: string | null;
	/** Official documentation URL */
	docsUrl: string;
	/** JSON key for servers object */
	jsonKey: string;
	/** Short description for wizard */
	description: string;
	/** Restart/reload instructions */
	restartInstructions: string;
	/** Verification steps */
	verificationSteps: string[];
}

/**
 * All supported editors with their MCP configurations.
 */
export const EDITORS: EditorConfig[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		configPath: '.mcp.json',
		configFormat: 'json',
		scope: 'project',
		canAutoCreate: true,
		cliCommand: 'claude mcp add viberag -- npx viberag-mcp',
		docsUrl: 'https://code.claude.com/docs/en/mcp',
		jsonKey: 'mcpServers',
		description: 'auto-setup',
		restartInstructions:
			'Restart Claude Code or run: claude mcp restart viberag',
		verificationSteps: [
			'Run /mcp in Claude Code',
			'Look for "viberag: connected"',
		],
	},
	{
		id: 'vscode',
		name: 'VS Code Copilot',
		configPath: '.vscode/mcp.json',
		configFormat: 'json',
		scope: 'project',
		canAutoCreate: true,
		cliCommand: null,
		docsUrl:
			'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
		jsonKey: 'servers', // VS Code uses 'servers', not 'mcpServers'
		description: 'auto-setup',
		restartInstructions:
			'Reload VS Code window (Cmd/Ctrl+Shift+P → "Reload Window")',
		verificationSteps: [
			'Cmd/Ctrl+Shift+P → "MCP: List Servers"',
			'Verify "viberag" appears with status',
		],
	},
	{
		id: 'cursor',
		name: 'Cursor',
		configPath: '.cursor/mcp.json',
		configFormat: 'json',
		scope: 'project',
		canAutoCreate: true,
		cliCommand: null,
		docsUrl: 'https://cursor.com/docs/context/mcp',
		jsonKey: 'mcpServers',
		description: 'auto-setup',
		restartInstructions: 'Restart Cursor or reload window',
		verificationSteps: [
			'Settings → Cursor Settings → MCP',
			'Verify "viberag" shows with toggle enabled',
		],
	},
	{
		id: 'roo-code',
		name: 'Roo Code',
		configPath: '.roo/mcp.json',
		configFormat: 'json',
		scope: 'project',
		canAutoCreate: true,
		cliCommand: null,
		docsUrl: 'https://docs.roocode.com/features/mcp/using-mcp-in-roo',
		jsonKey: 'mcpServers',
		description: 'auto-setup',
		restartInstructions: 'Reload VS Code window',
		verificationSteps: [
			'Click MCP icon in Roo Code pane header',
			'Verify "viberag" appears in server list',
		],
	},
	{
		id: 'windsurf',
		name: 'Windsurf',
		configPath: '~/.codeium/windsurf/mcp_config.json',
		configFormat: 'json',
		scope: 'global',
		canAutoCreate: false, // Needs merge with existing config
		cliCommand: null,
		docsUrl: 'https://docs.windsurf.com/windsurf/cascade/mcp',
		jsonKey: 'mcpServers',
		description: 'global config',
		restartInstructions:
			'Click refresh in Cascade Plugins panel, then restart',
		verificationSteps: [
			'Click Plugins icon in Cascade panel',
			'Verify "viberag" shows in plugin list',
		],
	},
	{
		id: 'zed',
		name: 'Zed',
		configPath: '~/Library/Application Support/Zed/settings.json', // macOS default
		configFormat: 'json',
		scope: 'global',
		canAutoCreate: false, // Needs merge with existing config
		cliCommand: null,
		docsUrl: 'https://zed.dev/docs/ai/mcp',
		jsonKey: 'context_servers', // Different key!
		description: 'global config',
		restartInstructions: 'Restart Zed',
		verificationSteps: [
			'Open Agent Panel settings',
			'Verify "viberag" shows green indicator',
		],
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		configPath: '~/.gemini/settings.json',
		configFormat: 'json',
		scope: 'global',
		canAutoCreate: false, // Has CLI command
		cliCommand: 'gemini mcp add viberag -- npx viberag-mcp',
		docsUrl: 'https://geminicli.com/docs/tools/mcp-server/',
		jsonKey: 'mcpServers',
		description: 'CLI command',
		restartInstructions: 'Restart Gemini CLI session',
		verificationSteps: [
			'Run /mcp in Gemini CLI',
			'Look for "viberag" in server list',
		],
	},
	{
		id: 'codex',
		name: 'OpenAI Codex',
		configPath: '~/.codex/config.toml',
		configFormat: 'toml',
		scope: 'global',
		canAutoCreate: false, // Has CLI command
		cliCommand: 'codex mcp add viberag -- npx viberag-mcp',
		docsUrl: 'https://developers.openai.com/codex/mcp/',
		jsonKey: 'mcp_servers', // TOML section name
		description: 'CLI command',
		restartInstructions: 'Restart Codex session',
		verificationSteps: [
			'Run /mcp in Codex TUI',
			'Look for "viberag" in server list',
		],
	},
	{
		id: 'jetbrains',
		name: 'JetBrains IDEs',
		configPath: null, // UI-only configuration
		configFormat: 'ui',
		scope: 'ui',
		canAutoCreate: false,
		cliCommand: null,
		docsUrl: 'https://www.jetbrains.com/help/ai-assistant/mcp.html',
		jsonKey: 'mcpServers',
		description: 'manual setup',
		restartInstructions: 'No restart needed - changes apply immediately',
		verificationSteps: [
			'Settings → Tools → AI Assistant → MCP',
			'Verify "viberag" shows green in Status column',
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
 * Get editors that support auto-creation of project-level config.
 */
export function getAutoCreateEditors(): EditorConfig[] {
	return EDITORS.filter(e => e.canAutoCreate && e.scope === 'project');
}

/**
 * Get editors that require global config merging.
 */
export function getGlobalConfigEditors(): EditorConfig[] {
	return EDITORS.filter(e => e.scope === 'global');
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
 * Get the absolute config path for an editor.
 * For project-scope editors, projectRoot is required.
 */
export function getConfigPath(
	editor: EditorConfig,
	projectRoot?: string,
): string | null {
	if (!editor.configPath) {
		return null;
	}

	if (editor.scope === 'project') {
		if (!projectRoot) {
			throw new Error(`Project root required for ${editor.name}`);
		}
		return path.join(projectRoot, editor.configPath);
	}

	return expandPath(editor.configPath);
}

/**
 * Get Zed settings path based on platform.
 */
export function getZedSettingsPath(): string {
	const platform = process.platform;
	if (platform === 'darwin') {
		return path.join(
			os.homedir(),
			'Library/Application Support/Zed/settings.json',
		);
	} else if (platform === 'linux') {
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
