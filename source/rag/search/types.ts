/**
 * Search result types.
 */

/**
 * Search mode determines the search strategy.
 */
export type SearchMode =
	| 'semantic' // Dense vector search only
	| 'exact' // BM25/FTS only
	| 'hybrid' // Vector + BM25 with RRF (default)
	| 'definition' // Metadata filter: type + name match
	| 'similar'; // Vector search with code snippet as query

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
	/** Function/method signature (if available) */
	signature?: string | null;
	/** Whether symbol is exported */
	isExported?: boolean;
}

/**
 * Debug information for search quality evaluation.
 * Helps AI agents understand search effectiveness and tune parameters.
 */
export interface SearchDebugInfo {
	/** Maximum vector similarity score across results */
	maxVectorScore: number;
	/** Maximum FTS/BM25 score across results */
	maxFtsScore: number;
	/** BM25 weight requested by caller */
	requestedBm25Weight: number;
	/** Effective BM25 weight after auto-boost */
	effectiveBm25Weight: number;
	/** Whether auto-boost was applied */
	autoBoostApplied: boolean;
	/** Auto-boost threshold used */
	autoBoostThreshold: number;
	/** Number of results from vector search */
	vectorResultCount: number;
	/** Number of results from FTS search */
	ftsResultCount: number;
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
	searchType: SearchMode;
	/** Time taken in milliseconds */
	elapsedMs: number;
	/** Total matches (when exhaustive=true) */
	totalMatches?: number;
	/** Debug info for hybrid search (when return_debug=true) */
	debug?: SearchDebugInfo;
}

/**
 * Transparent, AI-controlled filters.
 * AI sees exactly what's being filtered.
 */
export interface SearchFilters {
	// Path-based filtering (replaces opaque categories)
	/** Scope to files starting with this path prefix (e.g., "src/api/") */
	pathPrefix?: string;
	/** Must contain ALL of these strings in path */
	pathContains?: string[];
	/** Must not contain ANY of these strings in path */
	pathNotContains?: string[];

	// Code structure filtering
	/** Filter by chunk type: function, class, method, module */
	type?: ('function' | 'class' | 'method' | 'module')[];
	/** Filter by file extension (e.g., [".ts", ".tsx"]) */
	extension?: string[];

	// Metadata filtering (Phase 1 fields)
	/** Only exported/public symbols */
	isExported?: boolean;
	/** Decorator name contains this string (e.g., "Get", "route") */
	decoratorContains?: string;
	/** Has documentation/docstring */
	hasDocstring?: boolean;
}

/**
 * Options for search operations.
 */
export interface SearchOptions {
	/** Search mode (default: 'hybrid') */
	mode?: SearchMode;
	/** Maximum number of results (default: 10) */
	limit?: number;
	/** Weight for BM25 in hybrid search (0.0-1.0, default: 0.3) */
	bm25Weight?: number;
	/** Return all matches above threshold (default: false) */
	exhaustive?: boolean;
	/** Minimum score threshold 0-1 (default: 0) */
	minScore?: number;
	/** Transparent filters */
	filters?: SearchFilters;
	/** Code snippet for 'similar' mode */
	codeSnippet?: string;
	/** Symbol name for 'definition' mode */
	symbolName?: string;
	/** Enable auto-boost of BM25 weight when vector scores are low (default: true) */
	autoBoost?: boolean;
	/** Vector score threshold below which auto-boost activates (default: 0.3) */
	autoBoostThreshold?: number;
	/** Include debug info in results (default: false) */
	returnDebug?: boolean;
}
