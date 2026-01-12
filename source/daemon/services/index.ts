/**
 * Daemon Services - Business logic owned by the daemon.
 *
 * All services emit events instead of dispatching Redux actions.
 * The daemon owner wires these events to state updates.
 */

// Core service types and utilities
export {
	TypedEmitter,
	type Service,
	type IndexStats as ServiceIndexStats,
	type IndexingEvents,
	type SlotEvents,
	type SearchEvents,
	type WatcherEvents,
	type WarmupEvents,
	type AllDaemonEvents,
} from './types.js';

// Storage service
export {
	Storage,
	type CodeChunk,
	type CachedEmbedding,
	type ChunkType,
	createCodeChunksSchema,
	createEmbeddingCacheSchema,
} from './storage/index.js';

// Search service
export {
	SearchEngine,
	vectorSearch,
	ftsSearch,
	ensureFtsIndex,
	hybridRerank,
	type SearchMode,
	type SearchResult,
	type SearchResults,
	type SearchOptions,
	type SearchFilters,
	type SearchDebugInfo,
} from './search/index.js';

// Indexing service
export {
	IndexingService,
	type IndexStats,
	type IndexOptions,
} from './indexing.js';

// Watcher service
export {FileWatcher, type WatcherStatus, type IndexTrigger} from './watcher.js';
