/**
 * RAG commands for the CLI.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {loadManifest, manifestExists} from '../../daemon/lib/manifest.js';
import {
	configExists,
	saveConfig,
	DEFAULT_CONFIG,
	PROVIDER_CONFIGS,
	type ViberagConfig,
} from '../../daemon/lib/config.js';
import {getViberagDir} from '../../daemon/lib/constants.js';
import type {
	DaemonStatusResponse,
	IndexStats,
	SearchResults,
	SlotState,
} from '../../client/types.js';
import {DaemonClient} from '../../client/index.js';
import type {InitWizardConfig} from '../../common/types.js';

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
 * With isReinit=true, shuts down daemon and deletes everything first.
 * Optionally reports progress for UI status updates.
 */
export async function runInit(
	projectRoot: string,
	isReinit: boolean = false,
	wizardConfig?: InitWizardConfig,
	onProgress?: (message: string) => void,
): Promise<string> {
	const viberagDir = getViberagDir(projectRoot);
	const isExisting = await configExists(projectRoot);

	// If reinit, shutdown daemon and delete entire .viberag directory first
	if (isReinit && isExisting) {
		onProgress?.('Stopping daemon');
		const client = new DaemonClient(projectRoot);
		try {
			if (await client.isRunning()) {
				await client.connect();
				await client.shutdown('reinit');
				// Wait for daemon to exit
				await new Promise(r => setTimeout(r, 500));
			}
		} catch {
			// Ignore errors - daemon may not be running
		} finally {
			await client.disconnect();
		}
		onProgress?.('Removing .viberag');
		await fs.rm(viberagDir, {recursive: true, force: true});
	}

	// Create .viberag directory
	onProgress?.('Creating .viberag');
	await fs.mkdir(viberagDir, {recursive: true});

	// Build config from wizard choices
	const provider = wizardConfig?.provider ?? 'gemini';
	const {model, dimensions} = PROVIDER_CONFIGS[provider];

	// Map OpenAI region to base URL
	const openaiBaseUrl = wizardConfig?.openaiRegion
		? {
				default: undefined,
				us: 'https://us.api.openai.com/v1',
				eu: 'https://eu.api.openai.com/v1',
			}[wizardConfig.openaiRegion]
		: undefined;

	const config: ViberagConfig = {
		...DEFAULT_CONFIG,
		embeddingProvider: provider,
		embeddingModel: model,
		embeddingDimensions: dimensions,
		...(wizardConfig?.apiKey && {apiKey: wizardConfig.apiKey}),
		...(openaiBaseUrl && {openaiBaseUrl}),
	};

	// Save config
	onProgress?.('Writing config');
	await saveConfig(projectRoot, config);

	// Add .viberag/ to .gitignore if not present
	const gitignorePath = path.join(projectRoot, '.gitignore');
	onProgress?.('Updating .gitignore');
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
	const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
	return `${action} Viberag in ${viberagDir}\nProvider: ${providerLabel}\nModel: ${model} (${dimensions}d)\nRun /index to build the code index.`;
}

/**
 * Run the indexer and return stats.
 * Delegates to daemon which handles dimension sync internally.
 *
 * Note: Indexing starts asynchronously; completion is detected via status polling.
 */
export async function runIndex(
	projectRoot: string,
	force: boolean = false,
): Promise<IndexStats | null> {
	const client = new DaemonClient(projectRoot);

	try {
		await client.connect();
		const initialStatus = await client.status();
		const previousCompletion = initialStatus.indexing.lastCompleted;
		const previousCancellation = initialStatus.indexing.lastCancelled;

		await client.indexAsync({force});
		return await waitForIndexCompletion(
			client,
			previousCompletion,
			previousCancellation,
		);
	} finally {
		await client.disconnect();
	}
}

/**
 * Poll daemon status until a new index completion is observed.
 */
