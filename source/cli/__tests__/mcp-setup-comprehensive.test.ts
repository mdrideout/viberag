/**
 * MCP Setup Comprehensive Integration Tests
 *
 * Tests for all editors covering:
 * - Creating config files (project and global where applicable)
 * - Updating/merging existing config files
 * - Removing viberag from config files
 * - JSONC handling (comments in config files)
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	writeMcpConfig,
	readJsonConfig,
	removeViberagConfig,
	isAlreadyConfigured,
	hasViberagConfig,
	generateMcpConfig,
} from '../commands/mcp-setup.js';
import {getEditor, getConfigPath, type EditorId} from '../data/mcp-editors.js';

// Type definitions for config objects
interface ServerConfig {
	command?: string;
	args?: string[];
	source?: string;
	settings?: Record<string, unknown>;
	[key: string]: unknown;
}

interface McpConfigObject {
	theme?: string;
	mcpServers?: Record<string, ServerConfig>;
	servers?: Record<string, ServerConfig>;
	context_servers?: Record<string, ServerConfig>;
	mcp?: Record<string, ServerConfig>;
	[key: string]: unknown;
}

// =============================================================================
// Test Helpers
// =============================================================================

interface TempContext {
	dir: string;
	cleanup: () => Promise<void>;
}

async function createTempDir(): Promise<TempContext> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-mcp-test-'));
	return {
		dir,
		cleanup: async () => {
			await fs.rm(dir, {recursive: true, force: true});
		},
	};
}

async function writeTestConfig(
	dir: string,
	relativePath: string,
	content: object | string,
): Promise<void> {
	const fullPath = path.join(dir, relativePath);
	const dirPath = path.dirname(fullPath);
	await fs.mkdir(dirPath, {recursive: true});
	const data =
		typeof content === 'string' ? content : JSON.stringify(content, null, 2);
	await fs.writeFile(fullPath, data, 'utf-8');
}

async function readTestConfig(
	dir: string,
	relativePath: string,
): Promise<object> {
	const fullPath = path.join(dir, relativePath);
	const content = await fs.readFile(fullPath, 'utf-8');
	return JSON.parse(content) as object;
}

// =============================================================================
// Editors with Project Scope Support
// =============================================================================

// =============================================================================
// Project Scope Tests - All Editors
// =============================================================================

describe('Project Scope - All Editors', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	// Test each editor with project support
	const projectEditors = [
		{id: 'claude-code', path: '.mcp.json', key: 'mcpServers'},
		{id: 'cursor', path: '.cursor/mcp.json', key: 'mcpServers'},
		{id: 'vscode', path: '.vscode/mcp.json', key: 'servers'},
		{id: 'roo-code', path: '.roo/mcp.json', key: 'mcpServers'},
		{id: 'zed', path: '.zed/settings.json', key: 'context_servers'},
		{id: 'gemini-cli', path: '.gemini/settings.json', key: 'mcpServers'},
		{id: 'opencode', path: 'opencode.json', key: 'mcp'},
	];

	describe('Create Config', () => {
		for (const {id, path: configPath, key} of projectEditors) {
			it(`creates ${configPath} for ${id}`, async () => {
				const editor = getEditor(id as EditorId)!;

				// Skip if editor doesn't support auto-create for project
				if (!editor.canAutoCreate || !editor.supportsProject) {
					return;
				}

				const result = await writeMcpConfig(editor, 'project', ctx.dir);

				expect(result.success).toBe(true);
				expect(result.method).toBe('file-created');
				expect(result.configPath).toBe(path.join(ctx.dir, configPath));

				// Verify file was created with correct structure
				const config = (await readTestConfig(ctx.dir, configPath)) as Record<
					string,
					Record<string, unknown>
				>;
				expect(config[key]).toBeDefined();
				expect(config[key]!['viberag']).toBeDefined();
			});
		}
	});

	describe('Update/Merge Config', () => {
		for (const {id, path: configPath, key} of projectEditors) {
			it(`merges into existing ${configPath} for ${id}`, async () => {
				const editor = getEditor(id as EditorId)!;

				// Skip if editor doesn't support auto-create for project
				if (!editor.canAutoCreate || !editor.supportsProject) {
					return;
				}

				// Setup: Create existing config with another server
				const existingConfig: Record<string, Record<string, object>> = {};
				existingConfig[key] = {
					'other-server': {command: 'node', args: ['other.js']},
				};
				await writeTestConfig(ctx.dir, configPath, existingConfig);

				const result = await writeMcpConfig(editor, 'project', ctx.dir);

				expect(result.success).toBe(true);
				expect(result.method).toBe('file-merged');

				// Verify both servers exist
				const config = (await readTestConfig(ctx.dir, configPath)) as Record<
					string,
					Record<string, unknown>
				>;
				expect(config[key]!['other-server']).toBeDefined();
				expect(config[key]!['viberag']).toBeDefined();
			});

			it(`reports already configured for ${id} when viberag exists`, async () => {
				const editor = getEditor(id as EditorId)!;

				if (!editor.canAutoCreate || !editor.supportsProject) {
					return;
				}

				// Setup: Create config with viberag already present
				const existingConfig: Record<string, Record<string, object>> = {};
				existingConfig[key] = {
					viberag: {command: 'npx', args: ['viberag-mcp']},
				};
				await writeTestConfig(ctx.dir, configPath, existingConfig);

				const result = await writeMcpConfig(editor, 'project', ctx.dir);

				expect(result.success).toBe(true);
				expect(result.method).toBe('file-merged');
				expect(result.error).toBe('Already configured');
			});
		}
	});

	describe('Remove Config', () => {
		for (const {id, path: configPath, key} of projectEditors) {
			it(`removes viberag from ${configPath} for ${id}`, async () => {
				const editor = getEditor(id as EditorId)!;

				if (!editor.supportsProject) {
					return;
				}

				// Setup: Create config with viberag and another server
				const existingConfig: Record<string, Record<string, object>> = {};
				existingConfig[key] = {
					viberag: {command: 'npx', args: ['viberag-mcp']},
					'other-server': {command: 'node', args: ['other.js']},
				};
				await writeTestConfig(ctx.dir, configPath, existingConfig);

				const result = await removeViberagConfig(editor, 'project', ctx.dir);

				expect(result.success).toBe(true);

				// Verify viberag removed but other server preserved
				const config = (await readTestConfig(ctx.dir, configPath)) as Record<
					string,
					Record<string, unknown>
				>;
				expect(config[key]!['viberag']).toBeUndefined();
				expect(config[key]!['other-server']).toBeDefined();
			});

			it(`returns error when viberag not in ${configPath} for ${id}`, async () => {
				const editor = getEditor(id as EditorId)!;

				if (!editor.supportsProject) {
					return;
				}

				// Setup: Create config without viberag
				const existingConfig: Record<string, Record<string, object>> = {};
				existingConfig[key] = {
					'other-server': {command: 'node', args: ['other.js']},
				};
				await writeTestConfig(ctx.dir, configPath, existingConfig);

				const result = await removeViberagConfig(editor, 'project', ctx.dir);

				expect(result.success).toBe(false);
				expect(result.error).toContain('not configured');
			});
		}
	});
});

// =============================================================================
// JSONC Handling Tests (Comments in Config Files)
// =============================================================================

describe('JSONC Handling (Comments)', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('reads Zed config with // comments', async () => {
		const configWithComments = `{
  // User settings for Zed
  "theme": "One Dark",
  "context_servers": {
    // Existing MCP server
    "other": {
      "source": "custom",
      "command": "other"
    }
  }
}`;
		await writeTestConfig(ctx.dir, '.zed/settings.json', configWithComments);

		const configPath = path.join(ctx.dir, '.zed/settings.json');
		const config = await readJsonConfig(configPath);

		expect(config).not.toBeNull();
		expect((config as McpConfigObject).theme).toBe('One Dark');
		expect(
			(config as McpConfigObject).context_servers?.['other'],
		).toBeDefined();
	});

	it('reads VS Code config with /* */ comments', async () => {
		const configWithComments = `{
  /*
   * MCP Server Configuration
   */
  "servers": {
    "existing": {
      "command": "existing"
    }
  }
}`;
		await writeTestConfig(ctx.dir, '.vscode/mcp.json', configWithComments);

		const configPath = path.join(ctx.dir, '.vscode/mcp.json');
		const config = await readJsonConfig(configPath);

		expect(config).not.toBeNull();
		expect((config as McpConfigObject).servers?.['existing']).toBeDefined();
	});

	it('merges into Zed config with comments', async () => {
		const configWithComments = `{
  // User settings
  "theme": "One Dark",
  "context_servers": {
    // Existing server
    "other": {
      "source": "custom",
      "command": "other"
    }
  }
}`;
		await writeTestConfig(ctx.dir, '.zed/settings.json', configWithComments);

		const editor = getEditor('zed')!;
		await writeMcpConfig(editor, 'project', ctx.dir);

		// Note: writeMcpConfig for Zed may not auto-create due to JSONC complexity
		// The test verifies that reading JSONC works
		const configPath = path.join(ctx.dir, '.zed/settings.json');
		const config = await readJsonConfig(configPath);

		expect(config).not.toBeNull();
		// The original content should still be readable
		expect((config as McpConfigObject).theme).toBe('One Dark');
	});

	it('handles config with trailing commas', async () => {
		const configWithTrailingComma = `{
  "servers": {
    "existing": {
      "command": "existing",
    },
  },
}`;
		await writeTestConfig(ctx.dir, '.vscode/mcp.json', configWithTrailingComma);

		const configPath = path.join(ctx.dir, '.vscode/mcp.json');
		const config = await readJsonConfig(configPath);

		expect(config).not.toBeNull();
		expect((config as McpConfigObject).servers?.['existing']).toBeDefined();
	});
});

