/**
 * Hybrid search combining vector and FTS with RRF reranking.
 */

import type {SearchResult} from './types.js';

/**
 * Reciprocal Rank Fusion (RRF) constant.
 * Higher values give more weight to lower-ranked results.
 */
const RRF_K = 60;

/**
 * Combine vector and FTS results using Reciprocal Rank Fusion.
 *
 * RRF formula: score = sum(1 / (k + rank))
 * where k is a constant (typically 60) and rank is 1-indexed.
 *
 * @param vectorResults - Results from vector search
 * @param ftsResults - Results from FTS search
 * @param limit - Maximum number of results to return
 * @param vectorWeight - Weight for vector results (0.0-1.0, default 0.7)
 * @returns Combined and reranked results
 */
export function hybridRerank(
	vectorResults: SearchResult[],
	ftsResults: SearchResult[],
	limit: number,
	vectorWeight: number = 0.7,
): SearchResult[] {
	const ftsWeight = 1 - vectorWeight;
	const scores = new Map<string, number>();
	const resultMap = new Map<string, SearchResult>();
	const vectorScores = new Map<string, number>();
	const ftsScoresMap = new Map<string, number>();

	// Score from vector results
	vectorResults.forEach((result, rank) => {
		const rrfScore = vectorWeight * (1 / (RRF_K + rank + 1));
		scores.set(result.id, (scores.get(result.id) ?? 0) + rrfScore);
		resultMap.set(result.id, result);
		vectorScores.set(result.id, result.vectorScore ?? result.score);
	});

	// Score from FTS results
	ftsResults.forEach((result, rank) => {
		const rrfScore = ftsWeight * (1 / (RRF_K + rank + 1));
		scores.set(result.id, (scores.get(result.id) ?? 0) + rrfScore);
		ftsScoresMap.set(result.id, result.ftsScore ?? result.score);

		// Keep the result with more info (prefer vector result if exists)
		if (!resultMap.has(result.id)) {
			resultMap.set(result.id, result);
		}
	});

	// Sort by combined RRF score and take top results
	const sortedIds = [...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([id]) => id);

	return sortedIds.map((id) => {
		const result = resultMap.get(id)!;
		return {
			...result,
			score: scores.get(id)!,
			vectorScore: vectorScores.get(id),
			ftsScore: ftsScoresMap.get(id),
		};
	});
}
