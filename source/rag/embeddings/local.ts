/**
 * Local embedding provider using fastembed (ONNX runtime).
 *
 * Uses BGE-base-en-v1.5 model (768 dimensions) by default.
 */

import {EmbeddingModel, FlagEmbedding} from 'fastembed';
import type {EmbeddingProvider} from './types.js';

/** Default batch size for embedding multiple texts */
const DEFAULT_BATCH_SIZE = 32;

/**
 * Local embedding provider using fastembed.
 * Runs embeddings locally using ONNX runtime.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 768;

	private model: FlagEmbedding | null = null;
	private initialized = false;

	/**
	 * Initialize the embedding model.
	 * Downloads the model on first use (~90MB).
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		this.model = await FlagEmbedding.init({
			model: EmbeddingModel.BGEBaseENV15,
			showDownloadProgress: true,
		});

		this.initialized = true;
	}

	/**
	 * Generate embeddings for multiple texts.
	 * Uses batch processing for efficiency.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (!this.initialized || !this.model) {
			await this.initialize();
		}

		if (texts.length === 0) {
			return [];
		}

		const results: number[][] = [];

		// fastembed returns an async generator of batches
		for await (const batch of this.model!.embed(texts, DEFAULT_BATCH_SIZE)) {
			// Each batch is an array of embeddings (one per text in that batch)
			for (const embedding of batch) {
				results.push(Array.from(embedding));
			}
		}

		return results;
	}

	/**
	 * Generate embedding for a single text.
	 * Uses fastembed's queryEmbed which is optimized for single texts.
	 */
	async embedSingle(text: string): Promise<number[]> {
		if (!this.initialized || !this.model) {
			await this.initialize();
		}

		// Use queryEmbed for single query embedding
		const embedding = await this.model!.queryEmbed(text);
		return Array.from(embedding);
	}

	/**
	 * Close the provider and free resources.
	 * Note: fastembed doesn't have an explicit cleanup method,
	 * but we clear our reference to allow garbage collection.
	 */
	close(): void {
		this.model = null;
		this.initialized = false;
	}
}
