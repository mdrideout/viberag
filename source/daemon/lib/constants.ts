/**
 * Constants - Paths, table names, and configuration constants.
 *
 * This module defines the core constants used throughout the daemon.
 */

import path from 'node:path';

// ============================================================================
// Directory Paths
// ============================================================================

/**
 * Directory name for Viberag storage.
 * This directory should be added to .gitignore.
 */
export const VIBERAG_DIR = '.viberag';

/**
 * Get the absolute path to the Viberag directory for a project.
 */
export function getViberagDir(projectRoot: string): string {
	return path.join(projectRoot, VIBERAG_DIR);
}

/**
 * Get the path to the config file.
 */
export function getConfigPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'config.json');
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
 * Format: .viberag/logs/{service}/YYYY-MM-DD-HH.log
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
