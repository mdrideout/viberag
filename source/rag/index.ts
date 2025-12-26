/**
 * RAG Engine Core
 *
 * Local codebase indexing with hybrid search (vector + BM25).
 */

// Constants
export {
	LCR_DIR,
	getLcrDir,
	getConfigPath,
	getManifestPath,
	getLanceDbPath,
	getLogsDir,
	TABLE_NAMES,
	EXTENSION_TO_LANGUAGE,
	DEFAULT_EMBEDDING_DIMENSIONS,
} from './constants.js';

// Logger
export {
	createLogger,
	createNullLogger,
	getLogPath,
	type Logger,
	type LogLevel,
} from './logger/index.js';

// Config
export {
	loadConfig,
	saveConfig,
	configExists,
	DEFAULT_CONFIG,
	type LCRConfig,
	type EmbeddingProvider,
} from './config/index.js';

// Manifest
export {
	loadManifest,
	saveManifest,
	manifestExists,
	createEmptyManifest,
	updateManifestStats,
	updateManifestTree,
	type Manifest,
	type ManifestStats,
} from './manifest/index.js';
