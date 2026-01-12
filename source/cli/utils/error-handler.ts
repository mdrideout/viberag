/**
 * CLI Error Handler
 *
 * Centralized error handling for the CLI with logging to:
 * - Console (stderr) - immediate visibility with full stack trace
 * - .viberag/logs/cli/ - persistent log with hourly rotation
 *
 * Usage:
 * ```typescript
 * import { handleCliError, createCliLogger } from './utils/error-handler.js';
 *
 * // In component or hook
 * const logger = createCliLogger(projectRoot);
 *
 * try {
 *   await someOperation();
 * } catch (error) {
 *   handleCliError('ComponentName', error, logger);
 * }
 * ```
 */

import {createServiceLogger, type Logger} from '../../daemon/lib/logger.js';

/**
 * Create a CLI logger for the given project root.
 * Writes to .viberag/logs/cli/YYYY-MM-DD-HH.log
 */
export function createCliLogger(projectRoot: string): Logger | null {
	try {
		return createServiceLogger(projectRoot, 'cli');
	} catch {
		// Project may not be initialized yet
		return null;
	}
}

/**
 * Handle a CLI error with full logging.
 *
 * Logs to:
 * 1. Console (stderr) - with full Error object for stack trace
 * 2. CLI log file - .viberag/logs/cli/ with hourly rotation
 *
 * @param component - Component or context name (e.g., 'IndexCommand', 'SearchHandler')
 * @param error - The error that occurred
 * @param logger - Optional logger instance (if project is initialized)
 * @param options - Optional configuration
 */
export function handleCliError(
	component: string,
	error: unknown,
	logger?: Logger | null,
	options?: {
		/** If true, don't log to console (already logged elsewhere) */
		skipConsole?: boolean;
		/** Additional context to include in logs */
		context?: Record<string, unknown>;
	},
): void {
	const message = error instanceof Error ? error.message : String(error);

	// Tier 1: Console with full stack trace
	if (!options?.skipConsole) {
		console.error(`[cli] ${component}:`, error);
	}

	// Tier 2: Persistent log file
	if (logger) {
		if (options?.context) {
			logger.error(
				component,
				message,
				error instanceof Error ? error : undefined,
			);
			logger.debug(component, 'Error context', options.context);
		} else {
			logger.error(
				component,
				message,
				error instanceof Error ? error : new Error(message),
			);
		}
	}

	// Tier 3: Sentry (future)
	// if (Sentry) {
	//   Sentry.captureException(error, {
	//     tags: { component: 'cli', handler: component },
	//     extra: options?.context,
	//   });
	// }
}

/**
 * Check if an error is expected (daemon not running, etc.)
 * Expected errors should be handled gracefully, not logged as errors.
 */
export function isExpectedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes('ENOENT') ||
		message.includes('ECONNREFUSED') ||
		message.includes('Not connected') ||
		message.includes('connect ENOENT')
	);
}

/**
 * Handle an error that may be expected (daemon not running, etc.)
 * Only logs if the error is unexpected.
 */
export function handleCliErrorIfUnexpected(
	component: string,
	error: unknown,
	logger?: Logger | null,
): void {
	if (!isExpectedError(error)) {
		handleCliError(component, error, logger);
	}
}
