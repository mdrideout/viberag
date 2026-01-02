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
const BATCH_SIZE = 100; // Gemini supports up to 100 texts per request

/**
 * Gemini embedding provider.
 * Uses gemini-embedding-001 model via Google's Generative AI API.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 1536;
	private apiKey: string;
	private initialized = false;

	constructor(apiKey?: string) {
		this.apiKey = apiKey ?? '';
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
		const url = `${GEMINI_API_BASE}/${MODEL}:batchEmbedContents?key=${this.apiKey}`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
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
			const error = await response.text();
			throw new Error(`Gemini API error: ${response.status} - ${error}`);
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

		const url = `${GEMINI_API_BASE}/${MODEL}:embedContent?key=${this.apiKey}`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
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
			const error = await response.text();
			throw new Error(`Gemini API error: ${response.status} - ${error}`);
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
