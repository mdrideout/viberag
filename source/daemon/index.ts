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
 * The daemon uses the current working directory as the project root by default,
 * or $VIBERAG_PROJECT_ROOT when started by a client.
 *
 * Runtime files (socket/pid/lock) and all persisted data live under:
 *   ~/.local/share/viberag (override via $VIBERAG_HOME)
 *
 * The daemon will:
 * - Acquire exclusive lock to prevent multiple instances
 * - Start the file watcher for auto-indexing
 * - Warm up the embedding provider
 * - Listen for IPC requests (search, index, status, etc.)
 * - Auto-shutdown after 5 minutes of idle (no connected clients)
 */

import fs from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import {DaemonOwner} from './owner.js';
import {DaemonServer} from './server.js';
import {LifecycleManager} from './lifecycle.js';
import {createHandlers} from './handlers.js';
import {configExists, loadConfig} from './lib/config.js';
import {
	getCanonicalProjectRoot,
	getDaemonLockPath,
	getRunDir,
} from './lib/constants.js';

const projectRoot = getCanonicalProjectRoot(
	process.env['VIBERAG_PROJECT_ROOT'] ?? process.cwd(),
);

// Lock file path - inside the global run directory
const LOCK_FILE_PATH = getDaemonLockPath(projectRoot);
const RUN_DIR = getRunDir(projectRoot);

// Lock release function - set when lock is acquired
let releaseLock: (() => Promise<void>) | null = null;

/**
 * Acquire exclusive daemon lock to prevent multiple instances.
 * Uses proper-lockfile which is cross-platform and handles crash recovery.
 */
async function acquireDaemonLock(): Promise<() => Promise<void>> {
	try {
		// Ensure run dir exists so we never need to write inside the project folder
		await fs.mkdir(RUN_DIR, {recursive: true});

		const release = await lockfile.lock(RUN_DIR, {
			lockfilePath: LOCK_FILE_PATH,
			stale: 30000, // Lock is stale after 30s without mtime update
			update: 10000, // Update mtime every 10s to prove liveness
			retries: 0, // Fail immediately if locked
			onCompromised: err => {
				// Another process stole our lock (very rare edge case)
				console.error('[daemon] Lock compromised:', err.message);
				console.error('[daemon] Another daemon may have started. Exiting.');
				process.exit(1);
			},
		});

		console.error('[daemon] Acquired exclusive lock');
		return release;
	} catch (err) {
		if (err instanceof Error && 'code' in err && err.code === 'ELOCKED') {
			console.error('[daemon] Another daemon is already running');
			console.error('[daemon] Only one daemon per project is allowed.');
			process.exit(1);
		}
		throw err;
	}
}

/**
 * Release the daemon lock on exit.
 */
function setupLockRelease(release: () => Promise<void>): void {
	releaseLock = release;

	// Release lock on clean exit
	const cleanup = () => {
		if (releaseLock) {
			// Synchronous-ish cleanup - lockfile handles this gracefully
			releaseLock().catch(() => {});
			releaseLock = null;
		}
	};

	process.on('exit', cleanup);
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

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

	// Acquire exclusive lock BEFORE any other operations
	// This prevents multiple daemons from running concurrently
	const release = await acquireDaemonLock();
	setupLockRelease(release);

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

	// Start server
	await server.start();

	// Initialize owner (starts watcher, begins warmup)
	await owner.initialize();

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
	// Pass Error object directly to preserve stack trace (ADR-011)
	console.error('[daemon] Fatal error:', error);
	process.exit(1);
});
