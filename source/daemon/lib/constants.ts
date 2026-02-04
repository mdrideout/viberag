/**
 * Constants - Paths, table names, and configuration constants.
 *
 * This module defines the core constants used throughout the daemon.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// Directory Paths
// ============================================================================

/**
 * Environment variable to override the VibeRAG home directory.
 *
 * All persisted data lives under the VibeRAG home directory, never inside
 * the user's project folder.
 */
export const VIBERAG_HOME_ENV = 'VIBERAG_HOME';

/**
 * Get the VibeRAG home directory.
 *
 * Default: ~/.local/share/viberag
 * Override: $VIBERAG_HOME
 * Linux (conventional): $XDG_DATA_HOME/viberag
 */
export function getViberagHomeDir(): string {
	const override = process.env[VIBERAG_HOME_ENV]?.trim();
	if (override) return override;

	const xdg = process.env['XDG_DATA_HOME']?.trim();
	if (xdg) return path.join(xdg, 'viberag');

	return path.join(os.homedir(), '.local', 'share', 'viberag');
}

/**
 * Resolve the canonical project root for stable project identity.
 * Uses realpath to avoid treating symlinked paths as different projects.
 */
export function getCanonicalProjectRoot(projectRoot: string): string {
	return fs.realpathSync(projectRoot);
}

/**
 * Get a stable per-project identifier derived from the canonical project root.
 */
export function getProjectId(projectRoot: string): string {
	const canonical = getCanonicalProjectRoot(projectRoot);
	return crypto
		.createHash('sha256')
		.update(`viberag:${canonical}`)
		.digest('hex')
		.slice(0, 20);
}

/**
 * Get the directory that stores all per-project state (config, index, logs).
 */
export function getProjectsDir(): string {
	return path.join(getViberagHomeDir(), 'projects');
}

/**
 * Get the absolute path to the VibeRAG directory for a project.
 * This is a global path (never inside the project folder).
 */
export function getViberagDir(projectRoot: string): string {
	return path.join(getProjectsDir(), getProjectId(projectRoot));
}

/**
 * Get the path to the config file.
 */
export function getConfigPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'config.json');
}

/**
 * Get the path to the per-project metadata file.
 */
export function getProjectMetaPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'project.json');
}

/**
 * Get the path to the LanceDB database directory.
 */
export function getLanceDbPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'lancedb');
}

// ============================================================================
// Logging Paths
// ============================================================================

/**
 * Get the path to the logs directory.
 */
export function getLogsDir(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'logs');
}

/**
 * Get the path to the debug log file (always-on logging).
 * @deprecated Use getServiceLogPath instead for per-service logging.
 */
export function getDebugLogPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'debug.log');
}

/**
 * Service names for logging.
 */
export type ServiceName = 'daemon' | 'mcp' | 'cli' | 'indexer';

/**
 * Get the path to a service's log directory.
 */
export function getServiceLogsDir(
	projectRoot: string,
	service: ServiceName,
): string {
	return path.join(getLogsDir(projectRoot), service);
}

/**
 * Get the path to a service's current hourly log file.
 * Format: {projectDataDir}/logs/{service}/YYYY-MM-DD-HH.log
 */
export function getServiceLogPath(
	projectRoot: string,
	service: ServiceName,
): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	const hour = String(now.getHours()).padStart(2, '0');
	const filename = `${year}-${month}-${day}-${hour}.log`;
	return path.join(getServiceLogsDir(projectRoot, service), filename);
}

// ============================================================================
// Daemon Runtime Paths (socket/pid/lock)
// ============================================================================

/**
 * Get the per-project runtime directory (socket, pid, lock).
 */
export function getRunDir(projectRoot: string): string {
	return path.join(getViberagHomeDir(), 'run', getProjectId(projectRoot));
}

/**
 * Get the daemon socket path (Unix) or named pipe (Windows).
 */
export function getDaemonSocketPath(projectRoot: string): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\viberag-${getProjectId(projectRoot)}`;
	}
	return path.join(getRunDir(projectRoot), 'daemon.sock');
}

/**
 * Get the daemon PID file path.
 */
export function getDaemonPidPath(projectRoot: string): string {
	return path.join(getRunDir(projectRoot), 'daemon.pid');
}

/**
 * Get the daemon lock file path.
 */
export function getDaemonLockPath(projectRoot: string): string {
	return path.join(getRunDir(projectRoot), 'daemon.lock');
}

// ============================================================================
// Secrets Paths
// ============================================================================

/**
 * Get the global user settings file path.
 *
 * Path: {VIBERAG_HOME}/settings.json
 */
export function getUserSettingsPath(): string {
	return path.join(getViberagHomeDir(), 'settings.json');
}

/**
 * Get the global secrets directory.
 */
export function getSecretsDir(): string {
	return path.join(getViberagHomeDir(), 'secrets');
}

/**
 * Get the global secrets file path.
 */
export function getSecretsPath(): string {
	return path.join(getSecretsDir(), 'secrets.json');
}

// ============================================================================
// Language Configuration
// ============================================================================

/**
 * File extensions supported for parsing.
 * Maps extension to language identifier.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	'.py': 'python',
	'.js': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'typescript',
};

// ============================================================================
// Embedding Configuration
// ============================================================================

/**
 * Embedding dimensions for default model (BGE-base-en-v1.5).
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/**
 * Max concurrent API requests for embedding providers.
 */
export const CONCURRENCY = 5;
