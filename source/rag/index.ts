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
	type Manifest,
	type ManifestStats,
} from './manifest/index.js';

// Storage
export {
	Storage,
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

// Indexer (Chunking)
export {
	Chunker,
	createEmptyIndexStats,
	type Chunk,
	type IndexStats,
	type ProgressCallback,
	type SupportedLanguage,
} from './indexer/index.js';

// Embeddings
export {
	LocalEmbeddingProvider,
	type EmbeddingProvider,
} from './embeddings/index.js';
