/**
 * Full-text search (BM25) using LanceDB.
 */

import * as lancedb from '@lancedb/lancedb';
import type {Table} from '@lancedb/lancedb';
import type {CodeChunkRow} from '../storage/types.js';
import type {SearchResult} from './types.js';

/**
 * Ensure FTS index exists on the text column.
 * Creates the index if it doesn't exist.
 *
 * @param table - LanceDB table to index
 */
export async function ensureFtsIndex(table: Table): Promise<void> {
	const indices = await table.listIndices();
	const hasFtsIndex = indices.some(
		(idx) => idx.columns.includes('text') && idx.indexType === 'FTS',
	);

	if (!hasFtsIndex) {
		await table.createIndex('text', {
			config: lancedb.Index.fts(),
		});
	}
}

/**
 * Perform full-text search using BM25.
 *
 * @param table - LanceDB table to search
 * @param query - Search query string
 * @param limit - Maximum number of results
 * @returns Array of search results with FTS scores
 */
export async function ftsSearch(
	table: Table,
	query: string,
	limit: number,
): Promise<SearchResult[]> {
	// Ensure FTS index exists
	await ensureFtsIndex(table);

	const results = await table
		.search(query, 'fts')
		.limit(limit)
		.toArray();

	return results.map((row, index) => {
		const chunk = row as CodeChunkRow & {_score?: number};
		// BM25 score (higher is better)
		// Normalize by rank for consistent scoring
		const ftsScore = chunk._score ?? 1 / (index + 1);

		return {
			id: chunk.id,
			text: chunk.text,
			filepath: chunk.filepath,
			filename: chunk.filename,
			name: chunk.name,
			type: chunk.type,
			startLine: chunk.start_line,
			endLine: chunk.end_line,
			score: ftsScore,
			ftsScore,
		};
	});
}