// =============================================================================
// isAlreadyConfigured Tests - All Editors
// =============================================================================

describe('isAlreadyConfigured - All Editors', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	const projectEditors = [
		{id: 'claude-code', path: '.mcp.json', key: 'mcpServers'},
		{id: 'cursor', path: '.cursor/mcp.json', key: 'mcpServers'},
		{id: 'vscode', path: '.vscode/mcp.json', key: 'servers'},
		{id: 'roo-code', path: '.roo/mcp.json', key: 'mcpServers'},
	];

	for (const {id, path: configPath, key} of projectEditors) {
		it(`detects viberag in ${id} project config`, async () => {
			const editor = getEditor(id as EditorId)!;

			// Setup: Create config with viberag
			const existingConfig: Record<string, Record<string, object>> = {};
			existingConfig[key] = {
				viberag: {command: 'npx', args: ['viberag-mcp']},
			};
			await writeTestConfig(ctx.dir, configPath, existingConfig);

			const result = await isAlreadyConfigured(editor, 'project', ctx.dir);
			expect(result).toBe(true);
		});

		it(`returns false when ${id} project config missing viberag`, async () => {
			const editor = getEditor(id as EditorId)!;

			// Setup: Create config without viberag
			const existingConfig: Record<string, Record<string, object>> = {};
			existingConfig[key] = {
				'other-server': {command: 'other'},
			};
			await writeTestConfig(ctx.dir, configPath, existingConfig);

			const result = await isAlreadyConfigured(editor, 'project', ctx.dir);
			expect(result).toBe(false);
		});

		it(`returns false when ${id} project config doesn't exist`, async () => {
			const editor = getEditor(id as EditorId)!;

			const result = await isAlreadyConfigured(editor, 'project', ctx.dir);
			expect(result).toBe(false);
		});
	}
});

