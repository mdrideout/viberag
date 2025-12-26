/**
 * Types of code chunks extracted by tree-sitter.
 */
export type ChunkType = 'function' | 'class' | 'method' | 'module';

/**
 * A code chunk stored in LanceDB.
 * Represents a semantic unit of code (function, class, method, or module).
 */
export interface CodeChunk {
	/** Unique ID: "{filepath}:{startLine}" */
	id: string;
	/** Embedding vector (768 dimensions for BGE-base-en-v1.5) */
	vector: number[];
	/** Source code content */
	text: string;
	/** SHA256 hash of the text content */
	contentHash: string;
	/** Relative file path from project root */
	filepath: string;
	/** Just the filename (e.g., "utils.py") */
	filename: string;
	/** File extension (e.g., ".py") */
	extension: string;
	/** Chunk type: function, class, method, or module */
	type: ChunkType;
	/** Symbol name (empty for module chunks) */
	name: string;
	/** Start line number (1-indexed) */
	startLine: number;
	/** End line number (1-indexed) */
	endLine: number;
	/** SHA256 hash of the entire source file */
	fileHash: string;
}

/**
 * Row format for LanceDB code_chunks table.
 * Uses snake_case to match Arrow/LanceDB conventions.
 */
export interface CodeChunkRow {
	id: string;
	vector: number[];
	text: string;
	content_hash: string;
	filepath: string;
	filename: string;
	extension: string;
	type: string;
	name: string;
	start_line: number;
	end_line: number;
	file_hash: string;
}

/**
 * A cached embedding stored in LanceDB.
 * Content-addressed by the hash of the text.
 */
export interface CachedEmbedding {
	/** SHA256 hash of the text content (primary key) */
	contentHash: string;
	/** Embedding vector */
	vector: number[];
	/** ISO timestamp when cached */
	createdAt: string;
}

/**
 * Row format for LanceDB embedding_cache table.
 */
export interface CachedEmbeddingRow {
	content_hash: string;
	vector: number[];
	created_at: string;
}

/**
 * Convert a CodeChunk to a LanceDB row format.
 */
export function chunkToRow(chunk: CodeChunk): CodeChunkRow {
	return {
		id: chunk.id,
		vector: chunk.vector,
		text: chunk.text,
		content_hash: chunk.contentHash,
		filepath: chunk.filepath,
		filename: chunk.filename,
		extension: chunk.extension,
		type: chunk.type,
		name: chunk.name,
		start_line: chunk.startLine,
		end_line: chunk.endLine,
		file_hash: chunk.fileHash,
	};
}

/**
 * Convert a LanceDB row to a CodeChunk.
 */
export function rowToChunk(row: CodeChunkRow): CodeChunk {
	return {
		id: row.id,
		vector: row.vector,
		text: row.text,
		contentHash: row.content_hash,
		filepath: row.filepath,
		filename: row.filename,
		extension: row.extension,
		type: row.type as ChunkType,
		name: row.name,
		startLine: row.start_line,
		endLine: row.end_line,
		fileHash: row.file_hash,
	};
}

/**
 * Convert a CachedEmbedding to a LanceDB row format.
 */
export function embeddingToRow(embedding: CachedEmbedding): CachedEmbeddingRow {
	return {
		content_hash: embedding.contentHash,
		vector: embedding.vector,
		created_at: embedding.createdAt,
	};
}

/**
 * Convert a LanceDB row to a CachedEmbedding.
 */
export function rowToEmbedding(row: CachedEmbeddingRow): CachedEmbedding {
	return {
		contentHash: row.content_hash,
		vector: row.vector,
		createdAt: row.created_at,
	};
}
