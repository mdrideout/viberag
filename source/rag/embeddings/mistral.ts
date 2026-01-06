/**
 * Mistral embedding provider using Mistral AI API.
 *
 * Uses codestral-embed model (1536 dimensions).
 * Optimized for code and technical content.
 */

import type {EmbeddingProvider, ModelProgressCallback} from './types.js';

const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';
const MODEL = 'codestral-embed';
// Mistral limits: 8,192 tokens/text, 16,000 tokens/batch TOTAL
// With avg ~500 tokens/chunk, can fit ~32. Use 24 for safety margin.
const BATCH_SIZE = 24;

// Concurrency and rate limiting
const CONCURRENCY = 5; // Max concurrent API requests
const MAX_RETRIES = 12; // Max retry attempts on rate limit
const INITIAL_BACKOFF_MS = 1000; // Start at 1s
const MAX_BACKOFF_MS = 60000; // Cap at 60s (1 min)

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Mistral embedding provider.
 * Uses codestral-embed model via Mistral AI API.
 */
export class MistralEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 1536;
	private apiKey: string;
	private initialized = false;

	// Callback for rate limit throttling - message or null to clear
	onThrottle?: (message: string | null) => void;
	// Callback for batch progress - (processed, total) chunks
	onBatchProgress?: (processed: number, total: number) => void;

	constructor(apiKey?: string) {
		// Trim the key to remove any accidental whitespace
		this.apiKey = (apiKey ?? '').trim();
	}

	async initialize(_onProgress?: ModelProgressCallback): Promise<void> {
		if (!this.apiKey) {
			throw new Error(
				'Mistral API key required. Run /init to configure your API key.',
			);
		}
		this.initialized = true;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (!this.initialized) {
			await this.initialize();
		}

		if (texts.length === 0) {
			return [];
		}

		// Split into batches
		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			batches.push(texts.slice(i, i + BATCH_SIZE));
		}

		// Process batches with limited concurrency
		const results: number[][] = [];
		let completed = 0;

		for (let i = 0; i < batches.length; i += CONCURRENCY) {
			const concurrentBatches = batches.slice(i, i + CONCURRENCY);

			// Fire concurrent requests
			const batchResults = await Promise.all(
				concurrentBatches.map(batch => this.embedBatchWithRetry(batch)),
			);

			// Flatten and collect results (Promise.all preserves order)
			for (const result of batchResults) {
				results.push(...result);
			}

			// Report progress after concurrent group completes
			completed += concurrentBatches.length;
			const processed = Math.min(completed * BATCH_SIZE, texts.length);
			this.onBatchProgress?.(processed, texts.length);
		}

		return results;
	}

	/**
	 * Embed a batch with exponential backoff retry on rate limit errors.
	 */
	private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
		let attempt = 0;
		let backoffMs = INITIAL_BACKOFF_MS;

		while (true) {
			try {
				const result = await this.embedBatch(batch);
				// Clear throttle message on success (if was throttling)
				if (attempt > 0) this.onThrottle?.(null);
				return result;
			} catch (error) {
				if (this.isRateLimitError(error) && attempt < MAX_RETRIES) {
					attempt++;
					const secs = Math.round(backoffMs / 1000);
					this.onThrottle?.(
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
	 * Check if an error is a rate limit error (429 or quota exceeded).
	 */
	private isRateLimitError(error: unknown): boolean {
		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			return (
				msg.includes('429') || msg.includes('rate') || msg.includes('quota')
			);
		}
		return false;
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		const response = await fetch(`${MISTRAL_API_BASE}/embeddings`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: MODEL,
				input: texts,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			let errorMessage: string;
			try {
				const errorJson = JSON.parse(errorText) as {
					message?: string;
					detail?: string;
				};
				errorMessage = errorJson.message || errorJson.detail || errorText;
			} catch {
				errorMessage = errorText;
			}

			if (response.status === 401) {
				throw new Error(
					`Mistral API authentication failed (401). ` +
						`Verify your API key at https://console.mistral.ai/api-keys. Error: ${errorMessage}`,
				);
			}

			throw new Error(
				`Mistral API error (${response.status}): ${errorMessage}`,
			);
		}

		const data = (await response.json()) as {
			data: Array<{embedding: number[]; index: number}>;
		};

		// Sort by index to ensure correct order
		return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
	}

	async embedSingle(text: string): Promise<number[]> {
		const results = await this.embed([text]);
		return results[0]!;
	}

	close(): void {
		this.initialized = false;
	}
}
