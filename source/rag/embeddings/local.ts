/**
 * Local embedding provider using Jina AI's code embedding model.
 *
 * Uses jinaai/jina-embeddings-v2-base-code via @huggingface/transformers (ONNX Runtime).
 * - 768 dimensions (matches Gemini)
 * - 8K token context window
 * - Trained on 150M+ code QA pairs
 * - q8 (int8) quantized for smaller size (~161MB) and faster inference
 *
 * Benefits:
 * - Works completely offline
 * - No API key required
 * - No per-token costs
 * - Data never leaves your machine
 */

import {pipeline} from '@huggingface/transformers';
import type {EmbeddingProvider} from './types.js';

const MODEL_NAME = 'jinaai/jina-embeddings-v2-base-code';
const BATCH_SIZE = 8; // Memory-efficient batch size

/**
 * Local embedding provider using Jina's code embedding model.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 768;
	private extractor: any = null;
	private initialized = false;

	async initialize(): Promise<void> {
		if (this.initialized) return;

		// Load the model with q8 (int8) quantization for smaller size and faster inference
		// First load will download the model (~161MB)
		this.extractor = await pipeline('feature-extraction', MODEL_NAME, {
			dtype: 'q8', // int8 quantization
		});

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

		// Process in batches for memory efficiency
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const batchResults = await this.embedBatch(batch);
			results.push(...batchResults);
		}

		return results;
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		const results: number[][] = [];

		for (const text of texts) {
			const output = await this.extractor(text, {
				pooling: 'mean',
				normalize: true,
			});

			// Extract embedding from output tensor
			const embedding = Array.from(output.data as Float32Array);
			results.push(embedding);
		}

		return results;
	}

	async embedSingle(text: string): Promise<number[]> {
		if (!this.initialized) {
			await this.initialize();
		}

		const output = await this.extractor(text, {
			pooling: 'mean',
			normalize: true,
		});

		return Array.from(output.data as Float32Array);
	}

	close(): void {
		this.extractor = null;
		this.initialized = false;
	}
}
