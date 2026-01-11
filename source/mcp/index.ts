#!/usr/bin/env node
/**
 * VibeRAG MCP Server Entry Point
 *
 * Exposes VibeRAG functionality via Model Context Protocol.
 * Uses current working directory as project root.
 * Connects to the daemon for all RAG operations.
 *
 * Usage with Claude Code:
 *   claude mcp add viberag -- npx viberag-mcp
 */

import {createMcpServer} from './server.js';
import {configExists} from '../rag/config/index.js';

// Use current working directory as project root (same behavior as CLI)
const projectRoot = process.cwd();

const {server, connectDaemon, disconnectDaemon} = createMcpServer(projectRoot);

// Handle shutdown signals
async function shutdown(signal: string): Promise<void> {
	console.error(`[viberag-mcp] Received ${signal}, shutting down...`);
	await disconnectDaemon();
	process.exit(0);
}

process.on('SIGINT', () => {
	void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
	void shutdown('SIGTERM');
});

/**
 * Run startup tasks after MCP client connects.
 * This is deferred to ensure the MCP handshake completes first.
 */
async function runStartupTasks(): Promise<void> {
	// Check if project is initialized
	const isInitialized = await configExists(projectRoot);

	if (!isInitialized) {
		console.error('[viberag-mcp] Project not initialized.');
		console.error(
			'[viberag-mcp] Run "npx viberag" in this directory and use /init to configure.',
		);
		console.error(
			'[viberag-mcp] Use viberag_status tool for details on how to initialize.',
		);
		// For uninitialized projects, we're done
		return;
	}

	// Connect to daemon (starts it if needed)
	// The daemon handles warmup, watcher, and startup sync
	await connectDaemon();
}

// Wait for client to connect before running startup tasks
// This ensures the MCP handshake completes before any file I/O
server.on('connect', () => {
	// Run startup tasks in the background (don't block the connection)
	runStartupTasks().catch(error => {
		console.error(
			'[viberag-mcp] Startup tasks failed:',
			error instanceof Error ? error.message : error,
		);
	});
});

// Start the server (await to ensure transport is ready)
server
	.start({
		transportType: 'stdio',
	})
	.catch(error => {
		console.error(
			'[viberag-mcp] Failed to start server:',
			error instanceof Error ? error.message : error,
		);
		process.exit(1);
	});
