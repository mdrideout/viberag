/**
 * Chunker Types - Types for tree-sitter code chunking.
 */

/**
 * Types of code chunks extracted by tree-sitter.
 */
export type ChunkType = 'function' | 'class' | 'method' | 'module';

/**
 * Ref kinds extracted from the AST for usage navigation.
 */
export type RefKind = 'import' | 'call' | 'identifier' | 'string_literal';

export type ExtractedRef = {
	ref_kind: RefKind;
	token_texts: string[];
	start_line: number;
	end_line: number;
	start_byte: number | null;
	end_byte: number | null;
	module_name: string | null;
	imported_name: string | null;
};

export type RefExtractionOptions = {
	/**
	 * Whether to emit identifier refs (best-effort) in addition to calls/imports.
	 *
	 * - all: emit all identifier nodes (can be large)
	 * - symbolish: only emit PascalCase / ALL_CAPS identifiers
	 * - none: do not emit identifier refs
	 */
	identifier_mode?: 'all' | 'symbolish' | 'none';
	/**
	 * If set, caps the number of refs per {ref_kind, token_texts[0]} per file.
	 * This cap is deterministic (keeps the first N occurrences in source order).
	 * Set to 0 to disable.
	 */
	max_occurrences_per_token?: number;
	/**
	 * If true, emit string_literal refs. (Typically redundant with symbol/chunk token facts.)
	 */
	include_string_literals?: boolean;
};

export type AnalyzedFile = {
	language: SupportedLanguage | null;
	parse_status: 'markdown' | 'unsupported' | 'parse_failed' | 'parsed';
	definition_chunks: Chunk[];
	chunks: Chunk[];
	refs: ExtractedRef[];
};

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
	/** Start byte offset in file (tree-sitter startIndex when available) */
	startByte: number | null;
	/** End byte offset in file (tree-sitter endIndex when available) */
	endByte: number | null;
	/** SHA256 hash of contextHeader + text */
	contentHash: string;
	// New in schema v2: deterministic AST-derived metadata
	/** Function/method signature line (null for module chunks) */
	signature: string | null;
	/** Extracted documentation (JSDoc, docstring, etc.) */
	docstring: string | null;
	/** Whether symbol has export modifier */
	isExported: boolean;
	/** Comma-separated decorator/annotation names (null if none) */
	decoratorNames: string | null;
	// Deterministic token facts (AST-derived when available)
	identifiers: string[];
	identifierParts: string[];
	calledNames: string[];
	stringLiterals: string[];
}

/**
 * Supported languages for tree-sitter parsing.
 */
export type SupportedLanguage =
	| 'python'
	| 'javascript'
	| 'typescript'
	| 'tsx'
	| 'go'
	| 'rust'
	| 'java'
	| 'csharp'
	| 'dart'
	| 'swift'
	| 'kotlin'
	| 'php';

/**
 * Map of file extensions to languages.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
	// JavaScript/TypeScript family
	'.js': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.ts': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.tsx': 'tsx',
	// Python
	'.py': 'python',
	// Go
	'.go': 'go',
	// Rust
	'.rs': 'rust',
	// Java
	'.java': 'java',
	// C#
	'.cs': 'csharp',
	// Dart
	'.dart': 'dart',
	// Swift
	'.swift': 'swift',
	// Kotlin
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	// PHP
	'.php': 'php',
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
 * Note: Slot progress is now managed via daemon state, not passed through callbacks.
 * @param current - Current progress count
 * @param total - Total items (0 for indeterminate)
 * @param stage - Human-readable stage name
 * @param throttleMessage - Rate limit message (shown in yellow) or null to clear
 * @param chunksProcessed - Number of chunks embedded so far
 */
export type ProgressCallback = (
	current: number,
	total: number,
	stage: string,
	throttleMessage?: string | null,
	chunksProcessed?: number,
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
