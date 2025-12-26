/**
 * RAG commands for the CLI.
 */

import {
	Indexer,
	SearchEngine,
	loadManifest,
	manifestExists,
	type IndexStats,
	type SearchResults,
} from '../../rag/index.js';

/**
 * Run the indexer and return stats.
 */
export async function runIndex(
	projectRoot: string,
	force: boolean = false,
	onProgress?: (message: string) => void,
): Promise<IndexStats> {
	const indexer = new Indexer(projectRoot);

	try {
		const stats = await indexer.index({
			force,
			progressCallback: (current, total, stage) => {
				onProgress?.(`${stage}: ${current}/${total}`);
			},
		});
		return stats;
	} finally {
		indexer.close();
	}
}

/**
 * Format index stats for display.
 */
export function formatIndexStats(stats: IndexStats): string {
	const lines = [
		'Index complete:',
		`  Files scanned: ${stats.filesScanned}`,
		`  New files: ${stats.filesNew}`,
		`  Modified files: ${stats.filesModified}`,
		`  Deleted files: ${stats.filesDeleted}`,
		`  Chunks added: ${stats.chunksAdded}`,
		`  Chunks deleted: ${stats.chunksDeleted}`,
		`  Embeddings computed: ${stats.embeddingsComputed}`,
		`  Embeddings cached: ${stats.embeddingsCached}`,
	];
	return lines.join('\n');
}

/**
 * Run a search query and return results.
 */
export async function runSearch(
	projectRoot: string,
	query: string,
	limit: number = 10,
): Promise<SearchResults> {
	const engine = new SearchEngine(projectRoot);

	try {
		return await engine.search(query, {limit});
	} finally {
		engine.close();
	}
}

/**
 * Format search results for display.
 */
export function formatSearchResults(results: SearchResults): string {
	if (results.results.length === 0) {
		return `No results found for "${results.query}" (${results.elapsedMs}ms)`;
	}

	const lines = [
		`Found ${results.results.length} results for "${results.query}" (${results.elapsedMs}ms):`,
		'',
	];

	for (const result of results.results) {
		const location = `${result.filepath}:${result.startLine}-${result.endLine}`;
		const name = result.name ? ` ${result.name}` : '';
		lines.push(`[${result.type}]${name}`);
		lines.push(`  ${location}`);
		lines.push(`  Score: ${result.score.toFixed(4)}`);

		// Show snippet (first 100 chars)
		const snippet = result.text.slice(0, 100).replace(/\n/g, ' ');
		lines.push(`  ${snippet}${result.text.length > 100 ? '...' : ''}`);
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Get index status.
 */
export async function getStatus(projectRoot: string): Promise<string> {
	if (!(await manifestExists(projectRoot))) {
		return 'No index found. Run /index to create one.';
	}

	const manifest = await loadManifest(projectRoot);
	const lines = [
		'Index status:',
		`  Version: ${manifest.version}`,
		`  Created: ${manifest.createdAt}`,
		`  Updated: ${manifest.updatedAt}`,
		`  Total files: ${manifest.stats.totalFiles}`,
		`  Total chunks: ${manifest.stats.totalChunks}`,
	];

	return lines.join('\n');
}
