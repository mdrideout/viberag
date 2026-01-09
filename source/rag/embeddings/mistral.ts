/**
 * Mistral embedding provider using Mistral AI API.
 *
 * Uses codestral-embed model (1536 dimensions).
 * Optimized for code and technical content.
 */

import type {
	EmbeddingProvider,
	ModelProgressCallback,
	EmbedOptions,
} from './types.js';
import {
	chunk,
	processBatchesWithLimit,
	withRetry,
	type ApiProviderCallbacks,
	type BatchMetadata,
} from './api-utils.js';

const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';
const MODEL = 'codestral-embed';
// Mistral limits: 8,192 tokens/text, 16,000 tokens/batch TOTAL
// Chunks are ~2000 chars but token count varies (code can be 1.5-2x tokens/char)
// 8 chunks × ~1500 tokens worst case = 12,000 tokens (75% margin under 16k limit)
const BATCH_SIZE = 8;

/**
 * Mistral embedding provider.
 * Uses codestral-embed model via Mistral AI API.
 */
export class MistralEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 1536;
	private apiKey: string;
	private initialized = false;

	// Callback for rate limit throttling - message or null to clear
	onThrottle: ((message: string | null) => void) | undefined = undefined;
	// Callback for batch progress - (processed, total) chunks
	onBatchProgress: ((processed: number, total: number) => void) | undefined =
		undefined;

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

	async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
		if (!this.initialized) {
			await this.initialize();
		}

		if (texts.length === 0) {
			return [];
		}

		const batches = chunk(texts, BATCH_SIZE);
		const callbacks: ApiProviderCallbacks = {
			onThrottle: this.onThrottle,
			onBatchProgress: this.onBatchProgress,
		};

		// Convert chunk metadata to batch metadata if provided
		let batchMetadata: BatchMetadata[] | undefined;
		if (options?.chunkMetadata) {
			const metaBatches = chunk(options.chunkMetadata, BATCH_SIZE);
			batchMetadata = metaBatches.map(metaBatch => ({
				filepaths: metaBatch.map(m => m.filepath),
				lineRanges: metaBatch.map(m => ({start: m.startLine, end: m.endLine})),
				sizes: metaBatch.map(m => m.size),
			}));
		}

		return processBatchesWithLimit(
			batches,
			(batch, onRetrying) =>
				withRetry(() => this.embedBatch(batch), callbacks, onRetrying),
			callbacks,
			BATCH_SIZE,
			batchMetadata,
			options?.logger,
		);
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
