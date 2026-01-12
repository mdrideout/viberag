/**
 * Config - Viberag project configuration loading and management.
 *
 * Handles loading, saving, and validating project configuration.
 * Configuration is stored in .viberag/config.json.
 */

import fs from 'node:fs/promises';
import {getConfigPath, getViberagDir} from './constants.js';
import type {EmbeddingProviderType} from '../../common/types.js';

export type {EmbeddingProviderType};

// ============================================================================
// Types
// ============================================================================

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
	/** API key for cloud providers (gemini, mistral, openai) */
	apiKey?: string;
	/** OpenAI API base URL (for corporate accounts with data residency) */
	openaiBaseUrl?: string;
	extensions: string[];
	excludePatterns: string[];
	chunkMaxSize: number;
	/** @deprecated Use watch.debounceMs instead */
	watchDebounceMs: number;
	/** File watcher configuration */
	watch: WatchConfig;
}

// ============================================================================
// Provider Configurations
// ============================================================================

/**
 * Provider-specific embedding configurations.
 */
export const PROVIDER_CONFIGS: Record<
	EmbeddingProviderType,
	{model: string; dimensions: number}
> = {
	local: {
		model: 'Qwen/Qwen3-Embedding-0.6B',
		dimensions: 1024,
	},
	'local-4b': {
		model: 'Qwen/Qwen3-Embedding-4B',
		dimensions: 2560,
	},
	gemini: {
		model: 'gemini-embedding-001',
		dimensions: 1536,
	},
	mistral: {
		model: 'codestral-embed',
		dimensions: 1536,
	},
	openai: {
		model: 'text-embedding-3-small',
		dimensions: 1536,
	},
};

// ============================================================================
// Defaults
// ============================================================================

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

// ============================================================================
// Config Factory
// ============================================================================

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

// ============================================================================
// Config I/O
// ============================================================================

/**
 * Load config from disk, merging with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 * Handles nested watch config merge for backward compatibility.
 *
 * IMPORTANT: If the config file exists but can't be read/parsed,
 * this throws an error instead of silently falling back to defaults.
 * This prevents dimension mismatches when switching providers.
 */
export async function loadConfig(projectRoot: string): Promise<ViberagConfig> {
	const configPath = getConfigPath(projectRoot);

	// First check if the file exists
	try {
		await fs.access(configPath);
	} catch {
		// Config doesn't exist - return defaults (expected for first run)
		return {...DEFAULT_CONFIG};
	}

	// File exists - must be readable and valid
	// Don't silently fall back to defaults as this could cause dimension mismatches
	const content = await fs.readFile(configPath, 'utf-8');

	let loaded: Partial<ViberagConfig>;
	try {
		loaded = JSON.parse(content) as Partial<ViberagConfig>;
	} catch (parseError) {
		throw new Error(
			`Invalid config.json at ${configPath}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
		);
	}

	// Validate embedding dimensions match provider
	const provider = loaded.embeddingProvider ?? DEFAULT_CONFIG.embeddingProvider;
	const expectedDimensions = PROVIDER_CONFIGS[provider]?.dimensions;
	if (expectedDimensions && loaded.embeddingDimensions !== expectedDimensions) {
		// Dimensions mismatch - this can happen after provider change
		// Auto-correct to prevent search failures
		loaded.embeddingDimensions = expectedDimensions;
		loaded.embeddingModel = PROVIDER_CONFIGS[provider].model;
	}

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
