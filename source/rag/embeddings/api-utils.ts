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
 * Check if an error is a known transient API error that should be retried.
 *
 * GEMINI TRANSIENT BUG:
 * The Gemini API has a known server-side bug where it intermittently returns
 * a 400 "API key expired" error even when the key is valid. This is NOT an
 * actual authentication failure - it's a transient error that resolves on retry.
 *
 * Evidence:
 * - Users report: "if I try the same request again a few times, it usually works fine"
 * - New API keys don't fix it
 * - Same key works in curl but fails randomly via API clients
 * - Google has acknowledged this as a P1/P2 bug
 *
 * GitHub issues documenting this bug:
 * - https://github.com/google-gemini/gemini-cli/issues/4430
 * - https://github.com/google-gemini/gemini-cli/issues/1712
 * - https://github.com/google-gemini/gemini-cli/issues/8675
 *
 * We detect this specific error and retry it rather than failing immediately.
 */
export function isTransientApiError(error: unknown): boolean {
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();

		// Gemini transient "API key expired" bug (400 status)
		// The specific message is: "API key expired. Please renew the API key."
		// We check for this specific pattern to avoid retrying actual auth failures
		if (
			msg.includes('api key expired') &&
			(msg.includes('400') || msg.includes('invalid_argument'))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Check if an error should trigger a retry (rate limit OR transient error).
 */
export function isRetriableError(error: unknown): boolean {
	return isRateLimitError(error) || isTransientApiError(error);
}

/**
 * Callbacks for rate limiting and progress reporting.
 */
export interface ApiProviderCallbacks {
	onThrottle?: (message: string | null) => void;
	onBatchProgress?: (processed: number, total: number) => void;
}

/**
 * Execute an async function with exponential backoff retry on retriable errors.
 *
 * Retries on:
 * - Rate limit errors (429, quota exceeded)
 * - Transient API errors (e.g., Gemini's spurious "API key expired" bug)
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
			if (isRetriableError(error) && attempt < MAX_RETRIES) {
				attempt++;
				const secs = Math.round(backoffMs / 1000);

				// Provide context-appropriate message
				const isTransient = isTransientApiError(error);
				const reason = isTransient ? 'Transient API error' : 'Rate limited';

				callbacks?.onThrottle?.(
					`${reason} - retry ${attempt}/${MAX_RETRIES} in ${secs}s`,
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
