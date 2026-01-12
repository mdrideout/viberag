/**
 * Daemon Status Context
 *
 * Provides daemon status to CLI components via React Context.
 * Replaces Redux sync for daemon state - components read directly
 * from the polled status instead of going through Redux.
 */

import React, {
	createContext,
	useContext,
	useState,
	useEffect,
	useRef,
	type ReactNode,
} from 'react';
import {DaemonClient} from '../../client/index.js';
import type {DaemonStatusResponse} from '../../client/types.js';
import {
	createCliLogger,
	handleCliErrorIfUnexpected,
	isExpectedError,
} from '../utils/error-handler.js';
import type {Logger} from '../../daemon/lib/logger.js';

// ============================================================================
// Context
// ============================================================================

const DaemonStatusContext = createContext<DaemonStatusResponse | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface DaemonStatusProviderProps {
	children: ReactNode;
	projectRoot: string;
	enabled?: boolean;
	intervalMs?: number;
}

/**
 * Provides daemon status to child components.
 *
 * Polls daemon.status() and makes the result available via context.
 * Components use useDaemonStatus() to access the current status.
 */
export function DaemonStatusProvider({
	children,
	projectRoot,
	enabled = true,
	intervalMs = 500,
}: DaemonStatusProviderProps): React.ReactElement {
	const [status, setStatus] = useState<DaemonStatusResponse | null>(null);
	const clientRef = useRef<DaemonClient | null>(null);
	const pollingRef = useRef<boolean>(false);
	const loggerRef = useRef<Logger | null>(null);

	useEffect(() => {
		let mounted = true;
		let interval: ReturnType<typeof setInterval> | null = null;

		if (!enabled) {
			return () => {
				mounted = false;
			};
		}

		loggerRef.current = createCliLogger(projectRoot);

		const client = new DaemonClient({
			projectRoot,
			autoStart: false,
		});
		clientRef.current = client;

		const poll = async () => {
			if (!mounted) return;
			if (pollingRef.current) return;
			pollingRef.current = true;

			try {
				if (!(await client.isRunning())) {
					return;
				}

				await client.connect();
				try {
					const daemonStatus = await client.status();
					if (mounted) {
						setStatus(daemonStatus);
					}
				} finally {
					await client.disconnect();
				}
			} catch (error) {
				handleCliErrorIfUnexpected(
					'DaemonStatusProvider',
					error,
					loggerRef.current,
				);
			} finally {
				pollingRef.current = false;
			}
		};

		poll();
		interval = setInterval(poll, intervalMs);

		return () => {
			mounted = false;
			pollingRef.current = false;
			if (interval) {
				clearInterval(interval);
			}
			clientRef.current?.disconnect().catch(err => {
				if (!isExpectedError(err)) {
					handleCliErrorIfUnexpected(
						'DaemonStatusProvider.cleanup',
						err,
						loggerRef.current,
					);
				}
			});
			clientRef.current = null;
			loggerRef.current = null;
		};
	}, [projectRoot, enabled, intervalMs]);

	return (
		<DaemonStatusContext.Provider value={status}>
			{children}
		</DaemonStatusContext.Provider>
	);
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Access the current daemon status.
 *
 * Returns null if status hasn't been fetched yet or daemon is not running.
 *
 * Usage:
 * ```tsx
 * function MyComponent() {
 *   const status = useDaemonStatus();
 *   if (!status) return <Text>Loading...</Text>;
 *   return <Text>Indexing: {status.indexing.status}</Text>;
 * }
 * ```
 */
export function useDaemonStatus(): DaemonStatusResponse | null {
	return useContext(DaemonStatusContext);
}
