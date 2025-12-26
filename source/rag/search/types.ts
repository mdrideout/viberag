/**
 * Search result types.
 */

/**
 * A single search result.
 */
export interface SearchResult {
	/** Unique ID: "{filepath}:{startLine}" */
	id: string;
	/** Source code content */
	text: string;
	/** Relative file path */
	filepath: string;
	/** Just the filename */
	filename: string;
	/** Symbol name */
	name: string;
	/** Chunk type: function, class, method, or module */
	type: string;
	/** Start line number (1-indexed) */
	startLine: number;
	/** End line number (1-indexed) */
	endLine: number;
	/** Combined score (for hybrid search) */
	score: number;
	/** Vector similarity score (optional) */
	vectorScore?: number;
	/** FTS/BM25 score (optional) */
	ftsScore?: number;
}

/**
 * Collection of search results with metadata.
 */
export interface SearchResults {
	/** Array of search results */
	results: SearchResult[];
	/** Original search query */
	query: string;
	/** Type of search performed */
	searchType: 'vector' | 'fts' | 'hybrid';
	/** Time taken in milliseconds */
	elapsedMs: number;
}

/**
 * Options for search operations.
 */
export interface SearchOptions {
	/** Maximum number of results (default: 10) */
	limit?: number;
	/** Weight for BM25 in hybrid search (0.0-1.0, default: 0.3) */
	bm25Weight?: number;
}
