/**
 * Shared utilities for API-based embedding providers.
 *
 * Provides common retry logic, rate limiting, and concurrency patterns.
 * Uses callbacks for progress reporting instead of Redux dispatch.
 */

import pLimit from 'p-limit';
import type {Logger} from '../lib/logger.js';
import {CONCURRENCY} from '../lib/constants.js';

// Re-export for backward compatibility
export {CONCURRENCY};

// ============================================================================
// Constants
// ============================================================================

/** Delay (ms) between batch completion and next batch start (per slot) */
export const BATCH_DELAY_MS = 200;

/** Maximum attempts per batch (initial attempt + retries) */
export const MAX_ATTEMPTS = 10;

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
 *
 * Slot progress uses callbacks instead of Redux dispatch.
 * The daemon owner wires these callbacks to state updates.
 */
export interface ApiProviderCallbacks {
	onThrottle?: (message: string | null) => void;
	onBatchProgress?: (processed: number, total: number) => void;

	// Slot progress callbacks (replaces Redux dispatch)
	onSlotProcessing?: (index: number, batchInfo: string) => void;
	onSlotRateLimited?: (
		index: number,
		batchInfo: string,
		retryInfo: string,
	) => void;
	onSlotIdle?: (index: number) => void;
	onSlotFailure?: (data: {
		batchInfo: string;
		files: string[];
		chunkCount: number;
		error: string;
		timestamp: string;
	}) => void;
	onResetSlots?: () => void;
}

/**
 * Metadata for a batch of chunks, used for detailed failure logging.
 */
export interface BatchMetadata {
	/** File paths for chunks in this batch */
	filepaths: string[];
	/** Start/end lines per chunk */
	lineRanges: Array<{start: number; end: number}>;
	/** Text sizes per chunk (in characters) */
	sizes: number[];
}

/**
 * Execute an async function with exponential backoff retry on retriable errors.
 *
 * Retries on:
 * - Rate limit errors (429, quota exceeded)
 * - Transient API errors (e.g., Gemini's spurious "API key expired" bug)
 * - Any other error (best-effort retry)
 *
 * @param fn - The async function to execute
 * @param callbacks - Optional callbacks for throttle notifications
 * @param onRetrying - Optional callback when entering retry state
 * @returns The result of the function
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	callbacks?: ApiProviderCallbacks,
	onRetrying?: (retryInfo: string | null) => void,
): Promise<T> {
	let attempt = 0;
	let backoffMs = INITIAL_BACKOFF_MS;

	while (attempt < MAX_ATTEMPTS) {
		try {
			attempt++;
			const result = await fn();
			// Clear throttle message on success (if was throttling)
			if (attempt > 1) {
				callbacks?.onThrottle?.(null);
				onRetrying?.(null);
			}
			return result;
		} catch (error) {
			if (attempt >= MAX_ATTEMPTS) {
				throw error;
			}

			const secs = Math.round(backoffMs / 1000);
			const retryInfo = `retry ${attempt + 1}/${MAX_ATTEMPTS} in ${secs}s`;
			const isTransient = isTransientApiError(error);
			const isRateLimit = isRateLimitError(error);
			const reason = isRateLimit
				? 'Rate limited'
				: isTransient
					? 'Transient API error'
					: 'Error';

			callbacks?.onThrottle?.(`${reason} - ${retryInfo}`);
			onRetrying?.(retryInfo);

			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
		}
	}

	throw new Error('Max retry attempts exceeded');
}

/**
 * Process batches with p-limit sliding window concurrency and inter-batch delay.
 * Reports progress per-batch (more granular than group-based).
 *
 * Slot progress is reported via callbacks, which the daemon owner wires to state.
 * Each slot index (0 to CONCURRENCY-1) is reused as batches complete.
 *
 * When an error occurs, failures are logged
 * with detailed chunk metadata if provided.
 *
 * @param batches - Array of batches to process
 * @param processBatch - Function to process a single batch
 * @param callbacks - Optional callbacks for progress reporting
 * @param batchSize - Optional batch size for calculating chunk indices
 * @param batchMetadata - Optional metadata per batch for detailed failure logging
 * @param logger - Optional logger for debug output
 * @param chunkOffset - Optional offset for cumulative chunk numbering (default: 0)
 * @returns Flattened array of results (null entries for failed batches)
 */
export async function processBatchesWithLimit<T>(
	batches: T[][],
	processBatch: (
		batch: T[],
		onRetrying?: (retryInfo: string | null) => void,
	) => Promise<number[][]>,
	callbacks?: ApiProviderCallbacks,
	batchSize?: number,
	batchMetadata?: BatchMetadata[],
	logger?: Logger,
	chunkOffset: number = 0,
): Promise<Array<number[] | null>> {
	const limit = pLimit(CONCURRENCY);
	let processedItems = 0;
	const totalItems = batches.reduce((sum, batch) => sum + batch.length, 0);

	// Track which slot index to assign next (wraps around CONCURRENCY)
	let nextSlotIndex = 0;

	const batchResults = await Promise.all(
		batches.map((batch, batchIndex) =>
			limit(async () => {
				// Assign slot index (reuse slots as batches complete)
				const slotIndex = nextSlotIndex++ % CONCURRENCY;
				// Calculate cumulative chunk positions (with offset from prior batches)
				const startChunk =
					chunkOffset + batchIndex * (batchSize ?? batch.length) + 1;
				const endChunk = startChunk + batch.length - 1;
				const batchInfo = `chunks ${startChunk}-${endChunk}`;

				// Report slot as processing via callback
				callbacks?.onSlotProcessing?.(slotIndex, batchInfo);

				// Callback for when this slot enters retry state
				const onRetrying = (retryInfo: string | null) => {
					if (retryInfo) {
						callbacks?.onSlotRateLimited?.(slotIndex, batchInfo, retryInfo);
					} else {
						// Cleared - back to processing
						callbacks?.onSlotProcessing?.(slotIndex, batchInfo);
					}
				};

				try {
					const result = await processBatch(batch, onRetrying);

					// Delay before releasing the slot (rate limit protection)
					await sleep(BATCH_DELAY_MS);
					callbacks?.onSlotIdle?.(slotIndex);

					processedItems += batch.length;
					callbacks?.onBatchProgress?.(processedItems, totalItems);
					return result;
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					const batchMeta = batchMetadata?.[batchIndex];

					// Log to debug.log with full chunk context
					if (logger) {
						logger.error('api-utils', 'Batch failed after retries', {
							batchIndex,
							batchInfo,
							chunkCount: batch.length,
							files: batchMeta?.filepaths ?? [],
							lineRanges: batchMeta?.lineRanges ?? [],
							sizes: batchMeta?.sizes ?? [],
							error: errorMsg,
						} as unknown as Error);
					}

					// Report failure via callback
					callbacks?.onSlotFailure?.({
						batchInfo,
						files: batchMeta?.filepaths ?? [],
						chunkCount: batch.length,
						error: errorMsg,
						timestamp: new Date().toISOString(),
					});

					// Delay before releasing the slot (rate limit protection)
					await sleep(BATCH_DELAY_MS);
					callbacks?.onSlotIdle?.(slotIndex);

					processedItems += batch.length;
					callbacks?.onBatchProgress?.(processedItems, totalItems);

					return Array.from({length: batch.length}, () => null);
				}
			}),
		),
	);

	// Reset all slots when complete
	callbacks?.onResetSlots?.();

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
