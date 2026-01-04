/**
 * MCP Setup Global Scope Integration Tests
 *
 * Tests global config operations by mocking os.homedir() to use a temp directory.
 * Includes realistic default config files that users might have.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	writeMcpConfig,
	readJsonConfig,
	removeViberagConfig,
	isAlreadyConfigured,
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
	buffer_font_size?: number;
	mcpServers?: Record<string, ServerConfig>;
	servers?: Record<string, ServerConfig>;
	context_servers?: Record<string, ServerConfig>;
	mcp?: Record<string, ServerConfig>;
	[key: string]: unknown;
}

// =============================================================================
// Test Helpers
// =============================================================================

interface TempHomeContext {
	originalHome: string;
	tempHome: string;
	cleanup: () => Promise<void>;
}

/**
 * Create a temporary home directory and mock os.homedir().
 */
async function createMockHome(): Promise<TempHomeContext> {
	const originalHome = os.homedir();
	const tempHome = await fs.mkdtemp(
		path.join(os.tmpdir(), 'viberag-home-test-'),
	);

	// Mock os.homedir to return our temp directory
	vi.spyOn(os, 'homedir').mockReturnValue(tempHome);

	return {
		originalHome,
		tempHome,
		cleanup: async () => {
			vi.restoreAllMocks();
			await fs.rm(tempHome, {recursive: true, force: true});
		},
	};
}

async function writeGlobalConfig(
	home: string,
	relativePath: string,
	content: object | string,
): Promise<void> {
	const fullPath = path.join(home, relativePath);
	const dirPath = path.dirname(fullPath);
	await fs.mkdir(dirPath, {recursive: true});
	const data =
		typeof content === 'string' ? content : JSON.stringify(content, null, 2);
	await fs.writeFile(fullPath, data, 'utf-8');
}

async function readGlobalConfig(
	home: string,
	relativePath: string,
): Promise<object> {
	const fullPath = path.join(home, relativePath);
	const content = await fs.readFile(fullPath, 'utf-8');
	return JSON.parse(content) as object;
}

// =============================================================================
// Realistic Default Config Mocks
// =============================================================================

/**
 * Claude Code default ~/.claude.json
 * Users typically have project preferences and possibly other MCP servers.
 */
const CLAUDE_DEFAULT_CONFIG = {
	// User might have theme preferences
	numStartupConversations: 3,
	// Existing MCP servers the user configured
	mcpServers: {
		filesystem: {
			command: 'npx',
			args: ['-y', '@anthropic/mcp-filesystem'],
		},
		github: {
			command: 'npx',
			args: ['-y', '@anthropic/mcp-github'],
		},
	},
};

/**
 * Cursor default ~/.cursor/mcp.json
 * Similar to Claude Code structure.
 */
const CURSOR_DEFAULT_CONFIG = {
	mcpServers: {
		'brave-search': {
			command: 'npx',
			args: ['-y', '@anthropic/mcp-brave-search'],
			env: {
				BRAVE_API_KEY: '${BRAVE_API_KEY}',
			},
		},
	},
};

/**
 * Windsurf default ~/.codeium/windsurf/mcp_config.json
 * Users might have cascade plugins configured.
 */
const WINDSURF_DEFAULT_CONFIG = {
	mcpServers: {
		memory: {
			command: 'npx',
			args: ['-y', '@anthropic/mcp-memory'],
		},
	},
};

/**
 * Zed default ~/.config/zed/settings.json
 * Zed has many other settings beyond MCP - theme, keybindings, etc.
 * Uses JSONC format with comments.
 */
const ZED_DEFAULT_CONFIG = `{
  // Zed user settings
  "theme": "One Dark",
  "buffer_font_family": "JetBrains Mono",
  "buffer_font_size": 14,
  "telemetry": {
    "diagnostics": false,
    "metrics": false
  },
  // AI Assistant settings
  "assistant": {
    "default_model": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514"
    }
  },
  // MCP context servers
  "context_servers": {
    "postgres": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-postgres"]
    }
  }
}`;

/**
 * Gemini CLI default ~/.gemini/settings.json
 * User preferences and MCP servers.
 */
const GEMINI_DEFAULT_CONFIG = {
	theme: 'dark',
	model: 'gemini-2.0-flash',
	mcpServers: {
		sqlite: {
			command: 'npx',
			args: ['-y', '@anthropic/mcp-sqlite'],
		},
	},
};

/**
 * OpenCode default ~/.config/opencode/opencode.json
 * Uses $schema and mcp key with different structure.
 */
const OPENCODE_DEFAULT_CONFIG = {
	$schema: 'https://opencode.ai/config.json',
	provider: 'anthropic',
	model: 'claude-sonnet-4-20250514',
	mcp: {
		puppeteer: {
			type: 'local',
			command: ['npx', '-y', '@anthropic/mcp-puppeteer'],
			enabled: true,
		},
	},
};

