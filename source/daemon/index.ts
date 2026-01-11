#!/usr/bin/env node
/**
 * VibeRAG Daemon Entry Point
 *
 * Single daemon per project, owns all mutable state.
 * CLI and MCP connect as clients via Unix socket.
 *
 * Usage:
 *   npx viberag-daemon
 *
 * The daemon uses the current working directory as the project root.
 * It creates a socket at .viberag/daemon.sock and a PID file at .viberag/daemon.pid.
 *
 * The daemon will:
 * - Start the file watcher for auto-indexing
 * - Warm up the embedding provider
 * - Listen for IPC requests (search, index, status, etc.)
 * - Auto-shutdown after 5 minutes of idle (no connected clients)
 */

import {DaemonOwner} from './owner.js';
import {DaemonServer} from './server.js';
import {LifecycleManager} from './lifecycle.js';
import {createHandlers} from './handlers.js';
import {configExists, loadConfig} from '../rag/config/index.js';

// Use current working directory as project root
const projectRoot = process.cwd();

/**
 * Main daemon entry point.
 */
async function main(): Promise<void> {
	console.error(`[daemon] Starting for ${projectRoot}`);

	// Verify project is initialized
	if (!(await configExists(projectRoot))) {
		console.error('[daemon] Project not initialized');
		console.error(
			'[daemon] Run "npx viberag" and use /init command to initialize.',
		);
		process.exit(1);
	}

	// Load config
	await loadConfig(projectRoot);
	// Default idle timeout: 5 minutes (can be made configurable later)
	const idleTimeoutMs = 5 * 60 * 1000;

	// Create components
	const owner = new DaemonOwner(projectRoot);
	const server = new DaemonServer(owner);
	const lifecycle = new LifecycleManager(server, owner, idleTimeoutMs);

	// Register handlers
	server.setHandlers(createHandlers());

	// Initialize owner (starts watcher, begins warmup)
	await owner.initialize();

	// Start server
	await server.start();

	// Register signal handlers
	lifecycle.registerSignalHandlers();

	// Start idle timer (cancelled on first connect)
	lifecycle.startInitialIdleTimer();

	console.error(`[daemon] Ready`);
	console.error(`[daemon] Socket: ${owner.getSocketPath()}`);
	console.error(`[daemon] PID: ${process.pid}`);
}

// Run main with error handling
main().catch(error => {
	console.error(
		'[daemon] Fatal error:',
		error instanceof Error ? error.message : error,
	);
	process.exit(1);
});
