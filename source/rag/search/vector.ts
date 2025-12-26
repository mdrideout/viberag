/**
 * Vector similarity search using LanceDB.
 */

import type {Table} from '@lancedb/lancedb';
import type {CodeChunkRow} from '../storage/types.js';
import type {SearchResult} from './types.js';

/**
 * Perform vector similarity search.
 *
 * @param table - LanceDB table to search
 * @param queryVector - Query embedding vector
 * @param limit - Maximum number of results
 * @returns Array of search results with vector scores
 */
export async function vectorSearch(
	table: Table,
	queryVector: number[],
	limit: number,
): Promise<SearchResult[]> {
	const results = await table.search(queryVector).limit(limit).toArray();

	return results.map(row => {
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
		};
	});
}
