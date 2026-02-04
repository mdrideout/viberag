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
import {configExists} from '../daemon/lib/config.js';
import {createRequire} from 'node:module';
import {captureException, initSentry} from '../daemon/lib/telemetry/sentry.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as {
	name: string;
	version: `${number}.${number}.${number}`;
};

// Use current working directory as project root (same behavior as CLI)
const projectRoot = process.cwd();

const {server, connectDaemon, disconnectDaemon, telemetry} =
	createMcpServer(projectRoot);
const sentry = initSentry({service: 'mcp', version: pkg.version});

const shouldTestException =
	process.env['VIBERAG_TEST_EXCEPTION'] === '1' ||
	process.env['VIBERAG_TEST_EXCEPTION'] === 'true';

if (shouldTestException) {
	void (async () => {
		const error = new Error('VibeRAG test exception (mcp)');
		captureException(error, {
			tags: {service: 'mcp', test_exception: 'true'},
			extra: {test_id: process.env['VIBERAG_TEST_EXCEPTION_ID'] ?? null},
		});
		await telemetry.shutdown();
		await sentry.shutdown();
		process.exit(1);
	})();
}

// Handle shutdown signals
async function shutdown(signal: string): Promise<void> {
	console.error(`[viberag-mcp] Received ${signal}, shutting down...`);
	await disconnectDaemon();
	await telemetry.shutdown();
	await sentry.shutdown();
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
			'[viberag-mcp] Use get_status tool for details on how to initialize.',
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
		// Pass Error object directly to preserve stack trace (ADR-011)
		console.error('[viberag-mcp] Startup tasks failed:', error);
		captureException(error, {tags: {service: 'mcp', phase: 'startup'}});
	});
});

// Start the server (await to ensure transport is ready)
server
	.start({
		transportType: 'stdio',
	})
	.catch(async error => {
		// Pass Error object directly to preserve stack trace (ADR-011)
		console.error('[viberag-mcp] Failed to start server:', error);
		captureException(error, {tags: {service: 'mcp', phase: 'start'}});
		await telemetry.shutdown();
		await sentry.shutdown();
		process.exit(1);
	});
