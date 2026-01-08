/**
 * OpenAI embedding provider using OpenAI API.
 *
 * Uses text-embedding-3-small model (1536 dimensions).
 * Good quality with fast API responses and low cost ($0.02/1M tokens).
 */

import type {EmbeddingProvider, ModelProgressCallback} from './types.js';
import {
	chunk,
	processBatchesWithLimit,
	withRetry,
	type ApiProviderCallbacks,
} from './api-utils.js';

const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const MODEL = 'text-embedding-3-small';
// OpenAI limits: 8,191 tokens/text, 300,000 tokens/batch, 2,048 texts/batch
// Chunks are ~2000 chars + context header ≈ 800-1000 tokens each
// 200 chunks × 1000 tokens = 200,000 tokens (safe margin under 300k limit)
const BATCH_SIZE = 200;

/**
 * OpenAI embedding provider.
 * Uses text-embedding-3-small model via OpenAI API.
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
	onThrottle?: (message: string | null) => void;
	// Callback for batch progress - (processed, total) chunks
	onBatchProgress?: (processed: number, total: number) => void;

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

	async embed(texts: string[]): Promise<number[][]> {
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

		return processBatchesWithLimit(
			batches,
			batch => withRetry(() => this.embedBatch(batch), callbacks),
			callbacks,
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
