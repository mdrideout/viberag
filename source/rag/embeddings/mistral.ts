/**
 * Mistral embedding provider using Mistral AI API.
 *
 * Uses codestral-embed model (1536 dimensions).
 * Optimized for code and technical content.
 */

import type {EmbeddingProvider, ModelProgressCallback} from './types.js';

const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';
const MODEL = 'codestral-embed';
const BATCH_SIZE = 64; // Mistral supports batching

/**
 * Mistral embedding provider.
 * Uses codestral-embed model via Mistral AI API.
 */
export class MistralEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 1536;
	private apiKey: string;
	private initialized = false;

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

		const results: number[][] = [];

		// Process in batches
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const batchResults = await this.embedBatch(batch);
			results.push(...batchResults);
		}

		return results;
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
				const errorJson = JSON.parse(errorText) as {message?: string; detail?: string};
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

			throw new Error(`Mistral API error (${response.status}): ${errorMessage}`);
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
