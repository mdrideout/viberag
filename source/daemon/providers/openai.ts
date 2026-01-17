/**
 * OpenAI embedding provider using OpenAI API.
 *
 * Uses text-embedding-3-large model with reduced dimensions (1536).
 * High quality embeddings with fast API responses ($0.13/1M tokens).
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

const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536; // Reduced from 3072 for storage efficiency
// OpenAI limits: 8,191 tokens/text, 300,000 tokens/batch, 2,048 texts/batch
// Chunks are ~2000 chars + context header ≈ 800-1000 tokens each
// 32 chunks × 1000 tokens = 32,000 tokens (well under 300k limit)
// Smaller batches = more progress visibility with 5 concurrent slots
const BATCH_SIZE = 32;

/**
 * OpenAI embedding provider.
 * Uses text-embedding-3-large model via OpenAI API with reduced dimensions.
 *
 * Supports regional endpoints for corporate accounts with data residency:
 * - Default: https://api.openai.com/v1
 * - US: https://us.api.openai.com/v1
 * - EU: https://eu.api.openai.com/v1
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 1536;
	private apiKey: string;
	private apiBase: string;
	private initialized = false;

	// Callback for rate limit throttling - message or null to clear
	onThrottle: ((message: string | null) => void) | undefined = undefined;
	// Callback for batch progress - (processed, total) chunks
	onBatchProgress: ((processed: number, total: number) => void) | undefined =
		undefined;
	// Slot progress callbacks (wired by daemon owner)
	onSlotProcessing: ((index: number, batchInfo: string) => void) | undefined =
		undefined;
	onSlotRateLimited:
		| ((index: number, batchInfo: string, retryInfo: string) => void)
		| undefined = undefined;
	onSlotIdle: ((index: number) => void) | undefined = undefined;
	onSlotFailure:
		| ((data: {
				batchInfo: string;
				files: string[];
				chunkCount: number;
				error: string;
				timestamp: string;
		  }) => void)
		| undefined = undefined;
	onResetSlots: (() => void) | undefined = undefined;

	constructor(apiKey?: string, baseUrl?: string) {
		// Trim the key to remove any accidental whitespace
		this.apiKey = (apiKey ?? '').trim();
		this.apiBase = baseUrl ?? DEFAULT_API_BASE;
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

	async embed(
		texts: string[],
		options?: EmbedOptions,
	): Promise<Array<number[] | null>> {
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
			onSlotProcessing: this.onSlotProcessing,
			onSlotRateLimited: this.onSlotRateLimited,
			onSlotIdle: this.onSlotIdle,
			onSlotFailure: this.onSlotFailure,
			onResetSlots: this.onResetSlots,
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
			(batch, onRetrying, context) =>
				withRetry(
					() => this.embedBatch(batch),
					callbacks,
					onRetrying,
					options?.logger,
					context,
				),
			callbacks,
			BATCH_SIZE,
			batchMetadata,
			options?.logger,
			options?.chunkOffset ?? 0,
		);
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		const response = await fetch(`${this.apiBase}/embeddings`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: MODEL,
				input: texts,
				dimensions: DIMENSIONS,
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

				// Check for regional endpoint mismatch
				if (errorMessage.includes('incorrect regional hostname')) {
					// Extract the required region from the error message if present
					const regionMatch = errorMessage.match(
						/make your request to (\w+\.api\.openai\.com)/,
					);
					const requiredEndpoint =
						regionMatch?.[1] ?? 'the correct regional endpoint';

					throw new Error(
						`OpenAI API regional endpoint mismatch. Your account requires ${requiredEndpoint}. ` +
							`Run /init again and select the matching region (US or EU) instead of Default. ` +
							`Key: ${keyPreview}`,
					);
				}

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
		const vector = results[0];
		if (!vector) {
			throw new Error('OpenAI embedding failed');
		}
		return vector;
	}

	close(): void {
		this.initialized = false;
	}
}