async function waitForIndexCompletion(
	client: DaemonClient,
	previousLastCompleted: string | null,
	previousLastCancelled: string | null,
): Promise<IndexStats | null> {
	const pollIntervalMs = 500;
	const statsGraceMs = 5000;
	let completionDetectedAt: number | null = null;

	for (;;) {
		const status = await client.status();

		if (status.indexing.status === 'error') {
			throw new Error(status.indexing.error ?? 'Index failed');
		}
		if (
			status.indexing.status === 'cancelled' ||
			(status.indexing.lastCancelled &&
				status.indexing.lastCancelled !== previousLastCancelled)
		) {
			throw new Error('Indexing cancelled');
		}

		const lastCompleted = status.indexing.lastCompleted;
		if (lastCompleted && lastCompleted !== previousLastCompleted) {
			if (status.indexing.lastStats) {
				return status.indexing.lastStats;
			}

			if (completionDetectedAt === null) {
				completionDetectedAt = Date.now();
			} else if (Date.now() - completionDetectedAt > statsGraceMs) {
				return null;
			}
		}

		await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
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
 * Delegates to daemon for search.
 */
export async function runSearch(
	projectRoot: string,
	query: string,
	limit: number = 10,
): Promise<SearchResults> {
	const client = new DaemonClient(projectRoot);

	try {
		await client.connect();
		return await client.search(query, {limit});
	} finally {
		await client.disconnect();
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
	const client = new DaemonClient({
		projectRoot,
		autoStart: false,
	});

	let daemonStatus: DaemonStatusResponse | null = null;
	let daemonError: string | null = null;

	try {
		if (await client.isRunning()) {
			await client.connect();
			daemonStatus = await client.status();
		}
	} catch (error) {
		daemonError = error instanceof Error ? error.message : String(error);
	} finally {
		await client.disconnect();
	}

	if (daemonStatus) {
		return formatDaemonStatus(daemonStatus);
	}

	const manifestStatus = await formatManifestStatus(projectRoot);
	if (daemonError) {
		return `${manifestStatus}\nDaemon status unavailable: ${daemonError}`;
	}
	return manifestStatus;
}

async function formatManifestStatus(projectRoot: string): Promise<string> {
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
	const failedFiles = manifest.failedFiles ?? [];
	const failedBatches = manifest.failedBatches ?? [];
	if (failedFiles.length > 0 || failedBatches.length > 0) {
		lines.push(`  Failed files: ${failedFiles.length}`);
		lines.push(`  Failed batches: ${failedBatches.length}`);
	}

	return lines.join('\n');
}

function formatDaemonStatus(status: DaemonStatusResponse): string {
	const lines: string[] = ['Daemon status:'];

	lines.push(`  Initialized: ${status.initialized ? 'yes' : 'no'}`);
	if (status.indexed) {
		lines.push(
			`  Index: ${status.totalFiles ?? 0} files · ${status.totalChunks ?? 0} chunks`,
		);
		if (status.updatedAt) {
			lines.push(`  Updated: ${status.updatedAt}`);
		}
	} else {
		lines.push('  Index: not indexed');
	}

	const warmupElapsed =
		status.warmupElapsedMs !== undefined
			? formatDurationSeconds(Math.round(status.warmupElapsedMs / 1000))
			: null;
	const warmupParts = [status.warmupStatus];
	if (warmupElapsed) {
		warmupParts.push(warmupElapsed);
	}
	if (status.warmupCancelReason) {
		warmupParts.push(`cancel: ${status.warmupCancelReason}`);
	}
	lines.push(`  Warmup: ${warmupParts.join(' · ')}`);

	const indexing = status.indexing;
	const indexingParts: string[] = [indexing.status];
	if (indexing.phase) {
		indexingParts.push(indexing.phase);
	}
	if (indexing.stage) {
		indexingParts.push(indexing.stage);
	}
	if (indexing.total > 0 && indexing.unit) {
		indexingParts.push(
			`${indexing.current}/${indexing.total} ${indexing.unit}`,
		);
	}
	if (indexing.percent > 0) {
		indexingParts.push(`${indexing.percent}%`);
	}
	if (
		indexing.secondsSinceProgress !== null &&
		(indexing.status === 'initializing' ||
			indexing.status === 'indexing' ||
			indexing.status === 'cancelling')
	) {
		indexingParts.push(
			`last progress ${formatDurationSeconds(indexing.secondsSinceProgress)} ago`,
		);
	}
	if (indexing.throttleMessage) {
		indexingParts.push(`throttle: ${indexing.throttleMessage}`);
	}
	if (indexing.cancelReason && indexing.status !== 'idle') {
		indexingParts.push(`cancel: ${indexing.cancelReason}`);
	}
	lines.push(`  Indexing: ${indexingParts.join(' · ')}`);

	const slotSummary = summarizeSlots(status.slots);
	if (slotSummary) {
		lines.push(`  Slots: ${slotSummary}`);
	}

	if (status.failures.length > 0) {
		lines.push(
			`  Failures: ${status.failures.length} batch(es) - see .viberag/logs/indexer/`,
		);
	}

	const watcher = status.watcherStatus;
	const watcherParts = [
		watcher.watching ? 'watching' : 'stopped',
		`${watcher.filesWatched} files`,
		`${watcher.pendingChanges} pending`,
	];
	if (watcher.autoIndexPausedUntil) {
		const remainingMs =
			new Date(watcher.autoIndexPausedUntil).getTime() - Date.now();
		const remainingSeconds = Math.max(0, Math.round(remainingMs / 1000));
		let pauseLabel = 'auto-index paused';
		if (remainingSeconds > 0) {
			pauseLabel += ` ${formatDurationSeconds(remainingSeconds)}`;
		}
		if (watcher.autoIndexPauseReason) {
			pauseLabel += ` (${watcher.autoIndexPauseReason})`;
		}
		watcherParts.push(pauseLabel);
	}
	lines.push(`  Watcher: ${watcherParts.join(' · ')}`);

	return lines.join('\n');
}

function formatDurationSeconds(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	if (seconds < 3600) {
		return `${Math.round(seconds / 60)}m`;
	}
	return `${Math.round(seconds / 3600)}h`;
}

function summarizeSlots(slots: SlotState[]): string | null {
	const counts = slots.reduce(
		(acc, slot) => {
			acc[slot.state] += 1;
			return acc;
		},
		{idle: 0, processing: 0, 'rate-limited': 0},
	);

	if (counts.processing === 0 && counts['rate-limited'] === 0) {
		return null;
	}

	const parts: string[] = [];
	if (counts.processing > 0) {
		parts.push(`${counts.processing} processing`);
	}
	if (counts['rate-limited'] > 0) {
		parts.push(`${counts['rate-limited']} rate-limited`);
	}
	return parts.join(', ');
}

/**
 * Cancel indexing or warmup.
 */
export async function cancelActivity(
	projectRoot: string,
	target?: string,
): Promise<string> {
	const client = new DaemonClient({
		projectRoot,
		autoStart: false,
	});

	try {
		if (!(await client.isRunning())) {
			return 'Daemon is not running. Nothing to cancel.';
		}

		await client.connect();
		const normalizedTarget = normalizeCancelTarget(target);
		const response = await client.cancel({
			target: normalizedTarget,
			reason: 'cli',
		});
		return response.message;
	} finally {
		await client.disconnect();
	}
}

function normalizeCancelTarget(target?: string): 'indexing' | 'warmup' | 'all' {
	const value = (target ?? '').trim().toLowerCase();
	if (value === 'index' || value === 'indexing') {
		return 'indexing';
	}
	if (value === 'warmup' || value === 'init' || value === 'initialize') {
		return 'warmup';
	}
	if (value === 'all' || value === '') {
		return 'all';
	}
	return 'all';
}

/**
 * Clean/uninstall Viberag from a project.
 * Shuts down daemon first, then removes the entire .viberag/ directory.
 */
export async function runClean(projectRoot: string): Promise<string> {
	const viberagDir = getViberagDir(projectRoot);
	const exists = await configExists(projectRoot);

	if (!exists) {
		return 'Viberag is not initialized in this project. Nothing to clean.';
	}

	// Shutdown daemon if running
	const client = new DaemonClient(projectRoot);
	try {
		if (await client.isRunning()) {
			await client.connect();
			await client.shutdown('clean');
			// Wait for daemon to exit
			await new Promise(r => setTimeout(r, 500));
		}
	} catch {
		// Ignore errors - daemon may not be running
	} finally {
		await client.disconnect();
	}

	await fs.rm(viberagDir, {recursive: true, force: true});
	return `Removed ${viberagDir}\nViberag has been uninstalled from this project.\nRun /init to reinitialize.`;
}

/**
 * Get MCP setup instructions for Claude Code.
 */
export function getMcpSetupInstructions(): string {
	return `To add VibeRAG to Claude Code, run:

  claude mcp add viberag -- npx viberag-mcp

This registers VibeRAG as an MCP server. After adding:

1. Restart Claude Code (or run: claude mcp restart viberag)
2. The following tools will be available:
   - codebase_search          Search the codebase semantically
   - codebase_parallel_search  Run multiple searches in parallel
   - viberag_index             Index or reindex the codebase
   - viberag_status            Get index statistics
   - viberag_cancel            Cancel indexing or warmup

Note: The project must be initialized first (run /init in the CLI).
The MCP server uses the current working directory as the project root.`;
}
