/**
 * Full-text search (BM25) using LanceDB.
 */

import * as lancedb from '@lancedb/lancedb';
import type {Table} from '@lancedb/lancedb';
import type {CodeChunkRow} from '../storage/types.js';
import type {SearchResult} from './types.js';

/**
 * Options for FTS search.
 */
export interface FtsSearchOptions {
	/** Maximum number of results */
	limit: number;
	/** LanceDB WHERE clause filter */
	filterClause?: string;
	/** Minimum score threshold (0-1) */
	minScore?: number;
}

/**
 * Ensure FTS index exists on the text column.
 * Creates the index if it doesn't exist.
 *
 * @param table - LanceDB table to index
 */
export async function ensureFtsIndex(table: Table): Promise<void> {
	const indices = await table.listIndices();
	const hasFtsIndex = indices.some(
		idx => idx.columns.includes('text') && idx.indexType === 'FTS',
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
 * @param options - Search options
 * @returns Array of search results with FTS scores
 */
export async function ftsSearch(
	table: Table,
	query: string,
	options: FtsSearchOptions | number,
): Promise<SearchResult[]> {
	// Support legacy signature: ftsSearch(table, query, limit)
	const opts: FtsSearchOptions =
		typeof options === 'number' ? {limit: options} : options;

	// Ensure FTS index exists
	await ensureFtsIndex(table);

	let searchQuery = table.search(query, 'fts').limit(opts.limit);

	// Apply filter if provided
	if (opts.filterClause) {
		searchQuery = searchQuery.where(opts.filterClause);
	}

	const results = await searchQuery.toArray();

	return results
		.map((row, index) => {
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
				signature: chunk.signature,
				isExported: chunk.is_exported,
			};
		})
		.filter(r => !opts.minScore || r.score >= opts.minScore);
}
