/**
 * Lazy Loader Service
 *
 * Provides lazy-loaded access to heavy RAG modules that have native dependencies.
 * These modules (Indexer, SearchEngine) load tree-sitter WASM and lancedb native bindings,
 * which takes ~500-1000ms. By loading them lazily, the MCP server can respond to
 * the initialize handshake immediately.
 *
 * Pattern: Singleton with memoization
 * Thread-safety: Safe - single-threaded Node.js environment
 */

import type {Indexer as IndexerType} from '../../rag/indexer/index.js';
import type {SearchEngine as SearchEngineType} from '../../rag/search/index.js';

// Memoized module references
let indexerModule: typeof import('../../rag/indexer/index.js') | null = null;
let searchModule: typeof import('../../rag/search/index.js') | null = null;

/**
 * Get the Indexer class, loading the module on first access.
 * Subsequent calls return the cached reference.
 */
export async function getIndexer(): Promise<typeof IndexerType> {
	if (!indexerModule) {
		indexerModule = await import('../../rag/indexer/index.js');
	}
	return indexerModule.Indexer;
}

/**
 * Get the SearchEngine class, loading the module on first access.
 * Subsequent calls return the cached reference.
 */
export async function getSearchEngine(): Promise<typeof SearchEngineType> {
	if (!searchModule) {
		searchModule = await import('../../rag/search/index.js');
	}
	return searchModule.SearchEngine;
}
