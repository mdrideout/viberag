/**
 * Arrow schemas for LanceDB tables.
 */

import {
	Field,
	FixedSizeList,
	Float32,
	Int32,
	Schema,
	Utf8,
	Bool,
} from 'apache-arrow';
import {
	DEFAULT_EMBEDDING_DIMENSIONS,
	SCHEMA_VERSION,
} from '../../lib/constants.js';

// Re-export for convenience
export {SCHEMA_VERSION};

/**
 * Arrow schema for the code_chunks table.
 *
 * Stores indexed code chunks with their embeddings.
 *
 * Schema v2 adds:
 * - signature: Function/method signature line
 * - docstring: Extracted documentation
 * - is_exported: Whether symbol is exported
 * - decorator_names: Comma-separated decorator names
 *
 * Schema v3 keeps the same fields but updates chunk IDs to avoid collisions.
 */
export function createCodeChunksSchema(
	dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Schema {
	return new Schema([
		new Field('id', new Utf8(), false), // "{filepath}:{startLine}-{endLine}:{contentHash}[:dupIndex]"
		new Field(
			'vector',
			new FixedSizeList(dimensions, new Field('item', new Float32(), false)),
			false,
		),
		new Field('text', new Utf8(), false),
		new Field('content_hash', new Utf8(), false),
		new Field('filepath', new Utf8(), false),
		new Field('filename', new Utf8(), false),
		new Field('extension', new Utf8(), false),
		new Field('type', new Utf8(), false), // function/class/method/module
		new Field('name', new Utf8(), false),
		new Field('start_line', new Int32(), false),
		new Field('end_line', new Int32(), false),
		new Field('file_hash', new Utf8(), false),
		// New in schema v2: deterministic AST-derived metadata
		new Field('signature', new Utf8(), true), // Function/class signature line (nullable)
		new Field('docstring', new Utf8(), true), // Extracted documentation (nullable)
		new Field('is_exported', new Bool(), false), // Has export modifier
		new Field('decorator_names', new Utf8(), true), // Comma-separated decorators (nullable)
	]);
}

/**
 * Arrow schema for the embedding_cache table.
 *
 * Content-addressed cache for embeddings to avoid recomputation.
 */
export function createEmbeddingCacheSchema(
	dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Schema {
	return new Schema([
		new Field('content_hash', new Utf8(), false), // Primary key
		new Field(
			'vector',
			new FixedSizeList(dimensions, new Field('item', new Float32(), false)),
			false,
		),
		new Field('created_at', new Utf8(), false), // ISO timestamp
	]);
}