// =============================================================================
// Claude Code Global Tests
// =============================================================================

describe('Claude Code Global Config', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('creates ~/.claude.json when it does not exist', async () => {
		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-created');
		expect(result.configPath).toBe(path.join(ctx.tempHome, '.claude.json'));

		const config = (await readGlobalConfig(ctx.tempHome, '.claude.json')) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('merges into existing ~/.claude.json preserving other servers', async () => {
		// Setup: Write realistic default config
		await writeGlobalConfig(
			ctx.tempHome,
			'.claude.json',
			CLAUDE_DEFAULT_CONFIG,
		);

		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-merged');

		const config = (await readGlobalConfig(ctx.tempHome, '.claude.json')) as {
			mcpServers: Record<string, unknown>;
			numStartupConversations: number;
		};

		// Verify existing settings preserved
		expect(config.numStartupConversations).toBe(3);
		expect(config.mcpServers['filesystem']).toBeDefined();
		expect(config.mcpServers['github']).toBeDefined();
		// Verify viberag added
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('removes viberag from ~/.claude.json preserving other servers', async () => {
		// Setup: Config with viberag and other servers
		const configWithViberag = {
			...CLAUDE_DEFAULT_CONFIG,
			mcpServers: {
				...CLAUDE_DEFAULT_CONFIG.mcpServers,
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};
		await writeGlobalConfig(ctx.tempHome, '.claude.json', configWithViberag);

		const editor = getEditor('claude-code')!;
		const result = await removeViberagConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(ctx.tempHome, '.claude.json')) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeUndefined();
		expect(config.mcpServers['filesystem']).toBeDefined();
		expect(config.mcpServers['github']).toBeDefined();
	});

	it('detects already configured in ~/.claude.json', async () => {
		const configWithViberag = {
			mcpServers: {
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};
		await writeGlobalConfig(ctx.tempHome, '.claude.json', configWithViberag);

		const editor = getEditor('claude-code')!;
		const result = await isAlreadyConfigured(editor, 'global', '/unused');

		expect(result).toBe(true);
	});
});

// =============================================================================
// Cursor Global Tests
// =============================================================================

describe('Cursor Global Config', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('creates ~/.cursor/mcp.json when it does not exist', async () => {
		const editor = getEditor('cursor')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-created');

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.cursor/mcp.json',
		)) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('merges into existing ~/.cursor/mcp.json', async () => {
		await writeGlobalConfig(
			ctx.tempHome,
			'.cursor/mcp.json',
			CURSOR_DEFAULT_CONFIG,
		);

		const editor = getEditor('cursor')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-merged');

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.cursor/mcp.json',
		)) as {
			mcpServers: Record<string, {command: string; env?: object}>;
		};

		// Verify existing server preserved with env vars
		expect(config.mcpServers['brave-search']).toBeDefined();
		expect(config.mcpServers['brave-search']!.env).toBeDefined();
		// Verify viberag added
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('removes viberag from ~/.cursor/mcp.json', async () => {
		const configWithViberag = {
			mcpServers: {
				...CURSOR_DEFAULT_CONFIG.mcpServers,
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};
		await writeGlobalConfig(
			ctx.tempHome,
			'.cursor/mcp.json',
			configWithViberag,
		);

		const editor = getEditor('cursor')!;
		const result = await removeViberagConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.cursor/mcp.json',
		)) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeUndefined();
		expect(config.mcpServers['brave-search']).toBeDefined();
	});
});

// =============================================================================
// Windsurf Global Tests
// =============================================================================

describe('Windsurf Global Config', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('creates ~/.codeium/windsurf/mcp_config.json when it does not exist', async () => {
		const editor = getEditor('windsurf')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-created');

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.codeium/windsurf/mcp_config.json',
		)) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('merges into existing Windsurf config', async () => {
		await writeGlobalConfig(
			ctx.tempHome,
			'.codeium/windsurf/mcp_config.json',
			WINDSURF_DEFAULT_CONFIG,
		);

		const editor = getEditor('windsurf')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.codeium/windsurf/mcp_config.json',
		)) as {
			mcpServers: Record<string, unknown>;
		};

		expect(config.mcpServers['memory']).toBeDefined();
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('removes viberag from Windsurf config', async () => {
		const configWithViberag = {
			mcpServers: {
				...WINDSURF_DEFAULT_CONFIG.mcpServers,
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};
		await writeGlobalConfig(
			ctx.tempHome,
			'.codeium/windsurf/mcp_config.json',
			configWithViberag,
		);

		const editor = getEditor('windsurf')!;
		const result = await removeViberagConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.codeium/windsurf/mcp_config.json',
		)) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeUndefined();
		expect(config.mcpServers['memory']).toBeDefined();
	});
});

