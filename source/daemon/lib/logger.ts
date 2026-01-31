/**
 * Logger - File-based logging with daily and hourly rotation.
 *
 * Provides multiple logger implementations:
 * - createLogger: Daily log files in the per-project logs directory
 * - createDebugLogger: Single debug.log file (deprecated)
 * - createServiceLogger: Per-service hourly rotation
 * - createNullLogger: No-op for testing
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	getLogsDir,
	getDebugLogPath,
	getViberagDir,
	getServiceLogsDir,
	getServiceLogPath,
	type ServiceName,
} from './constants.js';

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
	debug(component: string, message: string, data?: object): void;
	info(component: string, message: string, data?: object): void;
	warn(component: string, message: string, data?: object): void;
	error(component: string, message: string, error?: Error): void;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Get the path to today's log file.
 */
export function getLogPath(projectRoot: string): string {
	const logsDir = getLogsDir(projectRoot);
	const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
	return path.join(logsDir, `${date}.log`);
}

/**
 * Format a log entry.
 */
function formatEntry(
	level: LogLevel,
	component: string,
	message: string,
	extra?: object | Error,
): string {
	const timestamp = new Date().toISOString();
	const levelStr = level.toUpperCase().padEnd(5);
	let entry = `[${timestamp}] [${levelStr}] ${component}: ${message}`;

	if (extra) {
		if (extra instanceof Error) {
			entry += `\n  Error: ${extra.message}`;
			if (extra.stack) {
				entry += `\n  Stack: ${extra.stack}`;
			}
		} else {
			entry += `\n  ${JSON.stringify(extra)}`;
		}
	}

	return entry;
}

// ============================================================================
// Logger Implementations
// ============================================================================

/**
 * Create a logger that writes to daily log files.
 * Log files are created in the per-project logs directory.
 */
export function createLogger(projectRoot: string): Logger {
	const logsDir = getLogsDir(projectRoot);
	let initialized = false;

	function ensureDir() {
		if (!initialized) {
			fs.mkdirSync(logsDir, {recursive: true});
			initialized = true;
		}
	}

	function write(entry: string) {
		ensureDir();
		const logPath = getLogPath(projectRoot);
		fs.appendFileSync(logPath, entry + '\n');
	}

	return {
		debug(component: string, message: string, data?: object) {
			write(formatEntry('debug', component, message, data));
		},

		info(component: string, message: string, data?: object) {
			write(formatEntry('info', component, message, data));
		},

		warn(component: string, message: string, data?: object) {
			write(formatEntry('warn', component, message, data));
		},

		error(component: string, message: string, error?: Error) {
			write(formatEntry('error', component, message, error));
		},
	};
}

/**
 * Create a no-op logger for testing or when logging is disabled.
 */
export function createNullLogger(): Logger {
	return {
		debug() {},
		info() {},
		warn() {},
		error() {},
	};
}

/**
 * Create a debug logger that writes to the per-project debug.log.
 * This is always-on logging for troubleshooting.
 * @deprecated Use createServiceLogger instead for per-service logging.
 */
export function createDebugLogger(projectRoot: string): Logger {
	const viberagDir = getViberagDir(projectRoot);
	let initialized = false;

	function ensureDir() {
		if (!initialized) {
			fs.mkdirSync(viberagDir, {recursive: true});
			initialized = true;
		}
	}

	function write(entry: string) {
		ensureDir();
		const logPath = getDebugLogPath(projectRoot);
		fs.appendFileSync(logPath, entry + '\n');
	}

	return {
		debug(component: string, message: string, data?: object) {
			write(formatEntry('debug', component, message, data));
		},

		info(component: string, message: string, data?: object) {
			write(formatEntry('info', component, message, data));
		},

		warn(component: string, message: string, data?: object) {
			write(formatEntry('warn', component, message, data));
		},

		error(component: string, message: string, error?: Error) {
			write(formatEntry('error', component, message, error));
		},
	};
}

/**
 * Create a service-specific logger with hourly rotation.
 *
 * Logs are written to: {projectDataDir}/logs/{service}/YYYY-MM-DD-HH.log
 *
 * @param projectRoot - Project root directory
 * @param service - Service name (daemon, mcp, cli, indexer)
 *
 * @example
 * const logger = createServiceLogger('/path/to/project', 'daemon');
 * logger.error('Handler', 'Request failed', error);
 * // Writes to: {projectDataDir}/logs/daemon/2024-01-11-15.log
 */
export function createServiceLogger(
	projectRoot: string,
	service: ServiceName,
): Logger {
	function write(entry: string) {
		try {
			// Always ensure directory exists before writing
			// (handles case where the project data dir was deleted during reinit)
			const serviceDir = getServiceLogsDir(projectRoot, service);
			fs.mkdirSync(serviceDir, {recursive: true});
			// Get current hourly log path (recalculated each write for rotation)
			const logPath = getServiceLogPath(projectRoot, service);
			fs.appendFileSync(logPath, entry + '\n');
		} catch {
			// Silently ignore logging failures - don't crash the app for logging
		}
	}

	return {
		debug(component: string, message: string, data?: object) {
			write(formatEntry('debug', component, message, data));
		},

		info(component: string, message: string, data?: object) {
			write(formatEntry('info', component, message, data));
		},

		warn(component: string, message: string, data?: object) {
			write(formatEntry('warn', component, message, data));
		},

		error(component: string, message: string, error?: Error) {
			write(formatEntry('error', component, message, error));
		},
	};
}

// Re-export ServiceName for convenience
export type {ServiceName};
