import fs from 'node:fs/promises';
import {getConfigPath, getViberagDir} from '../constants.js';

export type EmbeddingProviderType = 'local' | 'openai' | 'gemini';

export interface ViberagConfig {
	version: number;
	embeddingProvider: EmbeddingProviderType;
	embeddingModel: string;
	embeddingDimensions: number;
	extensions: string[];
	excludePatterns: string[];
	chunkMaxSize: number;
	watchDebounceMs: number;
}

export const DEFAULT_CONFIG: ViberagConfig = {
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
		'.viberag',
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
export async function loadConfig(projectRoot: string): Promise<ViberagConfig> {
	const configPath = getConfigPath(projectRoot);

	try {
		const content = await fs.readFile(configPath, 'utf-8');
		const loaded = JSON.parse(content) as Partial<ViberagConfig>;
		return {...DEFAULT_CONFIG, ...loaded};
	} catch {
		return {...DEFAULT_CONFIG};
	}
}

/**
 * Save config to disk.
 * Creates the .viberag directory if it doesn't exist.
 */
export async function saveConfig(
	projectRoot: string,
	config: ViberagConfig,
): Promise<void> {
	const viberagDir = getViberagDir(projectRoot);
	await fs.mkdir(viberagDir, {recursive: true});

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
