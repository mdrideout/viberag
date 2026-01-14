/**
 * Daemon Auto-Start Logic
 *
 * Handles spawning the daemon if not running and waiting for it to be ready.
 * Uses proper-lockfile for single-instance coordination.
 */

import {spawn} from 'node:child_process';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import lockfile from 'proper-lockfile';

// ============================================================================
// Constants
// ============================================================================

/** Maximum time to wait for daemon to start (includes warmup time) */
const DAEMON_START_TIMEOUT_MS = 30000;

/** Interval between socket connection attempts */
const SOCKET_POLL_INTERVAL_MS = 100;

/** Maximum time to wait for initial connection */
const CONNECT_TIMEOUT_MS = 5000;

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the socket path for a project.
 */
export function getSocketPath(projectRoot: string): string {
	if (process.platform === 'win32') {
		const hash = crypto
			.createHash('md5')
			.update(projectRoot)
			.digest('hex')
			.slice(0, 8);
		return `\\\\.\\pipe\\viberag-${hash}`;
	}
	return path.join(projectRoot, '.viberag', 'daemon.sock');
}

/**
 * Get the PID file path for a project.
 */
export function getPidPath(projectRoot: string): string {
	return path.join(projectRoot, '.viberag', 'daemon.pid');
}

/**
 * Get the lock file path for a project.
 */
export function getLockPath(projectRoot: string): string {
	return path.join(projectRoot, '.viberag', 'daemon.lock');
}

// ============================================================================
// Lock Check
// ============================================================================

/**
 * Check if the daemon lock is held (daemon is running or starting).
 * This is faster than socket connection check for detecting running daemon.
 */
export async function isDaemonLocked(projectRoot: string): Promise<boolean> {
	const lockPath = getLockPath(projectRoot);
	try {
		const isLocked = await lockfile.check(projectRoot, {
			lockfilePath: lockPath,
			stale: 30000, // Same as daemon lock settings
		});
		return isLocked;
	} catch {
		// Lock file doesn't exist or other error - not locked
		return false;
	}
}

// ============================================================================
// Connection Check
// ============================================================================

/**
 * Check if the socket is connectable.
 */
export async function isSocketConnectable(
	socketPath: string,
	timeout: number = CONNECT_TIMEOUT_MS,
): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.createConnection(socketPath);

		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeout);

		socket.on('connect', () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});

		socket.on('error', () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

// ============================================================================
// Stale File Cleanup
// ============================================================================

/**
 * Check if a process with the given PID is running.
 */
function isProcessRunning(pid: number): boolean {
	try {
		// Signal 0 doesn't actually send a signal, just checks if process exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Clean up stale socket and PID files.
 * Returns true if cleanup was performed.
 */
async function cleanupStaleFiles(
	socketPath: string,
	pidPath: string,
): Promise<boolean> {
	try {
		const pidStr = await fs.readFile(pidPath, 'utf-8');
		const pid = parseInt(pidStr.trim(), 10);

		if (isNaN(pid)) {
			// Invalid PID file, clean up
			await fs.rm(socketPath, {force: true});
			await fs.rm(pidPath, {force: true});
			return true;
		}

		if (isProcessRunning(pid)) {
			// Process is running, socket might be temporarily unavailable
			// Don't clean up, let caller retry
			return false;
		}

		// Process not running, clean up stale files
		await fs.rm(socketPath, {force: true});
		await fs.rm(pidPath, {force: true});
		return true;
	} catch {
		// No PID file or error reading it, try to clean up socket
		try {
			await fs.rm(socketPath, {force: true});
		} catch {
			// Ignore
		}
		return true;
	}
}

// ============================================================================
// Daemon Spawning
// ============================================================================

/**
 * Find the viberag-daemon entry point.
 * Looks for the daemon script relative to this module.
 */
function findDaemonScript(): string {
	// When running from dist/, the daemon is at ../daemon/index.js
	// When running from source/, use npx as fallback
	const modulePath = fileURLToPath(import.meta.url);
	const daemonPath = path.resolve(
		path.dirname(modulePath),
		'../daemon/index.js',
	);
	return daemonPath;
}

/**
 * Spawn the daemon process.
 */
async function spawnDaemon(projectRoot: string): Promise<void> {
	const daemonScript = findDaemonScript();

	// Check if we can use direct node invocation (faster, more reliable)
	try {
		await fs.access(daemonScript);
		// Direct node invocation
		const daemon = spawn('node', [daemonScript], {
			cwd: projectRoot,
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		});
		daemon.unref();
		return;
	} catch {
		// Fallback to npx (slower but works anywhere)
	}

	// Fallback: spawn via npx
	const daemon = spawn('npx', ['viberag-daemon'], {
		cwd: projectRoot,
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
	});
	daemon.unref();
}

/**
 * Wait for the socket to become connectable.
 */
async function waitForSocket(
	socketPath: string,
	timeout: number = DAEMON_START_TIMEOUT_MS,
): Promise<void> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		if (await isSocketConnectable(socketPath, 500)) {
			return;
		}
		await new Promise(r => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
	}

	throw new Error(`Daemon failed to start within ${timeout}ms`);
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Ensure the daemon is running for a project.
 * Starts it if not running, waits for it to be ready.
 *
 * Uses lock-based coordination to prevent race conditions:
 * 1. Check if socket is connectable (daemon fully running)
 * 2. Check if lock is held (daemon is starting up)
 * 3. Only spawn if neither - prevents multiple spawn attempts
 */
export async function ensureDaemonRunning(projectRoot: string): Promise<void> {
	const socketPath = getSocketPath(projectRoot);
	const pidPath = getPidPath(projectRoot);

	// Try to connect to existing daemon (fast path)
	if (await isSocketConnectable(socketPath)) {
		return; // Daemon already running
	}

	// Check if daemon is starting (lock held but socket not ready yet)
	// This prevents multiple clients from spawning daemons concurrently
	if (await isDaemonLocked(projectRoot)) {
		// Daemon is starting, wait for socket without spawning
		await waitForSocket(socketPath);
		return;
	}

	// Check for stale files and clean up
	await cleanupStaleFiles(socketPath, pidPath);

	// Spawn daemon - it will acquire the lock before anything else
	await spawnDaemon(projectRoot);

	// Wait for socket to become available
	await waitForSocket(socketPath);
}

/**
 * Check if the daemon is currently running.
 * Returns true if either the socket is connectable OR the lock is held.
 */
export async function isDaemonRunning(projectRoot: string): Promise<boolean> {
	const socketPath = getSocketPath(projectRoot);
	// Check socket first (daemon fully running)
	if (await isSocketConnectable(socketPath, 1000)) {
		return true;
	}
	// Check lock (daemon is starting)
	return isDaemonLocked(projectRoot);
}
