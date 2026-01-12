/**
 * Vector similarity search using LanceDB.
 */

import type {Table} from '@lancedb/lancedb';
import type {CodeChunkRow} from '../storage/types.js';
import type {SearchResult} from './types.js';

/**
 * Options for vector search.
 */
export interface VectorSearchOptions {
	/** Maximum number of results */
	limit: number;
	/** LanceDB WHERE clause filter */
	filterClause?: string;
	/** Minimum score threshold (0-1) */
	minScore?: number;
}

/**
 * Perform vector similarity search.
 *
 * @param table - LanceDB table to search
 * @param queryVector - Query embedding vector
 * @param options - Search options
 * @returns Array of search results with vector scores
 */
export async function vectorSearch(
	table: Table,
	queryVector: number[],
	options: VectorSearchOptions | number,
): Promise<SearchResult[]> {
	// Support legacy signature: vectorSearch(table, vector, limit)
	const opts: VectorSearchOptions =
		typeof options === 'number' ? {limit: options} : options;

	let query = table.search(queryVector).limit(opts.limit);

	// Apply filter if provided
	if (opts.filterClause) {
		query = query.where(opts.filterClause);
	}

	const results = await query.toArray();

	return results
		.map(row => {
			const chunk = row as CodeChunkRow & {_distance?: number};
			// LanceDB returns _distance (lower is better for L2/cosine)
			// Convert to similarity score (higher is better)
			const distance = chunk._distance ?? 0;
			const vectorScore = 1 / (1 + distance);

			return {
				id: chunk.id,
				text: chunk.text,
				filepath: chunk.filepath,
				filename: chunk.filename,
				name: chunk.name,
				type: chunk.type,
				startLine: chunk.start_line,
				endLine: chunk.end_line,
				score: vectorScore,
				vectorScore,
				signature: chunk.signature,
				isExported: chunk.is_exported,
			};
		})
		.filter(r => !opts.minScore || r.score >= opts.minScore);
}