// =============================================================================
// Zed Global Tests (JSONC with comments)
// =============================================================================

describe('Zed Global Config (JSONC)', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('reads existing Zed config with comments', async () => {
		await writeGlobalConfig(
			ctx.tempHome,
			'.config/zed/settings.json',
			ZED_DEFAULT_CONFIG,
		);

		const configPath = path.join(ctx.tempHome, '.config/zed/settings.json');
		const config = await readJsonConfig(configPath);

		expect(config).not.toBeNull();
		expect((config as McpConfigObject).theme).toBe('One Dark');
		expect((config as McpConfigObject).buffer_font_size).toBe(14);
		expect(
			(config as McpConfigObject).context_servers?.['postgres'],
		).toBeDefined();
	});

	it('detects existing viberag in Zed config with comments', async () => {
		const zedConfigWithViberag = `{
  // Zed settings
  "theme": "One Dark",
  "context_servers": {
    "viberag": {
      "source": "custom",
      "command": "npx",
      "args": ["viberag-mcp"]
    }
  }
}`;
		await writeGlobalConfig(
			ctx.tempHome,
			'.config/zed/settings.json',
			zedConfigWithViberag,
		);

		const editor = getEditor('zed')!;
		const result = await isAlreadyConfigured(editor, 'global', '/unused');

		expect(result).toBe(true);
	});

	it('creates Zed config with source:custom when not exists', async () => {
		const editor = getEditor('zed')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.config/zed/settings.json',
		)) as {
			context_servers: Record<string, {source: string}>;
		};

		expect(config.context_servers['viberag']).toBeDefined();
		expect(config.context_servers['viberag']!.source).toBe('custom');
	});
});

// =============================================================================
// Gemini CLI Global Tests
// =============================================================================

describe('Gemini CLI Global Config', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('creates ~/.gemini/settings.json when it does not exist', async () => {
		const editor = getEditor('gemini-cli')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-created');

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.gemini/settings.json',
		)) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('merges into existing Gemini CLI config preserving settings', async () => {
		await writeGlobalConfig(
			ctx.tempHome,
			'.gemini/settings.json',
			GEMINI_DEFAULT_CONFIG,
		);

		const editor = getEditor('gemini-cli')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.gemini/settings.json',
		)) as {
			theme: string;
			model: string;
			mcpServers: Record<string, unknown>;
		};

		// Verify user settings preserved
		expect(config.theme).toBe('dark');
		expect(config.model).toBe('gemini-2.0-flash');
		// Verify existing server preserved
		expect(config.mcpServers['sqlite']).toBeDefined();
		// Verify viberag added
		expect(config.mcpServers['viberag']).toBeDefined();
	});

	it('removes viberag from Gemini CLI config', async () => {
		const configWithViberag = {
			...GEMINI_DEFAULT_CONFIG,
			mcpServers: {
				...GEMINI_DEFAULT_CONFIG.mcpServers,
				viberag: {command: 'npx', args: ['viberag-mcp']},
			},
		};
		await writeGlobalConfig(
			ctx.tempHome,
			'.gemini/settings.json',
			configWithViberag,
		);

		const editor = getEditor('gemini-cli')!;
		const result = await removeViberagConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.gemini/settings.json',
		)) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers['viberag']).toBeUndefined();
		expect(config.mcpServers['sqlite']).toBeDefined();
	});
});

// =============================================================================
// OpenCode Global Tests
// =============================================================================

describe('OpenCode Global Config', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('creates ~/.config/opencode/opencode.json when it does not exist', async () => {
		const editor = getEditor('opencode')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);
		expect(result.method).toBe('file-created');

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.config/opencode/opencode.json',
		)) as {
			mcp: Record<string, {type: string; command: string[]}>;
		};

		expect(config.mcp['viberag']).toBeDefined();
		expect(config.mcp['viberag']!.type).toBe('local');
		expect(Array.isArray(config.mcp['viberag']!.command)).toBe(true);
	});

	it('merges into existing OpenCode config preserving $schema and settings', async () => {
		await writeGlobalConfig(
			ctx.tempHome,
			'.config/opencode/opencode.json',
			OPENCODE_DEFAULT_CONFIG,
		);

		const editor = getEditor('opencode')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.config/opencode/opencode.json',
		)) as {
			$schema: string;
			provider: string;
			model: string;
			mcp: Record<string, unknown>;
		};

		// Verify settings preserved
		expect(config.$schema).toBe('https://opencode.ai/config.json');
		expect(config.provider).toBe('anthropic');
		expect(config.model).toBe('claude-sonnet-4-20250514');
		// Verify existing server preserved
		expect(config.mcp['puppeteer']).toBeDefined();
		// Verify viberag added
		expect(config.mcp['viberag']).toBeDefined();
	});

	it('removes viberag from OpenCode config', async () => {
		const configWithViberag = {
			...OPENCODE_DEFAULT_CONFIG,
			mcp: {
				...OPENCODE_DEFAULT_CONFIG.mcp,
				viberag: {type: 'local', command: ['npx', '-y', 'viberag-mcp']},
			},
		};
		await writeGlobalConfig(
			ctx.tempHome,
			'.config/opencode/opencode.json',
			configWithViberag,
		);

		const editor = getEditor('opencode')!;
		const result = await removeViberagConfig(editor, 'global', '/unused');

		expect(result.success).toBe(true);

		const config = (await readGlobalConfig(
			ctx.tempHome,
			'.config/opencode/opencode.json',
		)) as {
			mcp: Record<string, unknown>;
		};
		expect(config.mcp['viberag']).toBeUndefined();
		expect(config.mcp['puppeteer']).toBeDefined();
	});
});

