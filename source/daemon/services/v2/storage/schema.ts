/**
 * V2 Arrow schemas for LanceDB tables.
 *
 * V2 stores multiple entity tables (symbols, chunks, files) instead of treating
 * raw chunks as the primary retrieval product.
 */

import {
	Bool,
	Field,
	FixedSizeList,
	Float32,
	Int32,
	Schema,
	Utf8,
	List,
} from 'apache-arrow';

/**
 * Arrow schema for the v2_symbols table.
 */
export function createV2SymbolsSchema(dimensions: number): Schema {
	return new Schema([
		// Identity / location
		new Field('symbol_id', new Utf8(), false),
		new Field('repo_id', new Utf8(), false),
		new Field('revision', new Utf8(), false),
		new Field('file_path', new Utf8(), false),
		new Field('extension', new Utf8(), false),
		new Field('language_hint', new Utf8(), true),
		new Field('start_line', new Int32(), false),
		new Field('end_line', new Int32(), false),
		new Field('start_byte', new Int32(), true),
		new Field('end_byte', new Int32(), true),

		// Symbol facts
		new Field('symbol_kind', new Utf8(), false),
		new Field('symbol_name', new Utf8(), false),
		new Field('qualname', new Utf8(), false),
		new Field('parent_symbol_id', new Utf8(), true),
		new Field('signature', new Utf8(), true),
		new Field('docstring', new Utf8(), true),
		new Field('is_exported', new Bool(), false),
		new Field(
			'decorator_names',
			new List(new Field('item', new Utf8(), false)),
			false,
		),

		// Search surfaces
		new Field('context_header', new Utf8(), false),
		new Field('code_text', new Utf8(), false),
		new Field('search_text', new Utf8(), false),

		// Token facts
		new Field('identifiers_text', new Utf8(), false),
		new Field(
			'identifiers',
			new List(new Field('item', new Utf8(), false)),
			false,
		),
		new Field(
			'identifier_parts',
			new List(new Field('item', new Utf8(), false)),
			false,
		),
		new Field(
			'called_names',
			new List(new Field('item', new Utf8(), false)),
			false,
		),
		new Field(
			'string_literals',
			new List(new Field('item', new Utf8(), false)),
			false,
		),

		// Hashes
		new Field('content_hash', new Utf8(), false),
		new Field('file_hash', new Utf8(), false),

		// Vectors
		new Field(
			'vec_summary',
			new FixedSizeList(dimensions, new Field('item', new Float32(), false)),
			false,
		),
	]);
}

/**
 * Arrow schema for the v2_chunks table.
 */
export function createV2ChunksSchema(dimensions: number): Schema {
	return new Schema([
		// Identity / location
		new Field('chunk_id', new Utf8(), false),
		new Field('repo_id', new Utf8(), false),
		new Field('revision', new Utf8(), false),
		new Field('file_path', new Utf8(), false),
		new Field('extension', new Utf8(), false),
		new Field('start_line', new Int32(), false),
		new Field('end_line', new Int32(), false),
		new Field('start_byte', new Int32(), true),
		new Field('end_byte', new Int32(), true),

		new Field('owner_symbol_id', new Utf8(), true),
		new Field('chunk_kind', new Utf8(), false),

		// Surfaces
		new Field('context_header', new Utf8(), false),
		new Field('code_text', new Utf8(), false),
		new Field('search_text', new Utf8(), false),

		// Token facts
		new Field('identifiers_text', new Utf8(), false),
		new Field(
			'identifiers',
			new List(new Field('item', new Utf8(), false)),
			false,
		),
		new Field(
			'identifier_parts',
			new List(new Field('item', new Utf8(), false)),
			false,
		),
		new Field(
			'called_names',
			new List(new Field('item', new Utf8(), false)),
			false,
		),
		new Field(
			'string_literals',
			new List(new Field('item', new Utf8(), false)),
			false,
		),

		// Hashes
		new Field('content_hash', new Utf8(), false),
		new Field('file_hash', new Utf8(), false),

		// Vectors
		new Field(
			'vec_code',
			new FixedSizeList(dimensions, new Field('item', new Float32(), false)),
			false,
		),
	]);
}

/**
 * Arrow schema for the v2_files table.
 */
export function createV2FilesSchema(dimensions: number): Schema {
	return new Schema([
		new Field('file_id', new Utf8(), false),
		new Field('repo_id', new Utf8(), false),
		new Field('revision', new Utf8(), false),
		new Field('file_path', new Utf8(), false),
		new Field('extension', new Utf8(), false),
		new Field('file_hash', new Utf8(), false),

		new Field('imports', new List(new Field('item', new Utf8(), false)), false),
		new Field('exports', new List(new Field('item', new Utf8(), false)), false),
		new Field('top_level_doc', new Utf8(), true),

		new Field('file_summary_text', new Utf8(), false),
		new Field(
			'vec_file',
			new FixedSizeList(dimensions, new Field('item', new Float32(), false)),
			false,
		),
	]);
}

/**
 * Arrow schema for the v2_embedding_cache table.
 *
 * Cache key is the sha256 hash of the embedding input string.
 */
export function createV2EmbeddingCacheSchema(dimensions: number): Schema {
	return new Schema([
		new Field('input_hash', new Utf8(), false),
		new Field(
			'vector',
			new FixedSizeList(dimensions, new Field('item', new Float32(), false)),
			false,
		),
		new Field('created_at', new Utf8(), false),
	]);
}

/**
 * Arrow schema for the v2_refs table.
 *
 * This table stores fact occurrences (imports/calls/identifiers/string literals)
 * as stable, queryable spans.
 */
export function createV2RefsSchema(): Schema {
	return new Schema([
		new Field('ref_id', new Utf8(), false),
		new Field('repo_id', new Utf8(), false),
		new Field('revision', new Utf8(), false),
		new Field('file_path', new Utf8(), false),
		new Field('extension', new Utf8(), false),
		new Field('start_line', new Int32(), false),
		new Field('end_line', new Int32(), false),
		new Field('start_byte', new Int32(), true),
		new Field('end_byte', new Int32(), true),
		new Field('ref_kind', new Utf8(), false),
		new Field('token_text', new Utf8(), false),
		new Field('context_snippet', new Utf8(), false),
		new Field('module_name', new Utf8(), true),
		new Field('imported_name', new Utf8(), true),
	]);
}
