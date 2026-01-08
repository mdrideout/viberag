/**
 * Shared utilities for API-based embedding providers.
 * Provides common retry logic, rate limiting, and concurrency patterns.
 */

import pLimit from 'p-limit';

// ============================================================================
// Constants
// ============================================================================

/** Max concurrent API requests */
export const CONCURRENCY = 5;

/** Delay (ms) between batch completion and next batch start (per slot) */
export const BATCH_DELAY_MS = 200;

/** Max retry attempts on rate limit */
export const MAX_RETRIES = 12;

/** Initial backoff (ms) */
export const INITIAL_BACKOFF_MS = 1000;

/** Maximum backoff (ms) */
export const MAX_BACKOFF_MS = 60000;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep for a specified duration.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a rate limit error (429 or quota exceeded).
 */
export function isRateLimitError(error: unknown): boolean {
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		return msg.includes('429') || msg.includes('rate') || msg.includes('quota');
	}
	return false;
}

/**
 * Callbacks for rate limiting and progress reporting.
 */
export interface ApiProviderCallbacks {
	onThrottle?: (message: string | null) => void;
	onBatchProgress?: (processed: number, total: number) => void;
}

/**
 * Execute an async function with exponential backoff retry on rate limit errors.
 *
 * @param fn - The async function to execute
 * @param callbacks - Optional callbacks for throttle notifications
 * @returns The result of the function
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	callbacks?: ApiProviderCallbacks,
): Promise<T> {
	let attempt = 0;
	let backoffMs = INITIAL_BACKOFF_MS;

	while (true) {
		try {
			const result = await fn();
			// Clear throttle message on success (if was throttling)
			if (attempt > 0) callbacks?.onThrottle?.(null);
			return result;
		} catch (error) {
			if (isRateLimitError(error) && attempt < MAX_RETRIES) {
				attempt++;
				const secs = Math.round(backoffMs / 1000);
				callbacks?.onThrottle?.(
					`Rate limited - retry ${attempt}/${MAX_RETRIES} in ${secs}s`,
				);
				await sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
			} else {
				throw error;
			}
		}
	}
}

/**
 * Process batches with p-limit sliding window concurrency and inter-batch delay.
 * Reports progress per-batch (more granular than group-based).
 *
 * @param batches - Array of batches to process
 * @param processBatch - Function to process a single batch
 * @param callbacks - Optional callbacks for progress reporting
 * @returns Flattened array of results
 */
export async function processBatchesWithLimit<T>(
	batches: T[][],
	processBatch: (batch: T[]) => Promise<number[][]>,
	callbacks?: ApiProviderCallbacks,
): Promise<number[][]> {
	const limit = pLimit(CONCURRENCY);
	let processedItems = 0;
	const totalItems = batches.reduce((sum, batch) => sum + batch.length, 0);

	const batchResults = await Promise.all(
		batches.map(batch =>
			limit(async () => {
				const result = await processBatch(batch);
				// Delay before releasing the slot (rate limit protection)
				await sleep(BATCH_DELAY_MS);
				// Report progress per-batch
				processedItems += batch.length;
				callbacks?.onBatchProgress?.(processedItems, totalItems);
				return result;
			}),
		),
	);

	return batchResults.flat();
}

/**
 * Split an array into batches of a specified size.
 */
export function chunk<T>(array: T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		batches.push(array.slice(i, i + size));
	}
	return batches;
}
