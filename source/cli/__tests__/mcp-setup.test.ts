/**
 * MCP Setup Integration Tests
 *
 * Tests for config generation, file creation, merging, and edge cases.
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	writeMcpConfig,
	generateMcpConfig,
	generateViberagConfig,
	generateTomlConfig,
	readJsonConfig,
	mergeConfig,
	hasViberagConfig,
	isAlreadyConfigured,
	configExists,
} from '../commands/mcp-setup.js';
import {EDITORS, getEditor} from '../data/mcp-editors.js';

// =============================================================================
// Test Helpers
// =============================================================================

interface TempContext {
	dir: string;
	cleanup: () => Promise<void>;
}

/**
 * Create a temporary directory for test isolation.
 */
async function createTempDir(): Promise<TempContext> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-mcp-test-'));
	return {
		dir,
		cleanup: async () => {
			await fs.rm(dir, {recursive: true, force: true});
		},
	};
}

/**
 * Write a test config file.
 */
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

/**
 * Read a test config file.
 */
async function readTestConfig(
	dir: string,
	relativePath: string,
): Promise<object> {
	const fullPath = path.join(dir, relativePath);
	const content = await fs.readFile(fullPath, 'utf-8');
	return JSON.parse(content) as object;
}

// =============================================================================
// Config Generation Tests
// =============================================================================

describe('MCP Config Generation', () => {
	it('generateViberagConfig returns correct structure', () => {
		const config = generateViberagConfig();

		expect(config).toEqual({
			command: 'npx',
			args: ['viberag-mcp'],
		});
	});

	it('generateMcpConfig uses correct key for Claude Code', () => {
		const editor = getEditor('claude-code')!;
		const config = generateMcpConfig(editor);

		expect(config).toHaveProperty('mcpServers');
		expect(
			(config as {mcpServers: {viberag: unknown}}).mcpServers.viberag,
		).toBeDefined();
	});

	it('generateMcpConfig uses "servers" key for VS Code', () => {
		const editor = getEditor('vscode')!;
		const config = generateMcpConfig(editor);

		expect(config).toHaveProperty('servers');
		expect(config).not.toHaveProperty('mcpServers');
	});

	it('generateMcpConfig uses "context_servers" key for Zed', () => {
		const editor = getEditor('zed')!;
		const config = generateMcpConfig(editor);

		expect(config).toHaveProperty('context_servers');
		expect(config).not.toHaveProperty('mcpServers');
	});

	it('generateTomlConfig returns valid TOML', () => {
		const toml = generateTomlConfig();

		expect(toml).toContain('[mcp_servers.viberag]');
		expect(toml).toContain('command = "npx"');
		expect(toml).toContain('args = ["viberag-mcp"]');
	});
});

// =============================================================================
// Project-Level Config Creation Tests
// =============================================================================

describe('Project-Level Config Creation', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('creates .mcp.json for Claude Code in empty project', async () => {
		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-created');
		expect(result.configPath).toBe(path.join(ctx.dir, '.mcp.json'));

		const config = await readTestConfig(ctx.dir, '.mcp.json');
		expect(
			(config as {mcpServers: {viberag: {command: string}}}).mcpServers.viberag
				.command,
		).toBe('npx');
	});

	it('creates .vscode/mcp.json with parent directory', async () => {
		const editor = getEditor('vscode')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-created');

		// Verify .vscode directory was created
		const vscodeDir = path.join(ctx.dir, '.vscode');
		const stat = await fs.stat(vscodeDir);
		expect(stat.isDirectory()).toBe(true);

		const config = await readTestConfig(ctx.dir, '.vscode/mcp.json');
		expect(
			(config as {servers: {viberag: unknown}}).servers.viberag,
		).toBeDefined();
	});

	it('creates .cursor/mcp.json for Cursor', async () => {
		const editor = getEditor('cursor')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(true);
		expect(result.configPath).toContain('.cursor/mcp.json');

		const config = await readTestConfig(ctx.dir, '.cursor/mcp.json');
		expect(
			(config as {mcpServers: {viberag: unknown}}).mcpServers.viberag,
		).toBeDefined();
	});

	it('creates .roo/mcp.json for Roo Code', async () => {
		const editor = getEditor('roo-code')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(true);
		expect(result.configPath).toContain('.roo/mcp.json');

		const config = await readTestConfig(ctx.dir, '.roo/mcp.json');
		expect(
			(config as {mcpServers: {viberag: unknown}}).mcpServers.viberag,
		).toBeDefined();
	});
});

// =============================================================================
// Config Merging Tests
// =============================================================================

