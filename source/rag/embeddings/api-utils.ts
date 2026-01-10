/**
 * Shared utilities for API-based embedding providers.
 * Provides common retry logic, rate limiting, and concurrency patterns.
 *
 * Slot progress is dispatched directly to the Redux store, eliminating
 * the callback chain and providing a single source of truth for UI state.
 */

import pLimit from 'p-limit';
import {store, SlotProgressActions} from '../../store/index.js';
import type {Logger} from '../logger/index.js';

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
 *
 * Note: Slot progress is now handled via Redux store dispatch,
 * not callbacks. Only throttle and batch progress use callbacks.
 */
export interface ApiProviderCallbacks {
	onThrottle?: (message: string | null) => void;
	onBatchProgress?: (processed: number, total: number) => void;
	/**
	 * When set to true, callbacks will be skipped.
	 * Used to prevent stale progress updates after an error occurs
	 * while other concurrent batches are still completing.
	 */
	aborted?: boolean;
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

	while (true) {
		try {
			const result = await fn();
			// Clear throttle message on success (if was throttling)
			// Skip if aborted (another batch failed)
			if (attempt > 0 && !callbacks?.aborted) {
				callbacks?.onThrottle?.(null);
				onRetrying?.(null);
			}
			return result;
		} catch (error) {
			if (isRetriableError(error) && attempt < MAX_RETRIES) {
				attempt++;
				const secs = Math.round(backoffMs / 1000);
				const retryInfo = `retry ${attempt}/${MAX_RETRIES} in ${secs}s`;

				// Provide context-appropriate message
				// Skip if aborted (another batch failed)
				if (!callbacks?.aborted) {
					const isTransient = isTransientApiError(error);
					const reason = isTransient ? 'Transient API error' : 'Rate limited';

					callbacks?.onThrottle?.(`${reason} - ${retryInfo}`);
					onRetrying?.(retryInfo);
				}
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
 * Slot progress is dispatched directly to the Redux store, providing a single
 * source of truth for UI state. Each slot index (0 to CONCURRENCY-1) is reused
 * as batches complete.
 *
 * When an error occurs, sets callbacks.aborted = true to prevent stale progress
 * updates from concurrent batches that are still completing. Failures are logged
 * with detailed chunk metadata if provided.
 *
 * @param batches - Array of batches to process
 * @param processBatch - Function to process a single batch
 * @param callbacks - Optional callbacks for progress reporting
 * @param batchSize - Optional batch size for calculating chunk indices
 * @param batchMetadata - Optional metadata per batch for detailed failure logging
 * @param logger - Optional logger for debug output
 * @param chunkOffset - Optional offset for cumulative chunk numbering (default: 0)
 * @returns Flattened array of results
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
): Promise<number[][]> {
	const limit = pLimit(CONCURRENCY);
	let processedItems = 0;
	const totalItems = batches.reduce((sum, batch) => sum + batch.length, 0);

	// Track which slot index to assign next (wraps around CONCURRENCY)
	let nextSlotIndex = 0;

	try {
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

					// Dispatch to Redux: mark slot as processing
					if (!callbacks?.aborted) {
						store.dispatch(
							SlotProgressActions.setSlotProcessing({
								index: slotIndex,
								batchInfo,
							}),
						);
					}

					// Callback for when this slot enters retry state
					const onRetrying = (retryInfo: string | null) => {
						if (callbacks?.aborted) return;
						if (retryInfo) {
							store.dispatch(
								SlotProgressActions.setSlotRateLimited({
									index: slotIndex,
									batchInfo,
									retryInfo,
								}),
							);
						} else {
							// Cleared - back to processing
							store.dispatch(
								SlotProgressActions.setSlotProcessing({
									index: slotIndex,
									batchInfo,
								}),
							);
						}
					};

					let result: number[][];
					try {
						result = await processBatch(batch, onRetrying);
					} catch (error) {
						// Log detailed failure info before re-throwing
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

						// Dispatch failure to Redux for UI visibility
						store.dispatch(
							SlotProgressActions.addFailure({
								batchInfo,
								files: batchMeta?.filepaths ?? [],
								chunkCount: batch.length,
								error: errorMsg,
								timestamp: new Date().toISOString(),
							}),
						);

						// Re-throw to trigger outer catch (abort and cleanup)
						throw error;
					}

					// Skip updates if aborted (another batch failed)
					if (callbacks?.aborted) {
						store.dispatch(SlotProgressActions.setSlotIdle(slotIndex));
						return result;
					}

					// Delay before releasing the slot (rate limit protection)
					await sleep(BATCH_DELAY_MS);

					// Dispatch to Redux: mark slot as idle
					store.dispatch(SlotProgressActions.setSlotIdle(slotIndex));

					// Report progress per-batch
					processedItems += batch.length;
					callbacks?.onBatchProgress?.(processedItems, totalItems);
					return result;
				}),
			),
		);

		// Reset all slots when complete
		store.dispatch(SlotProgressActions.resetSlots());

		return batchResults.flat();
	} catch (error) {
		// Set aborted flag to stop progress updates from other concurrent batches
		// that are still completing in the background
		if (callbacks) {
			callbacks.aborted = true;
		}
		// Reset slots on error
		store.dispatch(SlotProgressActions.resetSlots());
		throw error;
	}
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
