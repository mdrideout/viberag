/**
 * Gemini embedding provider using Google's Generative AI API.
 *
 * Uses gemini-embedding-001 model with 1536 dimensions.
 * Note: The model defaults to 3072 dims but we explicitly request 1536 for:
 * - Good balance of quality and storage
 * - Matches OpenAI text-embedding-3-small dimensions
 *
 * Free tier available with generous limits.
 */

import type {EmbeddingProvider, ModelProgressCallback} from './types.js';

const GEMINI_API_BASE =
	'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-embedding-001';
// Gemini limits: 2,048 tokens/text, 20,000 tokens/batch, 100-250 texts/batch
// With avg ~1000 tokens/chunk, safe limit is 20 texts.
const BATCH_SIZE = 20;

// Concurrency and rate limiting
const CONCURRENCY = 5; // Max concurrent API requests
const MAX_RETRIES = 12; // Max retry attempts on rate limit
const INITIAL_BACKOFF_MS = 1000; // Start at 1s
const MAX_BACKOFF_MS = 60000; // Cap at 60s (1 min)

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Gemini embedding provider.
 * Uses gemini-embedding-001 model via Google's Generative AI API.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
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
				'Gemini API key required. Run /init to configure your API key.',
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
		const url = `${GEMINI_API_BASE}/${MODEL}:batchEmbedContents`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': this.apiKey,
			},
			body: JSON.stringify({
				requests: texts.map(text => ({
					model: `models/${MODEL}`,
					content: {
						parts: [{text}],
					},
					taskType: 'RETRIEVAL_DOCUMENT',
					outputDimensionality: this.dimensions,
				})),
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			let errorMessage: string;
			try {
				const errorJson = JSON.parse(errorText) as {error?: {message?: string}};
				errorMessage = errorJson.error?.message || errorText;
			} catch {
				errorMessage = errorText;
			}

			if (response.status === 400 || response.status === 403) {
				throw new Error(
					`Gemini API authentication failed (${response.status}). ` +
						`Verify your API key at https://aistudio.google.com/apikey. Error: ${errorMessage}`,
				);
			}

			throw new Error(`Gemini API error (${response.status}): ${errorMessage}`);
		}

		const data = (await response.json()) as {
			embeddings: Array<{values: number[]}>;
		};

		return data.embeddings.map(e => e.values);
	}

	async embedSingle(text: string): Promise<number[]> {
		if (!this.initialized) {
			await this.initialize();
		}

		const url = `${GEMINI_API_BASE}/${MODEL}:embedContent`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': this.apiKey,
			},
			body: JSON.stringify({
				model: `models/${MODEL}`,
				content: {
					parts: [{text}],
				},
				taskType: 'RETRIEVAL_QUERY',
				outputDimensionality: this.dimensions,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			let errorMessage: string;
			try {
				const errorJson = JSON.parse(errorText) as {error?: {message?: string}};
				errorMessage = errorJson.error?.message || errorText;
			} catch {
				errorMessage = errorText;
			}

			if (response.status === 400 || response.status === 403) {
				throw new Error(
					`Gemini API authentication failed (${response.status}). ` +
						`Verify your API key at https://aistudio.google.com/apikey. Error: ${errorMessage}`,
				);
			}

			throw new Error(`Gemini API error (${response.status}): ${errorMessage}`);
		}

		const data = (await response.json()) as {
			embedding: {values: number[]};
		};

		return data.embedding.values;
	}

	close(): void {
		this.initialized = false;
	}
}
