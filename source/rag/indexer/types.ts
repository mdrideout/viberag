/**
 * Types of code chunks extracted by tree-sitter.
 */
export type ChunkType = 'function' | 'class' | 'method' | 'module';

/**
 * A raw code chunk extracted from a file before embedding.
 */
export interface Chunk {
	/** The source code text */
	text: string;
	/** Context header for embedding (e.g., "// File: path.ts, Class: Foo") */
	contextHeader: string;
	/** Type of chunk */
	type: ChunkType;
	/** Symbol name (empty for module chunks) */
	name: string;
	/** Start line number (1-indexed) */
	startLine: number;
	/** End line number (1-indexed) */
	endLine: number;
	/** SHA256 hash of contextHeader + text */
	contentHash: string;
}

/**
 * Supported languages for tree-sitter parsing.
 */
export type SupportedLanguage = 'python' | 'javascript' | 'typescript' | 'tsx';

/**
 * Map of file extensions to languages.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
	'.py': 'python',
	'.js': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.mts': 'typescript',
	'.cts': 'typescript',
};

/**
 * Statistics from indexing operations.
 */
export interface IndexStats {
	/** Number of files scanned */
	filesScanned: number;
	/** Number of new files indexed */
	filesNew: number;
	/** Number of modified files re-indexed */
	filesModified: number;
	/** Number of deleted files removed from index */
	filesDeleted: number;
	/** Number of chunks added */
	chunksAdded: number;
	/** Number of chunks deleted */
	chunksDeleted: number;
	/** Number of embeddings computed (cache miss) */
	embeddingsComputed: number;
	/** Number of embeddings retrieved from cache */
	embeddingsCached: number;
}

/**
 * Progress callback for indexing operations.
 */
export type ProgressCallback = (
	current: number,
	total: number,
	stage: string,
) => void;

/**
 * Create empty index stats.
 */
export function createEmptyIndexStats(): IndexStats {
	return {
		filesScanned: 0,
		filesNew: 0,
		filesModified: 0,
		filesDeleted: 0,
		chunksAdded: 0,
		chunksDeleted: 0,
		embeddingsComputed: 0,
		embeddingsCached: 0,
	};
}
