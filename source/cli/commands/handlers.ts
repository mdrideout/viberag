/**
 * RAG commands for the CLI.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {
	Indexer,
	SearchEngine,
	loadManifest,
	manifestExists,
	configExists,
	saveConfig,
	DEFAULT_CONFIG,
	getViberagDir,
	type IndexStats,
	type SearchResults,
} from '../../rag/index.js';

/**
 * Index display stats type (re-exported for convenience).
 */
export type IndexDisplayStats = {
	totalFiles: number;
	totalChunks: number;
};

/**
 * Check if project is initialized.
 */
export async function checkInitialized(projectRoot: string): Promise<boolean> {
	return configExists(projectRoot);
}

/**
 * Load index stats for display in status bar.
 */
export async function loadIndexStats(
	projectRoot: string,
): Promise<IndexDisplayStats | null> {
	if (!(await manifestExists(projectRoot))) {
		return null;
	}
	const manifest = await loadManifest(projectRoot);
	return {
		totalFiles: manifest.stats.totalFiles,
		totalChunks: manifest.stats.totalChunks,
	};
}

/**
 * Initialize a project for Viberag.
 * Creates .viberag/ directory with config.json.
 * With force=true, deletes everything and starts fresh.
 */
export async function runInit(
	projectRoot: string,
	force: boolean = false,
): Promise<string> {
	const viberagDir = getViberagDir(projectRoot);
	const isExisting = await configExists(projectRoot);

	if (isExisting && !force) {
		return 'Already initialized. Use /init --force to reinitialize.';
	}

	// If force, delete entire .viberag directory first
	if (force && isExisting) {
		await fs.rm(viberagDir, {recursive: true, force: true});
	}

	// Create .viberag directory
	await fs.mkdir(viberagDir, {recursive: true});

	// Save default config
	await saveConfig(projectRoot, DEFAULT_CONFIG);

	// Add .viberag/ to .gitignore if not present
	const gitignorePath = path.join(projectRoot, '.gitignore');
	try {
		const content = await fs.readFile(gitignorePath, 'utf-8');
		if (!content.includes('.viberag')) {
			await fs.appendFile(gitignorePath, '\n# Viberag index\n.viberag/\n');
		}
	} catch {
		// .gitignore doesn't exist, create it
		await fs.writeFile(gitignorePath, '# Viberag index\n.viberag/\n');
	}

	const action = isExisting ? 'Reinitialized' : 'Initialized';
	return `${action} Viberag in ${viberagDir}\nRun /index to build the code index.`;
}

/**
 * Run the indexer and return stats.
 */
export async function runIndex(
	projectRoot: string,
	force: boolean = false,
	onProgress?: (current: number, total: number, stage: string) => void,
): Promise<IndexStats> {
	const indexer = new Indexer(projectRoot);

	try {
		const stats = await indexer.index({
			force,
			progressCallback: onProgress,
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
 * Color mapping for chunk types.
 */
const TYPE_COLORS: Record<string, (s: string) => string> = {
	function: chalk.cyan,
	class: chalk.magenta,
	method: chalk.blue,
	module: chalk.dim,
};

/**
 * Get score color based on value.
 */
function getScoreColor(score: number): (s: string) => string {
	if (score > 0.8) return chalk.green;
	if (score > 0.5) return chalk.yellow;
	return chalk.red;
}

/**
 * Format search results for display with colors.
 */
export function formatSearchResults(results: SearchResults): string {
	if (results.results.length === 0) {
		return chalk.dim(
			`No results found for "${results.query}" (${results.elapsedMs}ms)`,
		);
	}

	const lines = [
		chalk.bold(`Found ${results.results.length} results for `) +
			chalk.cyan(`"${results.query}"`) +
			chalk.dim(` (${results.elapsedMs}ms):`),
		'',
	];

	for (const result of results.results) {
		const typeColor = TYPE_COLORS[result.type] ?? chalk.white;
		const scoreColor = getScoreColor(result.score);

		// Type badge and name
		lines.push(
			typeColor(`[${result.type}]`) +
				(result.name ? ` ${chalk.white(result.name)}` : ''),
		);

		// File path and line numbers
		lines.push(
			`  ${chalk.green(result.filepath)}` +
				chalk.dim(`:${result.startLine}-${result.endLine}`),
		);

		// Score
		lines.push(`  Score: ${scoreColor(result.score.toFixed(4))}`);

		// Snippet (first 100 chars, dimmed)
		const snippet = result.text.slice(0, 100).replace(/\n/g, ' ');
		lines.push(
			chalk.dim(`  ${snippet}${result.text.length > 100 ? '...' : ''}`),
		);
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
