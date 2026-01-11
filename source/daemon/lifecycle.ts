/**
 * Daemon Lifecycle Manager
 *
 * Handles:
 * - Idle timeout (auto-shutdown when no clients)
 * - Signal handling (SIGINT, SIGTERM)
 * - Graceful shutdown coordination
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

	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private shuttingDown = false;

	constructor(
		server: DaemonServer,
		owner: DaemonOwner,
		idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
	) {
		this.server = server;
		this.owner = owner;
		this.idleTimeoutMs = idleTimeoutMs;

		// Wire up server callbacks
		this.server.onClientConnect = this.onClientConnect.bind(this);
		this.server.onClientDisconnect = this.onClientDisconnect.bind(this);
	}

	/**
	 * Called when a client connects.
	 */
	onClientConnect(_clientId: string): void {
		this.cancelIdleTimer();
	}

	/**
	 * Called when a client disconnects.
	 */
	onClientDisconnect(_clientId: string, remainingCount: number): void {
		if (remainingCount === 0) {
			this.startIdleTimer();
		}
	}

	/**
	 * Start the idle timeout timer.
	 */
	private startIdleTimer(): void {
		if (this.shuttingDown) return;

		this.cancelIdleTimer();

		console.error(
			`[daemon] No clients, starting idle timer (${this.idleTimeoutMs / 1000}s)`,
		);

		this.idleTimer = setTimeout(() => {
			console.error('[daemon] Idle timeout reached, shutting down');
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
			// Broadcast shutdown to clients
			this.server.broadcast('shuttingDown', {reason});

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
		// Start idle timer immediately - will be cancelled on first connect
		this.startIdleTimer();
	}
}
