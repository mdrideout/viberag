import {Field, FixedSizeList, Float32, Int32, Schema, Utf8} from 'apache-arrow';
import {DEFAULT_EMBEDDING_DIMENSIONS} from '../constants.js';

/**
 * Arrow schema for the code_chunks table.
 *
 * Stores indexed code chunks with their embeddings.
 */
export function createCodeChunksSchema(
	dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Schema {
	return new Schema([
		new Field('id', new Utf8(), false), // "{filepath}:{startLine}"
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
