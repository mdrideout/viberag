import fs from 'node:fs/promises';
import {getConfigPath, getLcrDir} from '../constants.js';

export type EmbeddingProviderType = 'local' | 'openai' | 'gemini';

export interface LCRConfig {
	version: number;
	embeddingProvider: EmbeddingProviderType;
	embeddingModel: string;
	embeddingDimensions: number;
	extensions: string[];
	excludePatterns: string[];
	chunkMaxSize: number;
	watchDebounceMs: number;
}

export const DEFAULT_CONFIG: LCRConfig = {
	version: 1,
	embeddingProvider: 'local',
	embeddingModel: 'BAAI/bge-base-en-v1.5',
	embeddingDimensions: 768,
	extensions: ['.py', '.js', '.ts', '.tsx', '.go', '.rs', '.java'],
	excludePatterns: [
		'node_modules',
		'.git',
		'__pycache__',
		'venv',
		'.venv',
		'.lance-code-rag',
		'dist',
		'build',
		'.next',
		'coverage',
	],
	chunkMaxSize: 2000,
	watchDebounceMs: 500,
};

/**
 * Load config from disk, merging with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 */
export async function loadConfig(projectRoot: string): Promise<LCRConfig> {
	const configPath = getConfigPath(projectRoot);

	try {
		const content = await fs.readFile(configPath, 'utf-8');
		const loaded = JSON.parse(content) as Partial<LCRConfig>;
		return {...DEFAULT_CONFIG, ...loaded};
	} catch {
		return {...DEFAULT_CONFIG};
	}
}

/**
 * Save config to disk.
 * Creates the .lance-code-rag directory if it doesn't exist.
 */
export async function saveConfig(
	projectRoot: string,
	config: LCRConfig,
): Promise<void> {
	const lcrDir = getLcrDir(projectRoot);
	await fs.mkdir(lcrDir, {recursive: true});

	const configPath = getConfigPath(projectRoot);
	await fs.writeFile(configPath, JSON.stringify(config, null, '\t') + '\n');
}

/**
 * Check if a config file exists.
 */
export async function configExists(projectRoot: string): Promise<boolean> {
	const configPath = getConfigPath(projectRoot);
	try {
		await fs.access(configPath);
		return true;
	} catch {
		return false;
	}
}
