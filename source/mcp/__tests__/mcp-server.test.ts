/**
 * MCP server smoke tests.
 *
 * Verifies that the MCP server module can be loaded without errors.
 * This catches circular dependency issues and other initialization failures
 * that would prevent the server from starting.
 */

import {describe, it, expect} from 'vitest';

describe('MCP Server', () => {
	it('server module loads without initialization errors', async () => {
		// This will throw if there are circular dependency issues
		// like "Cannot access 'X' before initialization"
		const importPromise = import('../server.js');

		// Should not throw ReferenceError or other initialization errors
		await expect(importPromise).resolves.toBeDefined();
	});

	it('exports createMcpServer function', async () => {
		const serverModule = await import('../server.js');

		// Verify key exports exist
		expect(serverModule).toHaveProperty('createMcpServer');
		expect(typeof serverModule.createMcpServer).toBe('function');
	});
});
