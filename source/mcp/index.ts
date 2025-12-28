#!/usr/bin/env node
/**
 * VibeRAG MCP Server Entry Point
 *
 * Exposes VibeRAG functionality via Model Context Protocol.
 * Uses current working directory as project root.
 * Includes file watcher for automatic incremental indexing.
 *
 * Usage with Claude Code:
 *   claude mcp add viberag -- npx viberag-mcp
 */

import {createMcpServer} from './server.js';

// Use current working directory as project root (same behavior as CLI)
const projectRoot = process.cwd();

const {server, startWatcher, stopWatcher} = createMcpServer(projectRoot);

// Handle shutdown signals
async function shutdown(signal: string): Promise<void> {
	console.error(`[viberag-mcp] Received ${signal}, shutting down...`);
	await stopWatcher();
	process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start the server, then start the watcher
server.start({
	transportType: 'stdio',
});

// Start watcher after server is running
// Use setImmediate to ensure server.start() completes first
setImmediate(async () => {
	try {
		await startWatcher();
	} catch (error) {
		// Watcher errors shouldn't crash the server
		console.error(
			'[viberag-mcp] Failed to start watcher:',
			error instanceof Error ? error.message : error,
		);
	}
});
