import path from 'node:path';

/**
 * Directory name for RAG index storage.
 * This directory should be added to .gitignore.
 */
export const LCR_DIR = '.lance-code-rag';

/**
 * Get the absolute path to the LCR directory for a project.
 */
export function getLcrDir(projectRoot: string): string {
	return path.join(projectRoot, LCR_DIR);
}

/**
 * Get the path to the config file.
 */
export function getConfigPath(projectRoot: string): string {
	return path.join(getLcrDir(projectRoot), 'config.json');
}

/**
 * Get the path to the manifest file.
 */
export function getManifestPath(projectRoot: string): string {
	return path.join(getLcrDir(projectRoot), 'manifest.json');
}

/**
 * Get the path to the LanceDB database directory.
 */
export function getLanceDbPath(projectRoot: string): string {
	return path.join(getLcrDir(projectRoot), 'lancedb');
}

/**
 * Get the path to the logs directory.
 */
export function getLogsDir(projectRoot: string): string {
	return path.join(getLcrDir(projectRoot), 'logs');
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
