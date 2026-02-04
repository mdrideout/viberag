/**
 * Daemon Lifecycle Manager
 *
 * Handles:
 * - Activity-based idle timeout (auto-shutdown when no activity)
 * - Signal handling (SIGINT, SIGTERM)
 * - Graceful shutdown coordination
 *
 * Simplified for polling-based architecture:
 * - Tracks activity (requests) instead of client connections
 * - Any request resets the idle timer
 */

import type {DaemonOwner} from './owner.js';
import type {DaemonServer} from './server.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default idle timeout: 5 minutes.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// Lifecycle Manager
// ============================================================================

/**
 * Manages daemon lifecycle events.
 */
export class LifecycleManager {
	private readonly server: DaemonServer;
	private readonly owner: DaemonOwner;
	private readonly idleTimeoutMs: number;
	private readonly onShutdown: ((reason: string) => Promise<void>) | null;

	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private shuttingDown = false;
	private lastActivityTime: number = Date.now();

	constructor(
		server: DaemonServer,
		owner: DaemonOwner,
		idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
		onShutdown?: (reason: string) => Promise<void>,
	) {
		this.server = server;
		this.owner = owner;
		this.idleTimeoutMs = idleTimeoutMs;
		this.onShutdown = onShutdown ?? null;

		// Wire up activity callback instead of connect/disconnect
		this.server.onActivity = this.onActivity.bind(this);
	}

	/**
	 * Called on each request to reset idle timer.
	 */
	onActivity(): void {
		this.lastActivityTime = Date.now();
		this.resetIdleTimer();
	}

	/**
	 * Reset the idle timeout timer.
	 */
	private resetIdleTimer(): void {
		if (this.shuttingDown) return;

		// Cancel existing timer
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}

		// Start new timer
		this.idleTimer = setTimeout(() => {
			const idleSeconds = Math.round(
				(Date.now() - this.lastActivityTime) / 1000,
			);
			console.error(
				`[daemon] Idle for ${idleSeconds}s, exceeds ${this.idleTimeoutMs / 1000}s limit`,
			);
			this.shutdown('idle timeout');
		}, this.idleTimeoutMs);
	}

	/**
	 * Cancel the idle timeout timer.
	 */
	private cancelIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	/**
	 * Register signal handlers for graceful shutdown.
	 */
	registerSignalHandlers(): void {
		const handler = (signal: string) => {
			console.error(`[daemon] Received ${signal}`);
			this.shutdown(signal);
		};

		process.on('SIGINT', () => handler('SIGINT'));
		process.on('SIGTERM', () => handler('SIGTERM'));
	}

	/**
	 * Perform graceful shutdown.
	 */
	async shutdown(reason: string): Promise<void> {
		if (this.shuttingDown) {
			return;
		}
		this.shuttingDown = true;

		console.error(`[daemon] Shutting down: ${reason}`);

		this.cancelIdleTimer();

		try {
			if (this.onShutdown) {
				await this.onShutdown(reason);
			}

			// Shutdown owner (closes watcher, search engine)
			await this.owner.shutdown();

			// Stop server (closes connections, removes socket)
			await this.server.stop();
		} catch (error) {
			console.error(
				'[daemon] Error during shutdown:',
				error instanceof Error ? error.message : error,
			);
		}

		process.exit(0);
	}

	/**
	 * Start initial idle timer (for when daemon starts with no clients).
	 */
	startInitialIdleTimer(): void {
		console.error(
			`[daemon] Starting idle timer (${this.idleTimeoutMs / 1000}s timeout)`,
		);
		this.resetIdleTimer();
	}
}
