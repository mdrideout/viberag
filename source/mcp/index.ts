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
// Direct imports for fast startup (avoid barrel file)
import {configExists} from '../rag/config/index.js';
import {createDebugLogger} from '../rag/logger/index.js';
import {getIndexer} from './services/lazy-loader.js';

// Use current working directory as project root (same behavior as CLI)
const projectRoot = process.cwd();

const {server, startWatcher, stopWatcher, startWarmup, warmupManager} =
	createMcpServer(projectRoot);

// Handle shutdown signals
async function shutdown(signal: string): Promise<void> {
	console.error(`[viberag-mcp] Received ${signal}, shutting down...`);
	await stopWatcher();
	process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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
		// For uninitialized projects, we're done - no warmup, watcher, or sync needed
		return;
	}

	// Start warmup FIRST (most important for tool responsiveness)
	// This runs in background - tools will wait for it to complete
	try {
		startWarmup();
		console.error('[viberag-mcp] Warmup started');

		// Monitor warmup completion for logging (non-blocking)
		warmupManager.getWarmupPromise()?.catch(error => {
			console.error(
				'[viberag-mcp] Warmup failed:',
				error instanceof Error ? error.message : error,
			);
		});
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

	// Sync index on startup - catches any changes made while MCP server was offline
	try {
		console.error('[viberag-mcp] Running startup sync...');
		const logger = createDebugLogger(projectRoot);
		// Lazy load Indexer (ok here since we're already in async startup tasks after connect)
		const Indexer = await getIndexer();
		const indexer = new Indexer(projectRoot, logger);
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
	} catch (error) {
		// Sync errors shouldn't crash the server
		console.error(
			'[viberag-mcp] Startup sync failed:',
			error instanceof Error ? error.message : error,
		);
	}
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
