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
import {configExists, Indexer} from '../rag/index.js';

// Use current working directory as project root (same behavior as CLI)
const projectRoot = process.cwd();

const {server, startWatcher, stopWatcher, startWarmup} =
	createMcpServer(projectRoot);

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

// Start warmup, watcher, and sync index after server is running
// Use setImmediate to ensure server.start() completes first
setImmediate(async () => {
	// Start warmup FIRST (most important for tool responsiveness)
	// This runs in background - tools will wait for it to complete
	try {
		if (await configExists(projectRoot)) {
			startWarmup();
			console.error('[viberag-mcp] Warmup started');
		}
	} catch (error) {
		console.error(
			'[viberag-mcp] Failed to start warmup:',
			error instanceof Error ? error.message : error,
		);
	}

	// Start watcher (will queue any changes during sync)
	try {
		await startWatcher();
	} catch (error) {
		// Watcher errors shouldn't crash the server
		console.error(
			'[viberag-mcp] Failed to start watcher:',
			error instanceof Error ? error.message : error,
		);
	}

	// Sync index on startup if project is initialized
	// This catches any changes made while MCP server was offline
	try {
		if (await configExists(projectRoot)) {
			console.error('[viberag-mcp] Running startup sync...');
			const indexer = new Indexer(projectRoot);
			try {
				const stats = await indexer.index({force: false});
				if (
					stats.filesNew > 0 ||
					stats.filesModified > 0 ||
					stats.filesDeleted > 0
				) {
					console.error(
						`[viberag-mcp] Startup sync complete: ${stats.filesNew} new, ${stats.filesModified} modified, ${stats.filesDeleted} deleted`,
					);
				} else {
					console.error('[viberag-mcp] Startup sync: index up to date');
				}
			} finally {
				indexer.close();
			}
		}
	} catch (error) {
		// Sync errors shouldn't crash the server
		console.error(
			'[viberag-mcp] Startup sync failed:',
			error instanceof Error ? error.message : error,
		);
	}
});
