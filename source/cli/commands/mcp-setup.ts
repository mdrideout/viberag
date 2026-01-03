/**
 * MCP Setup Logic
 *
 * Functions for generating, writing, and merging MCP configurations
 * for various AI coding tools.
 *
 * Note: Zed and VS Code use JSONC (JSON with Comments) for their config files.
 * We strip comments before parsing to handle this.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Strip comments from JSONC content.
 * Handles // single-line and /* multi-line comments.
 * Also removes trailing commas before ] or }.
 *
 * This is needed because Zed and VS Code use JSONC format.
 */
function stripJsonComments(content: string): string {
	let result = '';
	let i = 0;
	let inString = false;
	let stringChar = '';

	while (i < content.length) {
		const char = content[i];
		const nextChar = content[i + 1];

		// Handle string boundaries
		if (!inString && (char === '"' || char === "'")) {
			inString = true;
			stringChar = char;
			result += char;
			i++;
			continue;
		}

		if (inString) {
			// Check for escape sequences
			if (char === '\\' && i + 1 < content.length) {
				result += char + nextChar;
				i += 2;
				continue;
			}
			// Check for string end
			if (char === stringChar) {
				inString = false;
				stringChar = '';
			}
			result += char;
			i++;
			continue;
		}

		// Handle single-line comments
		if (char === '/' && nextChar === '/') {
			// Skip until end of line
			while (i < content.length && content[i] !== '\n') {
				i++;
			}
			continue;
		}

		// Handle multi-line comments
		if (char === '/' && nextChar === '*') {
			i += 2; // Skip /*
			while (i < content.length - 1) {
				if (content[i] === '*' && content[i + 1] === '/') {
					i += 2; // Skip */
					break;
				}
				i++;
			}
			continue;
		}

		result += char;
		i++;
	}

	// Remove trailing commas before ] or }
	result = result.replace(/,(\s*[}\]])/g, '$1');

	return result;
}
import {
	EDITORS,
	type EditorConfig,
	type EditorId,
	getConfigPath,
	isGlobalManualOnly,
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
		args: ['-y', 'viberag-mcp'],
	};
}

/**
 * Generate Zed-specific viberag MCP server configuration.
 * Zed requires: source="custom" for non-extension MCP servers.
 */
export function generateZedViberagConfig(): object {
	return {
		source: 'custom',
		command: 'npx',
		args: ['-y', 'viberag-mcp'],
	};
}

/**
 * Generate OpenCode-specific viberag MCP server configuration.
 * OpenCode requires: type="local", command as array, no args key.
 */
export function generateOpenCodeViberagConfig(): object {
	return {
		type: 'local',
		command: ['npx', '-y', 'viberag-mcp'],
	};
}

/**
 * Generate Roo Code-specific viberag MCP server configuration.
 * Roo Code supports alwaysAllow for auto-approving common operations.
 */
export function generateRooCodeViberagConfig(): object {
	return {
		command: 'npx',
		args: ['-y', 'viberag-mcp'],
		alwaysAllow: [
			'codebase_search',
			'codebase_parallel_search',
			'viberag_status',
		],
	};
}

/**
 * Generate complete MCP config for an editor.
 */
