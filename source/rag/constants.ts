import path from 'node:path';

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
 * Get the path to the manifest file.
 */
export function getManifestPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'manifest.json');
}

/**
 * Get the path to the LanceDB database directory.
 */
export function getLanceDbPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'lancedb');
}

/**
 * Get the path to the logs directory.
 */
export function getLogsDir(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'logs');
}

/**
 * Get the path to the debug log file (always-on logging).
 */
export function getDebugLogPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'debug.log');
}

/**
 * LanceDB table names.
 */
export const TABLE_NAMES = {
	CODE_CHUNKS: 'code_chunks',
	EMBEDDING_CACHE: 'embedding_cache',
} as const;

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

/**
 * Embedding dimensions for default model (BGE-base-en-v1.5).
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/**
 * Max concurrent API requests for embedding providers.
 * Used by api-utils.ts and slot-progress Redux slice.
 */
export const CONCURRENCY = 5;