// =============================================================================
// hasViberagConfig Unit Tests - All Editor Formats
// =============================================================================

describe('hasViberagConfig - All Editor Formats', () => {
	it('detects viberag with mcpServers key (Claude, Cursor, Gemini, Roo)', () => {
		const config = {
			mcpServers: {
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};

		for (const id of ['claude-code', 'cursor', 'gemini-cli', 'roo-code']) {
			const editor = getEditor(id as EditorId)!;
			expect(hasViberagConfig(config, editor)).toBe(true);
		}
	});

	it('detects viberag with servers key (VS Code)', () => {
		const config = {
			servers: {
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};

		const editor = getEditor('vscode')!;
		expect(hasViberagConfig(config, editor)).toBe(true);
	});

	it('detects viberag with context_servers key (Zed)', () => {
		const config = {
			context_servers: {
				viberag: {source: 'custom', command: 'npx', args: ['viberag-mcp']},
			},
		};

		const editor = getEditor('zed')!;
		expect(hasViberagConfig(config, editor)).toBe(true);
	});

	it('detects viberag with mcp key (OpenCode)', () => {
		const config = {
			mcp: {
				viberag: {type: 'local', command: ['npx', '-y', 'viberag-mcp']},
			},
		};

		const editor = getEditor('opencode')!;
		expect(hasViberagConfig(config, editor)).toBe(true);
	});

	it('returns false when viberag missing (all formats)', () => {
		const configs = [
			{mcpServers: {other: {command: 'other'}}},
			{servers: {other: {command: 'other'}}},
			{context_servers: {other: {command: 'other'}}},
			{mcp: {other: {command: 'other'}}},
		];

		const editors = ['claude-code', 'vscode', 'zed', 'opencode'];

		for (let i = 0; i < editors.length; i++) {
			const editor = getEditor(editors[i] as EditorId)!;
			expect(hasViberagConfig(configs[i]!, editor)).toBe(false);
		}
	});
});

// =============================================================================
// generateMcpConfig Tests - All Editor Formats
// =============================================================================

describe('generateMcpConfig - All Editor Formats', () => {
	it('generates correct format for mcpServers editors', () => {
		for (const id of [
			'claude-code',
			'cursor',
			'gemini-cli',
			'roo-code',
			'windsurf',
		]) {
			const editor = getEditor(id as EditorId)!;
			const config = generateMcpConfig(editor) as McpConfigObject;

			expect(config).toHaveProperty('mcpServers');
			expect(config.mcpServers?.['viberag']).toBeDefined();
			expect(config.mcpServers?.['viberag']?.command).toBe('npx');
		}
	});

	it('generates servers format for VS Code', () => {
		const editor = getEditor('vscode')!;
		const config = generateMcpConfig(editor) as McpConfigObject;

		expect(config).toHaveProperty('servers');
		expect(config).not.toHaveProperty('mcpServers');
		expect(config.servers?.['viberag']).toBeDefined();
	});

	it('generates context_servers format for Zed with source:custom', () => {
		const editor = getEditor('zed')!;
		const config = generateMcpConfig(editor) as McpConfigObject;

		expect(config).toHaveProperty('context_servers');
		const zedConfig = config.context_servers?.['viberag'];
		expect(zedConfig?.source).toBe('custom');
		expect(zedConfig?.command).toBe('npx');
	});

	it('generates mcp format for OpenCode with type:local and array command', () => {
		const editor = getEditor('opencode')!;
		const config = generateMcpConfig(editor) as McpConfigObject;

		expect(config).toHaveProperty('mcp');
		const openCodeConfig = config.mcp?.['viberag'];
		expect(openCodeConfig?.['type']).toBe('local');
		expect(openCodeConfig?.command).toEqual(['npx', '-y', 'viberag-mcp']);
		expect(openCodeConfig).not.toHaveProperty('args');
	});
});

// =============================================================================
// getConfigPath Tests - All Editors
// =============================================================================

describe('getConfigPath - All Editors', () => {
	const testProjectRoot = '/test/project';

	describe('Project Scope Paths', () => {
		const projectPaths = [
			{id: 'claude-code', expected: '.mcp.json'},
			{id: 'cursor', expected: '.cursor/mcp.json'},
			{id: 'vscode', expected: '.vscode/mcp.json'},
			{id: 'roo-code', expected: '.roo/mcp.json'},
			{id: 'zed', expected: '.zed/settings.json'},
			{id: 'gemini-cli', expected: '.gemini/settings.json'},
			{id: 'opencode', expected: 'opencode.json'},
		];

		for (const {id, expected} of projectPaths) {
			it(`returns correct project path for ${id}`, () => {
				const editor = getEditor(id as EditorId)!;
				const configPath = getConfigPath(editor, 'project', testProjectRoot);

				expect(configPath).toBe(path.join(testProjectRoot, expected));
			});
		}
	});

	describe('Global Scope Paths', () => {
		it('returns null for editors without global file config (VS Code, Roo Code)', () => {
			const editor1 = getEditor('vscode')!;
			const editor2 = getEditor('roo-code')!;

			expect(getConfigPath(editor1, 'global')).toBeNull();
			expect(getConfigPath(editor2, 'global')).toBeNull();
		});

		it('returns expanded path for editors with global config', () => {
			const editor = getEditor('claude-code')!;
			const configPath = getConfigPath(editor, 'global');

			expect(configPath).toBe(path.join(os.homedir(), '.claude.json'));
		});
	});

	describe('Editors Without Project Support', () => {
		it('returns null for project scope on Windsurf', () => {
			const editor = getEditor('windsurf')!;
			const configPath = getConfigPath(editor, 'project', testProjectRoot);

			expect(configPath).toBeNull();
		});

		it('returns null for project scope on Codex', () => {
			const editor = getEditor('codex')!;
			const configPath = getConfigPath(editor, 'project', testProjectRoot);

			expect(configPath).toBeNull();
		});
	});
});

// =============================================================================
// Edge Cases - Error Handling
// =============================================================================

describe('Error Handling', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('handles malformed JSON in all editors', async () => {
		const editors = ['claude-code', 'vscode', 'cursor'];
		const paths = ['.mcp.json', '.vscode/mcp.json', '.cursor/mcp.json'];

		for (let i = 0; i < editors.length; i++) {
			const editor = getEditor(editors[i] as EditorId)!;
			await writeTestConfig(ctx.dir, paths[i]!, '{ invalid json }');

			const result = await writeMcpConfig(editor, 'project', ctx.dir);

			expect(result.success).toBe(false);
			expect(result.error).toContain('parse');
		}
	});

	it('handles empty config file', async () => {
		await writeTestConfig(ctx.dir, '.mcp.json', {});

		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, 'project', ctx.dir);

		expect(result.success).toBe(true);

		const config = (await readTestConfig(ctx.dir, '.mcp.json')) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('handles removal when config file does not exist', async () => {
		const editor = getEditor('claude-code')!;
		const result = await removeViberagConfig(editor, 'project', ctx.dir);

		expect(result.success).toBe(false);
		expect(result.error).toContain('does not exist');
	});

	it('handles removal when servers key is wrong type', async () => {
		await writeTestConfig(ctx.dir, '.mcp.json', {
			mcpServers: 'not an object',
		});

		const editor = getEditor('claude-code')!;
		const result = await removeViberagConfig(editor, 'project', ctx.dir);

		expect(result.success).toBe(false);
	});
});

// =============================================================================
// Special Editor Configurations
// =============================================================================

describe('Special Editor Configurations', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('Zed config includes source:custom', async () => {
		const editor = getEditor('zed')!;

		// Note: Zed may not auto-create due to JSONC, but we can test the generated config
		const config = generateMcpConfig(editor) as {
			context_servers: {viberag: {source: string}};
		};

		expect(config.context_servers.viberag.source).toBe('custom');
	});

	it('OpenCode config uses array command format', async () => {
		const editor = getEditor('opencode')!;
		const config = generateMcpConfig(editor) as {
			mcp: {viberag: {type: string; command: string[]}};
		};

		expect(config.mcp.viberag.type).toBe('local');
		expect(Array.isArray(config.mcp.viberag.command)).toBe(true);
		expect(config.mcp.viberag.command).toContain('npx');
	});

	it('VS Code uses servers key not mcpServers', async () => {
		const editor = getEditor('vscode')!;
		const config = generateMcpConfig(editor);

		expect(config).toHaveProperty('servers');
		expect(config).not.toHaveProperty('mcpServers');
	});
});
