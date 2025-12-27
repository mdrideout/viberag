import fs from 'node:fs/promises';
import {getConfigPath, getViberagDir} from '../constants.js';
import type {EmbeddingProviderType} from '../../common/types.js';

export type {EmbeddingProviderType};

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

/**
 * Provider-specific embedding configurations.
 */
export const PROVIDER_CONFIGS: Record<
	EmbeddingProviderType,
	{model: string; dimensions: number; dtype?: string}
> = {
	local: {
		model: 'jinaai/jina-embeddings-v2-base-code',
		dimensions: 768,
		dtype: 'q8',
	},
	'local-fast': {
		// Alias for local, kept for backward compatibility
		model: 'jinaai/jina-embeddings-v2-base-code',
		dimensions: 768,
		dtype: 'q8',
	},
	gemini: {
		model: 'gemini-embedding-001',
		dimensions: 768,
	},
	mistral: {
		model: 'codestral-embed-2505',
		dimensions: 1024,
	},
};

/**
 * Create config for a specific provider.
 */
export function createConfigForProvider(
	provider: EmbeddingProviderType,
): ViberagConfig {
	const providerConfig = PROVIDER_CONFIGS[provider];
	return {
		...DEFAULT_CONFIG,
		embeddingProvider: provider,
		embeddingModel: providerConfig.model,
		embeddingDimensions: providerConfig.dimensions,
	};
}

export const DEFAULT_CONFIG: ViberagConfig = {
	version: 1,
	embeddingProvider: 'local',
	embeddingModel: PROVIDER_CONFIGS['local'].model,
	embeddingDimensions: PROVIDER_CONFIGS['local'].dimensions,
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
