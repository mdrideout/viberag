/**
 * Config - Viberag project configuration loading and management.
 *
 * Handles loading, saving, and validating project configuration.
 *
 * Configuration is stored globally per-project under the VibeRAG home dir
 * (default: ~/.local/share/viberag, override via $VIBERAG_HOME).
 */

import fs from 'node:fs/promises';
import {
	getCanonicalProjectRoot,
	getConfigPath,
	getProjectId,
	getProjectMetaPath,
	getViberagDir,
} from './constants.js';
import type {CloudProvider} from './secrets.js';
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
	/**
	 * Reference to a global API key entry (stored under ~/.local/share/viberag/secrets).
	 * Never store raw API keys in the per-project config.
	 */
	apiKeyRef?: {provider: CloudProvider; keyId: string};
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
	gemini: {
		model: 'gemini-embedding-001',
		dimensions: 1536,
	},
	mistral: {
		model: 'codestral-embed',
		dimensions: 1536,
	},
	openai: {
		model: 'text-embedding-3-large',
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

	// Guard rail: never allow legacy inline apiKey storage
	if ('apiKey' in loaded) {
		throw new Error(
			`Legacy inline apiKey found in config at ${configPath}. ` +
				`VibeRAG now stores API keys globally under ~/.local/share/viberag/secrets/. ` +
				`Run /init to reconfigure your embedding provider and API key.`,
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

	// Ensure apiKeyRef provider matches embeddingProvider (avoid mismatched refs)
	const apiKeyRef =
		loaded.apiKeyRef &&
		typeof loaded.apiKeyRef === 'object' &&
		typeof (loaded.apiKeyRef as {provider?: unknown}).provider === 'string' &&
		typeof (loaded.apiKeyRef as {keyId?: unknown}).keyId === 'string'
			? (loaded.apiKeyRef as {provider: CloudProvider; keyId: string})
			: undefined;

	const normalizedApiKeyRef =
		provider === 'local'
			? undefined
			: apiKeyRef?.provider === provider
				? apiKeyRef
				: undefined;

	return {
		...DEFAULT_CONFIG,
		...loaded,
		watch: watchConfig,
		apiKeyRef: normalizedApiKeyRef,
	};
}

/**
 * Save config to disk.
 * Creates the per-project VibeRAG directory if it doesn't exist.
 */
export async function saveConfig(
	projectRoot: string,
	config: ViberagConfig,
): Promise<void> {
	const viberagDir = getViberagDir(projectRoot);
	await fs.mkdir(viberagDir, {recursive: true});

	const configPath = getConfigPath(projectRoot);
	await fs.writeFile(configPath, JSON.stringify(config, null, '\t') + '\n');

	// Write per-project metadata (helps with debugging / listing projects)
	const metaPath = getProjectMetaPath(projectRoot);
	const canonicalRoot = getCanonicalProjectRoot(projectRoot);
	const projectId = getProjectId(projectRoot);

	const now = new Date().toISOString();
	let createdAt = now;
	try {
		const existing = JSON.parse(
			await fs.readFile(metaPath, 'utf-8'),
		) as Partial<{createdAt: string}>;
		if (typeof existing.createdAt === 'string') {
			createdAt = existing.createdAt;
		}
	} catch {
		// Ignore (first write or corrupt)
	}

	await fs.writeFile(
		metaPath,
		JSON.stringify(
			{
				schemaVersion: 1,
				projectId,
				projectRoot: canonicalRoot,
				createdAt,
				updatedAt: now,
			},
			null,
			'\t',
		) + '\n',
	);
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
