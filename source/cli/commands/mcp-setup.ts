/**
 * MCP Setup Logic
 *
 * Functions for generating, writing, and merging MCP configurations
 * for various AI coding tools.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
	type EditorConfig,
	type EditorId,
	getConfigPath,
	getZedSettingsPath,
	getWindsurfConfigPath,
} from '../data/mcp-editors.js';

/**
 * Result of an MCP setup operation.
 */
export interface McpSetupResult {
	success: boolean;
	editor: EditorId;
	method: 'file-created' | 'file-merged' | 'cli-command' | 'instructions-shown';
	configPath?: string;
	error?: string;
}

/**
 * Generate the viberag MCP server configuration object.
 */
export function generateViberagConfig(): object {
	return {
		command: 'npx',
		args: ['viberag-mcp'],
	};
}

/**
 * Generate complete MCP config for an editor.
 */
export function generateMcpConfig(editor: EditorConfig): object {
	const viberagConfig = generateViberagConfig();

	// Use the editor's specific key
	return {
		[editor.jsonKey]: {
			viberag: viberagConfig,
		},
	};
}

/**
 * Generate TOML config for OpenAI Codex.
 */
export function generateTomlConfig(): string {
	return `[mcp_servers.viberag]
command = "npx"
args = ["viberag-mcp"]
`;
}

/**
 * Check if a config file exists.
 */
