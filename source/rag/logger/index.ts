import fs from 'node:fs';
import path from 'node:path';
import {getLogsDir} from '../constants.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
	debug(component: string, message: string, data?: object): void;
	info(component: string, message: string, data?: object): void;
	warn(component: string, message: string, data?: object): void;
	error(component: string, message: string, error?: Error): void;
}

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

/**
 * Create a logger that writes to daily log files.
 * Log files are created in the .lance-code-rag/logs/ directory.
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
