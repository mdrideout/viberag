/**
 * Shared utilities for API-based embedding providers.
 *
 * Provides common retry logic, rate limiting, and concurrency patterns.
 * Uses callbacks for progress reporting instead of Redux dispatch.
 */

import pLimit from 'p-limit';
import type {Logger} from '../lib/logger.js';
import {CONCURRENCY} from '../lib/constants.js';
import {createAbortError, isAbortError, throwIfAborted} from '../lib/abort.js';

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
 * Sleep for a specified duration with optional abort support.
 */
export function sleepWithSignal(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (!signal) {
		return sleep(ms);
	}

	if (signal.aborted) {
		return Promise.reject(
			createAbortError((signal as AbortSignal & {reason?: unknown}).reason),
		);
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			reject(
				createAbortError((signal as AbortSignal & {reason?: unknown}).reason),
			);
		};

		signal.addEventListener('abort', onAbort, {once: true});
	});
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
 * Check if an error indicates a hard token/context length limit.
 */
export function isContextLengthError(error: unknown): boolean {
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		return (
			msg.includes('maximum context length') ||
			(msg.includes('context length') && msg.includes('token')) ||
			(msg.includes('exceeding max') && msg.includes('token')) ||
			(msg.includes('exceeds max') && msg.includes('token')) ||
			msg.includes('maximum number of tokens') ||
			msg.includes('input token count')
		);
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

export interface BatchContext {
	batchIndex: number;
	batchInfo: string;
}

/**
 * Execute an async function with exponential backoff retry on retriable errors.
 *
 * Retries on:
 * - Rate limit errors (429, quota exceeded)
 * - Transient API errors (e.g., Gemini's spurious "API key expired" bug)
 * - Any other error (best-effort retry, except hard context length errors)
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
	logger?: Logger,
	context?: BatchContext,
	signal?: AbortSignal,
): Promise<T> {
	let attempt = 0;
	let backoffMs = INITIAL_BACKOFF_MS;
	const contextInfo = context
		? {batchInfo: context.batchInfo, batchIndex: context.batchIndex}
		: {};

	while (attempt < MAX_ATTEMPTS) {
		throwIfAborted(signal, 'Retry cancelled');
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
			if (isAbortError(error) || signal?.aborted) {
				throw error;
			}
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const errorPreview =
				errorMessage.length > 500
					? `${errorMessage.slice(0, 500)}...`
					: errorMessage;

			if (isContextLengthError(error)) {
				if (logger) {
					logger.warn('api-utils', 'Non-retriable error, skipping retries', {
						...contextInfo,
						error: errorPreview,
					});
				}
				throw error;
			}

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

			if (logger) {
				logger.warn('api-utils', 'Retrying batch', {
					...contextInfo,
					attempt,
					nextAttempt: attempt + 1,
					maxAttempts: MAX_ATTEMPTS,
					backoffMs,
					reason,
					retryInfo,
					error: errorPreview,
				});
			}

			callbacks?.onThrottle?.(`${reason} - ${retryInfo}`);
			onRetrying?.(retryInfo);

			await sleepWithSignal(backoffMs, signal);
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
 * Each slot index (0 to concurrency - 1) is reused as batches complete.
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
 * @param signal - Optional abort signal for cancellation
 * @param concurrency - Optional concurrency override for API requests
 * @returns Flattened array of results (null entries for failed batches)
 */
export async function processBatchesWithLimit<T>(
	batches: T[][],
	processBatch: (
		batch: T[],
		onRetrying?: (retryInfo: string | null) => void,
		context?: BatchContext,
	) => Promise<number[][]>,
	callbacks?: ApiProviderCallbacks,
	batchSize?: number,
	batchMetadata?: BatchMetadata[],
	logger?: Logger,
	chunkOffset: number = 0,
	signal?: AbortSignal,
	concurrency: number = CONCURRENCY,
): Promise<Array<number[] | null>> {
	const limit = pLimit(concurrency);
	let processedItems = 0;
	const totalItems = batches.reduce((sum, batch) => sum + batch.length, 0);

	// Track which slot index to assign next (wraps around concurrency)
	let nextSlotIndex = 0;

	const batchPromises = batches.map((batch, batchIndex) =>
		limit(async () => {
			throwIfAborted(signal, 'Batch processing cancelled');
			// Assign slot index (reuse slots as batches complete)
			const slotIndex = nextSlotIndex++ % concurrency;
			// Calculate cumulative chunk positions (with offset from prior batches)
			const startChunk =
				chunkOffset + batchIndex * (batchSize ?? batch.length) + 1;
			const endChunk = startChunk + batch.length - 1;
			const batchInfo = `chunks ${startChunk}-${endChunk}`;
			const context = {batchIndex, batchInfo};

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
				const result = await processBatch(batch, onRetrying, context);

				// Delay before releasing the slot (rate limit protection)
				await sleepWithSignal(BATCH_DELAY_MS, signal);
				callbacks?.onSlotIdle?.(slotIndex);

				processedItems += batch.length;
				callbacks?.onBatchProgress?.(processedItems, totalItems);
				return result;
			} catch (error) {
				if (isAbortError(error) || signal?.aborted) {
					callbacks?.onSlotIdle?.(slotIndex);
					throw error;
				}
				const errorMsg = error instanceof Error ? error.message : String(error);
				const batchMeta = batchMetadata?.[batchIndex];

				// Log with full chunk context (service logger)
				if (logger) {
					logger.error('api-utils', 'Batch failed', {
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
				await sleepWithSignal(BATCH_DELAY_MS, signal);
				callbacks?.onSlotIdle?.(slotIndex);

				processedItems += batch.length;
				callbacks?.onBatchProgress?.(processedItems, totalItems);

				return Array.from({length: batch.length}, () => null);
			}
		}),
	);

	let batchResults: Array<number[] | null>[];
	try {
		batchResults = await Promise.all(batchPromises);
	} finally {
		// Reset all slots when complete or cancelled
		callbacks?.onResetSlots?.();
	}

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