export async function configExists(configPath: string): Promise<boolean> {
	try {
		await fs.access(configPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read existing config file as JSON.
 */
export async function readJsonConfig(configPath: string): Promise<object | null> {
	try {
		const content = await fs.readFile(configPath, 'utf-8');
		return JSON.parse(content) as object;
	} catch {
		return null;
	}
}

/**
 * Merge viberag config into existing config.
 */
export function mergeConfig(
	existing: object,
	editor: EditorConfig,
): object {
	const viberagConfig = generateViberagConfig();
	const jsonKey = editor.jsonKey;

	// Get or create the servers object
	const existingServers = (existing as Record<string, unknown>)[jsonKey] ?? {};

	return {
		...existing,
		[jsonKey]: {
			...(existingServers as object),
			viberag: viberagConfig,
		},
	};
}

/**
 * Check if viberag is already configured in a config file.
 */
export function hasViberagConfig(config: object, editor: EditorConfig): boolean {
	const servers = (config as Record<string, unknown>)[editor.jsonKey];
	if (!servers || typeof servers !== 'object') {
		return false;
	}
	return 'viberag' in (servers as object);
}

/**
 * Write MCP config to file, creating directories as needed.
 */
export async function writeMcpConfig(
	editor: EditorConfig,
	projectRoot: string,
): Promise<McpSetupResult> {
	try {
		// Get the config path
		let configPath: string;
		if (editor.id === 'zed') {
			configPath = getZedSettingsPath();
		} else if (editor.id === 'windsurf') {
			configPath = getWindsurfConfigPath();
		} else {
			const path = getConfigPath(editor, projectRoot);
			if (!path) {
				return {
					success: false,
					editor: editor.id,
					method: 'instructions-shown',
					error: 'No config path for this editor',
				};
			}
			configPath = path;
		}

		// Ensure parent directory exists
		const dir = path.dirname(configPath);
		await fs.mkdir(dir, {recursive: true});

		// Check if file exists
		const exists = await configExists(configPath);

		if (exists) {
			// Merge with existing config
			const existing = await readJsonConfig(configPath);
			if (!existing) {
				return {
					success: false,
					editor: editor.id,
					method: 'instructions-shown',
					error: 'Could not parse existing config file',
				};
			}

			// Check if already configured
			if (hasViberagConfig(existing, editor)) {
				return {
					success: true,
					editor: editor.id,
					method: 'file-merged',
					configPath,
					error: 'Already configured',
				};
			}

			const merged = mergeConfig(existing, editor);
			await fs.writeFile(configPath, JSON.stringify(merged, null, 2) + '\n');

			return {
				success: true,
				editor: editor.id,
				method: 'file-merged',
				configPath,
			};
		} else {
			// Create new config
			const config = generateMcpConfig(editor);
			await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

			return {
				success: true,
				editor: editor.id,
				method: 'file-created',
				configPath,
			};
		}
	} catch (error) {
		return {
			success: false,
			editor: editor.id,
			method: 'instructions-shown',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Generate manual setup instructions for an editor.
 */
export function getManualInstructions(
	editor: EditorConfig,
	projectRoot: string,
): string {
	const lines: string[] = [];

	lines.push(`## ${editor.name} MCP Setup`);
	lines.push('');

	if (editor.cliCommand) {
		lines.push('Run this command:');
		lines.push('');
		lines.push(`  ${editor.cliCommand}`);
		lines.push('');
	} else if (editor.configFormat === 'json') {
		const configPath = editor.scope === 'project'
			? editor.configPath
			: getConfigPath(editor, projectRoot) ?? editor.configPath;

		lines.push(`Add to ${configPath}:`);
		lines.push('');

		const config = generateMcpConfig(editor);
		const jsonStr = JSON.stringify(config, null, 2);
		lines.push(jsonStr.split('\n').map(l => '  ' + l).join('\n'));
		lines.push('');
	} else if (editor.configFormat === 'toml') {
		lines.push(`Add to ${editor.configPath}:`);
		lines.push('');
		lines.push(generateTomlConfig().split('\n').map(l => '  ' + l).join('\n'));
		lines.push('');
	} else if (editor.configFormat === 'ui') {
		lines.push('Manual setup required:');
		lines.push('');
		lines.push('1. Open Settings → Tools → AI Assistant → MCP');
		lines.push('2. Click "Add Server"');
		lines.push('3. Set name: viberag');
		lines.push('4. Set command: npx');
		lines.push('5. Set args: viberag-mcp');
		lines.push('');
	}

	lines.push('After setup:');
	lines.push(`  ${editor.restartInstructions}`);
	lines.push('');

	lines.push('Verify:');
	for (const step of editor.verificationSteps) {
		lines.push(`  - ${step}`);
	}
	lines.push('');

	lines.push(`Documentation: ${editor.docsUrl}`);

	return lines.join('\n');
}

/**
 * Get a diff preview of the merge operation.
 */
export async function getMergeDiff(
	editor: EditorConfig,
	projectRoot: string,
): Promise<{before: string; after: string; configPath: string} | null> {
	try {
		let configPath: string;
		if (editor.id === 'zed') {
			configPath = getZedSettingsPath();
		} else if (editor.id === 'windsurf') {
			configPath = getWindsurfConfigPath();
		} else {
			const path = getConfigPath(editor, projectRoot);
			if (!path) return null;
			configPath = path;
		}

		const exists = await configExists(configPath);
		if (!exists) {
			return {
				before: '(file does not exist)',
				after: JSON.stringify(generateMcpConfig(editor), null, 2),
				configPath,
			};
		}

		const existing = await readJsonConfig(configPath);
		if (!existing) return null;

		const merged = mergeConfig(existing, editor);

		return {
			before: JSON.stringify(existing, null, 2),
			after: JSON.stringify(merged, null, 2),
			configPath,
		};
	} catch {
		return null;
	}
}

/**
 * Check if viberag is already configured for an editor.
 */
export async function isAlreadyConfigured(
	editor: EditorConfig,
	projectRoot: string,
): Promise<boolean> {
	try {
		let configPath: string;
		if (editor.id === 'zed') {
			configPath = getZedSettingsPath();
		} else if (editor.id === 'windsurf') {
			configPath = getWindsurfConfigPath();
		} else {
			const path = getConfigPath(editor, projectRoot);
			if (!path) return false;
			configPath = path;
		}

		const exists = await configExists(configPath);
		if (!exists) return false;

		const config = await readJsonConfig(configPath);
		if (!config) return false;

		return hasViberagConfig(config, editor);
	} catch {
		return false;
	}
}
