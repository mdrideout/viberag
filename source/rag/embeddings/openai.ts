/**
 * OpenAI embedding provider using OpenAI API.
 *
 * Uses text-embedding-3-small model (1536 dimensions).
 * Good quality with fast API responses and low cost ($0.02/1M tokens).
 */

import type {EmbeddingProvider, ModelProgressCallback} from './types.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MODEL = 'text-embedding-3-small';
// OpenAI limits: 8,191 tokens/text, 300,000 tokens/batch, 2,048 texts/batch
// With avg ~1000 tokens/chunk, safe limit is 300 texts. Use 256 for margin.
const BATCH_SIZE = 256;

// Concurrency and rate limiting
const CONCURRENCY = 5; // Max concurrent API requests
const MAX_RETRIES = 12; // Max retry attempts on rate limit
const INITIAL_BACKOFF_MS = 1000; // Start at 1s
const MAX_BACKOFF_MS = 60000; // Cap at 60s (1 min)

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * OpenAI embedding provider.
 * Uses text-embedding-3-small model via OpenAI API.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
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
				'OpenAI API key required. Run /init to configure your API key.',
			);
		}
		// Validate key format (should start with sk-)
		if (!this.apiKey.startsWith('sk-')) {
			throw new Error(
				`Invalid OpenAI API key format. Key should start with "sk-" but got "${this.apiKey.slice(0, 3)}..."`,
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
		const response = await fetch(`${OPENAI_API_BASE}/embeddings`, {
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
					error?: {message?: string; type?: string};
				};
				errorMessage = errorJson.error?.message || errorText;
			} catch {
				errorMessage = errorText;
			}

			// Provide helpful context for common errors
			if (response.status === 401) {
				const keyPreview = `${this.apiKey.slice(0, 7)}...${this.apiKey.slice(-4)}`;
				throw new Error(
					`OpenAI API authentication failed (401). Key format: ${keyPreview}. ` +
						`Verify your API key at https://platform.openai.com/api-keys. Error: ${errorMessage}`,
				);
			}

			throw new Error(`OpenAI API error (${response.status}): ${errorMessage}`);
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
