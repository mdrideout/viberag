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

const GEMINI_API_BASE =
	'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-embedding-001';
// Gemini limits: 2,048 tokens/text, 20,000 tokens/batch, 100-250 texts/batch
// Chunks are ~2000 chars + context header ≈ 800-1000 tokens each
// 16 chunks × 1000 tokens = 16,000 tokens (safe margin under 20k limit)
const BATCH_SIZE = 16;

/**
 * Gemini embedding provider.
 * Uses gemini-embedding-001 model via Google's Generative AI API.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
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
				'Gemini API key required. Run /init to configure your API key.',
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
			options?.chunkOffset ?? 0,
		);
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
