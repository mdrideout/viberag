import fs from 'node:fs/promises';
import {getConfigPath, getViberagDir} from '../constants.js';
import type {EmbeddingProviderType} from '../../common/types.js';

export type {EmbeddingProviderType};

/**
 * File watcher configuration for auto-indexing.
 */
export interface WatchConfig {
	/** Enable file watching for auto-index (default: true) */
	enabled: boolean;
	/** Debounce delay before processing changes (default: 500ms) */
	debounceMs: number;
	/** Batch window to collect changes before indexing (default: 2000ms) */
	batchWindowMs: number;
	/** Wait for file writes to complete before indexing (default: true) */
	awaitWriteFinish: boolean;
}

export interface ViberagConfig {
	version: number;
	embeddingProvider: EmbeddingProviderType;
	embeddingModel: string;
	embeddingDimensions: number;
	extensions: string[];
	excludePatterns: string[];
	chunkMaxSize: number;
	/** @deprecated Use watch.debounceMs instead */
	watchDebounceMs: number;
	/** File watcher configuration */
	watch: WatchConfig;
}

/**
 * Provider-specific embedding configurations.
 */
export const PROVIDER_CONFIGS: Record<
	EmbeddingProviderType,
	{model: string; dimensions: number}
> = {
	local: {
		model: 'jinaai/jina-embeddings-v2-base-code',
		dimensions: 768,
	},
	gemini: {
		model: 'gemini-embedding-001',
		dimensions: 768,
	},
	mistral: {
		model: 'codestral-embed',
		dimensions: 1024,
	},
	openai: {
		model: 'text-embedding-3-large',
		dimensions: 3072,
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

/**
 * Default watch configuration.
 */
export const DEFAULT_WATCH_CONFIG: WatchConfig = {
	enabled: true,
	debounceMs: 500,
	batchWindowMs: 2000,
	awaitWriteFinish: true,
};

export const DEFAULT_CONFIG: ViberagConfig = {
	version: 1,
	embeddingProvider: 'gemini',
	embeddingModel: PROVIDER_CONFIGS['gemini'].model,
	embeddingDimensions: PROVIDER_CONFIGS['gemini'].dimensions,
	// Extensions to index. Empty array = index ALL text files (recommended).
	// Binary files are automatically detected and skipped.
	// Use .gitignore for exclusions.
	extensions: [],
	// DEPRECATED: Use .gitignore instead. This field is ignored.
	excludePatterns: [],
	chunkMaxSize: 2000,
	watchDebounceMs: 500,
	watch: DEFAULT_WATCH_CONFIG,
};

/**
 * Load config from disk, merging with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 * Handles nested watch config merge for backward compatibility.
 */
export async function loadConfig(projectRoot: string): Promise<ViberagConfig> {
	const configPath = getConfigPath(projectRoot);

	try {
		const content = await fs.readFile(configPath, 'utf-8');
		const loaded = JSON.parse(content) as Partial<ViberagConfig>;

		// Deep merge watch config with defaults
		const watchConfig: WatchConfig = {
			...DEFAULT_WATCH_CONFIG,
			...(loaded.watch ?? {}),
		};

		return {
			...DEFAULT_CONFIG,
			...loaded,
			watch: watchConfig,
		};
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