// =============================================================================
// Global Scope Error Handling
// =============================================================================

describe('Global Scope Error Handling', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('handles malformed JSON in global config', async () => {
		await writeGlobalConfig(ctx.tempHome, '.claude.json', '{ invalid json }');

		const editor = getEditor('claude-code')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(false);
		expect(result.error).toContain('parse');
	});

	it('handles removal when global config does not exist', async () => {
		const editor = getEditor('claude-code')!;
		const result = await removeViberagConfig(editor, 'global', '/unused');

		expect(result.success).toBe(false);
		expect(result.error).toContain('does not exist');
	});

	it('handles removal when viberag not in global config', async () => {
		await writeGlobalConfig(ctx.tempHome, '.claude.json', {
			mcpServers: {
				'other-server': {command: 'other'},
			},
		});

		const editor = getEditor('claude-code')!;
		const result = await removeViberagConfig(editor, 'global', '/unused');

		expect(result.success).toBe(false);
		expect(result.error).toContain('not configured');
	});

	it('returns not configured when global config is empty', async () => {
		await writeGlobalConfig(ctx.tempHome, '.claude.json', {});

		const editor = getEditor('claude-code')!;
		const result = await isAlreadyConfigured(editor, 'global', '/unused');

		expect(result).toBe(false);
	});
});

// =============================================================================
// Editors Without Global File Config (UI-only)
// =============================================================================

describe('Editors Without Global File Config', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it('VS Code returns null for global config path', () => {
		const editor = getEditor('vscode')!;
		const configPath = getConfigPath(editor, 'global');

		expect(configPath).toBeNull();
	});

	it('Roo Code returns null for global config path', () => {
		const editor = getEditor('roo-code')!;
		const configPath = getConfigPath(editor, 'global');

		expect(configPath).toBeNull();
	});

	it('JetBrains returns null for global config path', () => {
		const editor = getEditor('jetbrains')!;
		const configPath = getConfigPath(editor, 'global');

		expect(configPath).toBeNull();
	});

	it('writeMcpConfig fails gracefully for VS Code global', async () => {
		const editor = getEditor('vscode')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(false);
		expect(result.method).toBe('instructions-shown');
	});

	it('writeMcpConfig fails gracefully for Roo Code global', async () => {
		const editor = getEditor('roo-code')!;
		const result = await writeMcpConfig(editor, 'global', '/unused');

		expect(result.success).toBe(false);
		expect(result.method).toBe('instructions-shown');
	});
});

// =============================================================================
// Global Config Path Resolution
// =============================================================================

describe('Global Config Path Resolution', () => {
	let ctx: TempHomeContext;

	beforeEach(async () => {
		ctx = await createMockHome();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	const globalPathTests = [
		{id: 'claude-code', expected: '.claude.json'},
		{id: 'cursor', expected: '.cursor/mcp.json'},
		{id: 'windsurf', expected: '.codeium/windsurf/mcp_config.json'},
		{id: 'gemini-cli', expected: '.gemini/settings.json'},
	];

	for (const {id, expected} of globalPathTests) {
		it(`resolves correct global path for ${id}`, () => {
			const editor = getEditor(id as EditorId)!;
			const configPath = getConfigPath(editor, 'global');

			expect(configPath).toBe(path.join(ctx.tempHome, expected));
		});
	}

	// Platform-specific paths (these use special resolvers)
	it('resolves Zed config path correctly', () => {
		const editor = getEditor('zed')!;
		const configPath = getConfigPath(editor, 'global');

		// Should be .config/zed/settings.json on macOS/Linux
		expect(configPath).toContain('zed');
		expect(configPath).toContain('settings.json');
	});

	it('resolves OpenCode config path correctly', () => {
		const editor = getEditor('opencode')!;
		const configPath = getConfigPath(editor, 'global');

		// Should be .config/opencode/opencode.json on macOS/Linux
		expect(configPath).toContain('opencode');
		expect(configPath?.endsWith('opencode.json')).toBe(true);
	});
});