describe('Config Merging', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('merges viberag into existing mcpServers', async () => {
		// Setup: Create existing config with another server
		await writeTestConfig(ctx.dir, '.mcp.json', {
			mcpServers: {
				'other-server': {
					command: 'node',
					args: ['other.js'],
				},
			},
		});

		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-merged');

		const config = (await readTestConfig(ctx.dir, '.mcp.json')) as {
			mcpServers: {
				'other-server': unknown;
				viberag: unknown;
			};
		};

		// Both servers should exist
		expect(config.mcpServers['other-server']).toBeDefined();
		expect(config.mcpServers.viberag).toBeDefined();
	});

	it('preserves existing servers during merge', async () => {
		const existingConfig = {
			mcpServers: {
				github: {command: 'npx', args: ['github-mcp']},
				filesystem: {command: 'npx', args: ['fs-mcp']},
			},
		};
		await writeTestConfig(ctx.dir, '.mcp.json', existingConfig);

		const editor = getEditor('claude-code')!;
		await writeMcpConfig(editor, ctx.dir);

		const config = (await readTestConfig(ctx.dir, '.mcp.json')) as {
			mcpServers: Record<string, unknown>;
		};

		expect(Object.keys(config.mcpServers)).toHaveLength(3);
		expect(config.mcpServers['github']).toBeDefined();
		expect(config.mcpServers['filesystem']).toBeDefined();
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('merges into VS Code config with servers key', async () => {
		await writeTestConfig(ctx.dir, '.vscode/mcp.json', {
			servers: {
				existing: {command: 'existing'},
			},
		});

		const editor = getEditor('vscode')!;
		await writeMcpConfig(editor, ctx.dir);

		const config = (await readTestConfig(ctx.dir, '.vscode/mcp.json')) as {
			servers: Record<string, unknown>;
		};

		expect(config.servers['existing']).toBeDefined();
		expect(config.servers['viberag']).toBeDefined();
	});

	it('mergeConfig function works correctly', () => {
		const existing = {
			mcpServers: {
				other: {command: 'other'},
			},
			someOtherKey: 'value',
		};

		const editor = getEditor('claude-code')!;
		const merged = mergeConfig(existing, editor) as {
			mcpServers: Record<string, unknown>;
			someOtherKey: string;
		};

		expect(merged.mcpServers['other']).toBeDefined();
		expect(merged.mcpServers['viberag']).toBeDefined();
		expect(merged['someOtherKey']).toBe('value');
	});

	it('mergeConfig handles empty servers object', () => {
		const existing = {mcpServers: {}};
		const editor = getEditor('claude-code')!;
		const merged = mergeConfig(existing, editor) as {
			mcpServers: Record<string, unknown>;
		};

		expect(merged.mcpServers['viberag']).toBeDefined();
	});

	it('mergeConfig creates servers object if missing', () => {
		const existing = {otherKey: 'value'};
		const editor = getEditor('claude-code')!;
		const merged = mergeConfig(existing, editor) as {
			mcpServers: Record<string, unknown>;
		};

		expect(merged.mcpServers['viberag']).toBeDefined();
	});
});

// =============================================================================
// Already Configured Detection Tests
// =============================================================================

describe('Already Configured Detection', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('hasViberagConfig returns true when viberag exists', () => {
		const config = {
			mcpServers: {
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};
		const editor = getEditor('claude-code')!;

		expect(hasViberagConfig(config, editor)).toBe(true);
	});

	it('hasViberagConfig returns false when viberag missing', () => {
		const config = {
			mcpServers: {
				other: {command: 'other'},
			},
		};
		const editor = getEditor('claude-code')!;

		expect(hasViberagConfig(config, editor)).toBe(false);
	});

	it('isAlreadyConfigured detects existing viberag config', async () => {
		await writeTestConfig(ctx.dir, '.mcp.json', {
			mcpServers: {
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		});

		const editor = getEditor('claude-code')!;
		const result = await isAlreadyConfigured(editor, ctx.dir);

		expect(result).toBe(true);
	});

	it('isAlreadyConfigured returns false for empty project', async () => {
		const editor = getEditor('claude-code')!;
		const result = await isAlreadyConfigured(editor, ctx.dir);

		expect(result).toBe(false);
	});

	it('writeMcpConfig reports already configured', async () => {
		// Pre-configure viberag
		await writeTestConfig(ctx.dir, '.mcp.json', {
			mcpServers: {
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		});

		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-merged');
		expect(result.error).toBe('Already configured');
	});
});

// =============================================================================
// Edge Cases Tests
// =============================================================================

describe('Edge Cases', () => {
	let ctx: TempContext;

	beforeEach(async () => {
		ctx = await createTempDir();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('handles empty existing config file', async () => {
		await writeTestConfig(ctx.dir, '.mcp.json', {});

		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(true);

		const config = (await readTestConfig(ctx.dir, '.mcp.json')) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('handles malformed JSON gracefully', async () => {
		// Write invalid JSON
		const configPath = path.join(ctx.dir, '.mcp.json');
		await fs.writeFile(configPath, '{ invalid json }', 'utf-8');

		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, ctx.dir);

		expect(result.success).toBe(false);
		expect(result.error).toContain('parse');
	});

	it('readJsonConfig returns null for non-existent file', async () => {
		const result = await readJsonConfig(path.join(ctx.dir, 'nonexistent.json'));
		expect(result).toBeNull();
	});

	it('configExists returns false for non-existent file', async () => {
		const result = await configExists(path.join(ctx.dir, 'nonexistent.json'));
		expect(result).toBe(false);
	});

	it('configExists returns true for existing file', async () => {
		await writeTestConfig(ctx.dir, 'test.json', {});
		const result = await configExists(path.join(ctx.dir, 'test.json'));
		expect(result).toBe(true);
	});
});

// =============================================================================
// Editor Configuration Data Tests
// =============================================================================

describe('Editor Configuration Data', () => {
	it('all project-scope editors have canAutoCreate true', () => {
		const projectEditors = EDITORS.filter(e => e.scope === 'project');

		for (const editor of projectEditors) {
			expect(editor.canAutoCreate).toBe(true);
		}
	});

	it('all editors have valid docsUrl', () => {
		for (const editor of EDITORS) {
			expect(editor.docsUrl).toMatch(/^https?:\/\//);
		}
	});

	it('getEditor returns correct editor by id', () => {
		const claude = getEditor('claude-code');
		expect(claude?.name).toBe('Claude Code');

		const vscode = getEditor('vscode');
		expect(vscode?.name).toBe('VS Code Copilot');

		const nonexistent = getEditor('nonexistent' as never);
		expect(nonexistent).toBeUndefined();
	});

	it('each editor has unique id', () => {
		const ids = EDITORS.map(e => e.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});
});
