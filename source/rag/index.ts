/**
 * RAG Engine Core
 *
 * Local codebase indexing with hybrid search (vector + BM25).
 */

// Constants
export {
	VIBERAG_DIR,
	getViberagDir,
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
	DEFAULT_WATCH_CONFIG,
	PROVIDER_CONFIGS,
	type ViberagConfig,
	type WatchConfig,
	type EmbeddingProviderType,
} from './config/index.js';

// Manifest
export {
	loadManifest,
	saveManifest,
	manifestExists,
	createEmptyManifest,
	updateManifestStats,
	updateManifestTree,
	isSchemaVersionCurrent,
	getSchemaVersionInfo,
	type Manifest,
	type ManifestStats,
} from './manifest/index.js';

// Storage
export {
	Storage,
	SCHEMA_VERSION,
	createCodeChunksSchema,
	createEmbeddingCacheSchema,
	chunkToRow,
	rowToChunk,
	embeddingToRow,
	rowToEmbedding,
	type CodeChunk,
	type CodeChunkRow,
	type CachedEmbedding,
	type CachedEmbeddingRow,
	type ChunkType,
} from './storage/index.js';

// Merkle Tree
export {
	MerkleTree,
	compareTrees,
	createEmptyDiff,
	computeFileHash,
	computeStringHash,
	computeDirectoryHash,
	isBinaryFile,
	shouldExclude,
	hasValidExtension,
	serializeNode,
	deserializeNode,
	createFileNode,
	createDirectoryNode,
	type MerkleNode,
	type NodeType,
	type SerializedNode,
	type TreeDiff,
	type BuildStats,
} from './merkle/index.js';

// Indexer (Chunking & Orchestration)
export {
	Chunker,
	Indexer,
	createEmptyIndexStats,
	type Chunk,
	type IndexOptions,
	type IndexStats,
	type ProgressCallback,
	type SupportedLanguage,
} from './indexer/index.js';

// Embeddings
export {
	GeminiEmbeddingProvider,
	MistralEmbeddingProvider,
	OpenAIEmbeddingProvider,
	validateApiKey,
	type EmbeddingProvider,
	type ValidationResult,
	type ValidateApiKeyOptions,
} from './embeddings/index.js';

// Search
export {
	SearchEngine,
	vectorSearch,
	ftsSearch,
	ensureFtsIndex,
	hybridRerank,
	type SearchFilters,
	type SearchMode,
	type SearchOptions,
	type SearchResult,
	type SearchResults,
} from './search/index.js';

// Gitignore
export {
	loadGitignore,
	shouldIgnore,
	createGitignoreFilter,
	clearGitignoreCache,
	clearAllGitignoreCache,
} from './gitignore/index.js';