export function generateMcpConfig(editor: EditorConfig): object {
	const viberagConfig =
		editor.id === 'zed'
			? generateZedViberagConfig()
			: editor.id === 'opencode'
				? generateOpenCodeViberagConfig()
				: editor.id === 'roo-code'
					? generateRooCodeViberagConfig()
					: generateViberagConfig();

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
args = ["-y", "viberag-mcp"]
`;
}

/**
 * Read existing TOML config file.
 * Returns the raw content string.
 */
export async function readTomlConfig(
	configPath: string,
): Promise<string | null> {
	try {
		return await fs.readFile(configPath, 'utf-8');
	} catch {
		return null;
	}
}

/**
 * Check if viberag is already configured in a TOML config.
 * Looks for [mcp_servers.viberag] section.
 */
export function hasViberagTomlConfig(content: string): boolean {
	// Match [mcp_servers.viberag] section header
	return /^\s*\[mcp_servers\.viberag\]/m.test(content);
}

/**
 * Merge viberag config into existing TOML content.
 * Appends the viberag section if not present.
 */
export function mergeTomlConfig(existing: string): string {
	if (hasViberagTomlConfig(existing)) {
		return existing;
	}

	// Ensure there's a newline before appending
	const needsNewline = existing.length > 0 && !existing.endsWith('\n');
	const separator = needsNewline ? '\n\n' : existing.length > 0 ? '\n' : '';

	return existing + separator + generateTomlConfig();
}

/**
 * Remove viberag from a TOML config.
 * Returns the modified content, or null if nothing to remove.
 */
export function removeViberagFromTomlConfig(content: string): string | null {
	if (!hasViberagTomlConfig(content)) {
		return null;
	}

	// Split into lines and rebuild without the viberag section
	const lines = content.split('\n');
	const result: string[] = [];
	let inViberagSection = false;

	for (const line of lines) {
		// Check if this line starts a new section
		const isSectionHeader = /^\s*\[/.test(line);

		if (isSectionHeader) {
			// Check if this is the viberag section
			if (/^\s*\[mcp_servers\.viberag\]/.test(line)) {
				inViberagSection = true;
				continue;
			} else {
				// A different section starts
				inViberagSection = false;
			}
		}

		// Skip lines that are part of the viberag section
		if (inViberagSection) {
			continue;
		}

		result.push(line);
	}

	let modified = result.join('\n');

	// Clean up extra blank lines
	modified = modified.replace(/\n{3,}/g, '\n\n');
	modified = modified.replace(/^\n+/, '');

	return modified;
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
 * Handles JSONC (JSON with Comments) format used by Zed and VS Code.
 */
export async function readJsonConfig(
	configPath: string,
): Promise<object | null> {
	try {
		const content = await fs.readFile(configPath, 'utf-8');
		// Strip comments for JSONC support (Zed, VS Code)
		const stripped = stripJsonComments(content);
		return JSON.parse(stripped) as object;
	} catch {
		return null;
	}
}

/**
 * Merge viberag config into existing config.
 */
export function mergeConfig(existing: object, editor: EditorConfig): object {
	const viberagConfig =
		editor.id === 'zed'
			? generateZedViberagConfig()
			: editor.id === 'opencode'
				? generateOpenCodeViberagConfig()
				: editor.id === 'roo-code'
					? generateRooCodeViberagConfig()
					: generateViberagConfig();
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
export function hasViberagConfig(
	config: object,
	editor: EditorConfig,
): boolean {
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
	scope: 'global' | 'project',
	projectRoot: string,
): Promise<McpSetupResult> {
	try {
		// Get the config path using scope
		const configPath = getConfigPath(editor, scope, projectRoot);
		if (!configPath) {
			return {
				success: false,
				editor: editor.id,
				method: 'instructions-shown',
				error: `${editor.name} does not support ${scope} configuration`,
			};
		}

		// Ensure parent directory exists
		const dir = path.dirname(configPath);
		await fs.mkdir(dir, {recursive: true});

		// Check if file exists
		const exists = await configExists(configPath);

		// Handle TOML format (Codex)
		if (editor.configFormat === 'toml') {
			if (exists) {
				const existing = await readTomlConfig(configPath);
				if (existing === null) {
					return {
						success: false,
						editor: editor.id,
						method: 'instructions-shown',
						error: 'Could not read existing config file',
					};
				}

				// Check if already configured
				if (hasViberagTomlConfig(existing)) {
					return {
						success: true,
						editor: editor.id,
						method: 'file-merged',
						configPath,
						error: 'Already configured',
					};
				}

				const merged = mergeTomlConfig(existing);
				await fs.writeFile(configPath, merged);

				return {
					success: true,
					editor: editor.id,
					method: 'file-merged',
					configPath,
				};
			} else {
				// Create new TOML config
				await fs.writeFile(configPath, generateTomlConfig());

				return {
					success: true,
					editor: editor.id,
					method: 'file-created',
					configPath,
				};
			}
		}

		// Handle JSON format (all other editors)
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
	scope: 'global' | 'project',
	projectRoot: string,
): string {
	const lines: string[] = [];

	lines.push(`## ${editor.name} MCP Setup (${scope})`);
	lines.push('');

	// Check for manual-only global (VS Code, Roo Code)
	if (scope === 'global' && isGlobalManualOnly(editor)) {
		if (editor.globalUiInstructions) {
			lines.push(editor.globalUiInstructions);
			lines.push('');
		}
		if (editor.id === 'vscode') {
			lines.push('Add to your User settings.json:');
			lines.push('');
			lines.push('  "mcp": {');
			lines.push('    "servers": {');
			lines.push('      "viberag": {');
			lines.push('        "command": "npx",');
			lines.push('        "args": ["-y", "viberag-mcp"]');
			lines.push('      }');
			lines.push('    }');
			lines.push('  }');
			lines.push('');
		} else if (editor.id === 'roo-code') {
			lines.push('1. Click the MCP icon in Roo Code pane header');
			lines.push('2. Click "Edit Global MCP"');
			lines.push('3. Add inside the "mcpServers": { } object:');
			lines.push('');
			lines.push('  "viberag": {');
			lines.push('    "command": "npx",');
			lines.push('    "args": ["-y", "viberag-mcp"],');
			lines.push('    "alwaysAllow": [');
			lines.push('      "codebase_search",');
			lines.push('      "codebase_parallel_search",');
			lines.push('      "viberag_status"');
			lines.push('    ]');
			lines.push('  }');
			lines.push('');
		}
	} else if (editor.cliCommand) {
		lines.push('Run this command:');
		lines.push('');
		lines.push(`  ${editor.cliCommand}`);
		lines.push('');
	} else if (editor.configFormat === 'json') {
		const configPath = getConfigPath(editor, scope, projectRoot);

		lines.push(
			`Add to ${configPath ?? (scope === 'project' ? editor.projectConfigPath : editor.globalConfigPath)}:`,
		);
		lines.push('');

		const config = generateMcpConfig(editor);
		const jsonStr = JSON.stringify(config, null, 2);
		lines.push(
			jsonStr
				.split('\n')
				.map(l => '  ' + l)
				.join('\n'),
		);
		lines.push('');
	} else if (editor.configFormat === 'toml') {
		lines.push(`Add to ${editor.globalConfigPath}:`);
		lines.push('');
		lines.push(
			generateTomlConfig()
				.split('\n')
				.map(l => '  ' + l)
				.join('\n'),
		);
		lines.push('');
	} else if (editor.configFormat === 'ui') {
		lines.push('Manual setup required:');
		lines.push('');
		lines.push('1. Open Settings → Tools → AI Assistant → MCP');
		lines.push('2. Click "Add Server"');
		lines.push('3. Set name: viberag');
		lines.push('4. Set command: npx');
		lines.push('5. Set args: -y viberag-mcp');
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
	scope: 'global' | 'project',
	projectRoot: string,
): Promise<{before: string; after: string; configPath: string} | null> {
	try {
		const configPath = getConfigPath(editor, scope, projectRoot);
		if (!configPath) return null;

		const exists = await configExists(configPath);

		// Handle TOML format (Codex)
		if (editor.configFormat === 'toml') {
			if (!exists) {
				return {
					before: '(file does not exist)',
					after: generateTomlConfig(),
					configPath,
				};
			}

			const existing = await readTomlConfig(configPath);
			if (!existing) return null;

			const merged = mergeTomlConfig(existing);

			return {
				before: existing,
				after: merged,
				configPath,
			};
		}

		// Handle JSON format
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
 * Check if viberag is already configured for an editor at a specific scope.
 */
export async function isAlreadyConfigured(
	editor: EditorConfig,
	scope: 'global' | 'project',
	projectRoot: string,
): Promise<boolean> {
	try {
		const configPath = getConfigPath(editor, scope, projectRoot);
		if (!configPath) return false;

		const exists = await configExists(configPath);
		if (!exists) return false;

		// Handle TOML format (Codex)
		if (editor.configFormat === 'toml') {
			const content = await readTomlConfig(configPath);
			if (!content) return false;
			return hasViberagTomlConfig(content);
		}

		// Handle JSON format
		const config = await readJsonConfig(configPath);
		if (!config) return false;

		return hasViberagConfig(config, editor);
	} catch {
		return false;
	}
}

/**
 * Check if viberag is configured at any scope for an editor.
 * Returns info about which scopes are configured.
 */
export async function getConfiguredScopes(
	editor: EditorConfig,
	projectRoot: string,
): Promise<{global: boolean; project: boolean}> {
	const globalConfigured = editor.supportsGlobal
		? await isAlreadyConfigured(editor, 'global', projectRoot)
		: false;
	const projectConfigured = editor.supportsProject
		? await isAlreadyConfigured(editor, 'project', projectRoot)
		: false;

	return {global: globalConfigured, project: projectConfigured};
}

/**
 * Remove viberag from an existing config object.
 * Returns the modified config, or null if nothing to remove.
 */
export function removeViberagFromConfig(
	existing: object,
	editor: EditorConfig,
): object | null {
	const jsonKey = editor.jsonKey;
	const servers = (existing as Record<string, unknown>)[jsonKey];

	if (!servers || typeof servers !== 'object') {
		return null;
	}

	if (!('viberag' in (servers as object))) {
		return null;
	}

	// Remove viberag from servers
	const remainingServers = Object.fromEntries(
		Object.entries(servers as Record<string, unknown>).filter(
			([key]) => key !== 'viberag',
		),
	);

	return {
		...existing,
		[jsonKey]: remainingServers,
	};
}

/**
 * Result of an MCP removal operation.
 */
export interface McpRemovalResult {
	success: boolean;
	editor: EditorId;
	configPath?: string;
	fileDeleted?: boolean;
	error?: string;
}

/**
 * Remove viberag from an editor's MCP config.
 * Always keeps the config file, even if it becomes empty (no other servers).
 */
export async function removeViberagConfig(
	editor: EditorConfig,
	scope: 'global' | 'project',
	projectRoot: string,
): Promise<McpRemovalResult> {
	try {
		// Get the config path using scope
		const configPath = getConfigPath(editor, scope, projectRoot);
		if (!configPath) {
			return {
				success: false,
				editor: editor.id,
				error: `${editor.name} does not support ${scope} configuration`,
			};
		}

		// Check if file exists
		const exists = await configExists(configPath);
		if (!exists) {
			return {
				success: false,
				editor: editor.id,
				error: 'Config file does not exist',
			};
		}

		// Handle TOML format (Codex)
		if (editor.configFormat === 'toml') {
			const content = await readTomlConfig(configPath);
			if (!content) {
				return {
					success: false,
					editor: editor.id,
					configPath,
					error: 'Could not read config file',
				};
			}

			if (!hasViberagTomlConfig(content)) {
				return {
					success: false,
					editor: editor.id,
					configPath,
					error: 'Viberag not configured in this file',
				};
			}

			const modified = removeViberagFromTomlConfig(content);
			if (modified === null) {
				return {
					success: false,
					editor: editor.id,
					configPath,
					error: 'Failed to remove viberag from config',
				};
			}

			await fs.writeFile(configPath, modified);

			return {
				success: true,
				editor: editor.id,
				configPath,
			};
		}

		// Handle JSON format
		// Read existing config
		const existing = await readJsonConfig(configPath);
		if (!existing) {
			return {
				success: false,
				editor: editor.id,
				configPath,
				error: 'Could not parse config file',
			};
		}

		// Check if viberag is configured
		if (!hasViberagConfig(existing, editor)) {
			return {
				success: false,
				editor: editor.id,
				configPath,
				error: 'Viberag not configured in this file',
			};
		}

		// Remove viberag
		const modified = removeViberagFromConfig(existing, editor);
		if (!modified) {
			return {
				success: false,
				editor: editor.id,
				configPath,
				error: 'Failed to remove viberag from config',
			};
		}

		// Write modified config back (keep file even if servers is empty)
		await fs.writeFile(configPath, JSON.stringify(modified, null, 2) + '\n');

		return {
			success: true,
			editor: editor.id,
			configPath,
		};
	} catch (error) {
		return {
			success: false,
			editor: editor.id,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Info about a configured editor and its scope.
 */
export interface ConfiguredEditorInfo {
	editor: EditorConfig;
	scope: 'global' | 'project';
}

/**
 * Find all editors that have viberag configured.
 * Returns both project-scope and global-scope configurations.
 */
export async function findConfiguredEditors(projectRoot: string): Promise<{
	projectScope: ConfiguredEditorInfo[];
	globalScope: ConfiguredEditorInfo[];
}> {
	const projectScope: ConfiguredEditorInfo[] = [];
	const globalScope: ConfiguredEditorInfo[] = [];

	for (const editor of EDITORS) {
		// Check global scope
		if (editor.supportsGlobal && editor.globalConfigPath) {
			const isGlobalConfigured = await isAlreadyConfigured(
				editor,
				'global',
				projectRoot,
			);
			if (isGlobalConfigured) {
				globalScope.push({editor, scope: 'global'});
			}
		}

		// Check project scope
		if (editor.supportsProject && editor.projectConfigPath) {
			const isProjectConfigured = await isAlreadyConfigured(
				editor,
				'project',
				projectRoot,
			);
			if (isProjectConfigured) {
				projectScope.push({editor, scope: 'project'});
			}
		}
	}

	return {projectScope, globalScope};
}

/**
 * Add an entry to .gitignore if not already present.
 */
export async function addToGitignore(
	projectRoot: string,
	entry: string,
): Promise<boolean> {
	const gitignorePath = path.join(projectRoot, '.gitignore');

	try {
		let content = '';
		try {
			content = await fs.readFile(gitignorePath, 'utf-8');
		} catch {
			// .gitignore doesn't exist, will create
		}

		// Check if entry already exists (exact line match)
		const lines = content.split('\n');
		if (lines.some(line => line.trim() === entry)) {
			return true; // Already present
		}

		// Add entry with a comment
		const addition =
			content.endsWith('\n') || content === ''
				? `# MCP config (local, not committed)\n${entry}\n`
				: `\n# MCP config (local, not committed)\n${entry}\n`;

		await fs.appendFile(gitignorePath, addition);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get all project-scope config paths that were created.
 * Used for gitignore prompt.
 */
export function getProjectConfigPaths(results: McpSetupResult[]): string[] {
	const paths: string[] = [];

	for (const result of results) {
		if (
			result.success &&
			(result.method === 'file-created' || result.method === 'file-merged') &&
			result.configPath
		) {
			// Check if it's a project-scope path (doesn't start with ~ or /)
			const configPath = result.configPath;
			if (!configPath.startsWith('/') && !configPath.startsWith('~')) {
				// It's a relative path, so project-scope
				paths.push(configPath);
			} else if (
				configPath.includes('.mcp.json') ||
				configPath.includes('.cursor/') ||
				configPath.includes('.vscode/') ||
				configPath.includes('.roo/')
			) {
				// Extract relative path from absolute path
				const projectDir = process.cwd();
				if (configPath.startsWith(projectDir)) {
					paths.push(configPath.slice(projectDir.length + 1));
				}
			}
		}
	}

	return paths;
}
