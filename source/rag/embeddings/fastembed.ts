/**
 * FastEmbed provider using ONNX runtime with quantized models.
 *
 * Uses BGE models which are general-purpose text embeddings.
 * Much faster than Jina due to smaller models and int8 quantization.
 */

import {EmbeddingModel, FlagEmbedding} from 'fastembed';
import type {EmbeddingProvider} from './types.js';

/**
 * Model configurations for FastEmbed.
 */
const MODEL_CONFIG = {
	small: {
		model: EmbeddingModel.BGESmallENV15,
		dimensions: 384,
		name: 'bge-small-en-v1.5',
		size: '32MB',
	},
	base: {
		model: EmbeddingModel.BGEBaseENV15,
		dimensions: 768,
		name: 'bge-base-en-v1.5',
		size: '134MB',
	},
} as const;

export type FastEmbedModelSize = keyof typeof MODEL_CONFIG;

/**
 * FastEmbed provider for fast local embeddings.
 * Uses quantized BGE models via ONNX runtime.
 */
export class FastEmbedProvider implements EmbeddingProvider {
	readonly dimensions: number;
	private modelSize: FastEmbedModelSize;
	private model: FlagEmbedding | null = null;
	private initialized = false;
	private initPromise: Promise<void> | null = null;

	/**
	 * Create a FastEmbed provider.
	 * @param modelSize - 'small' (384d, 32MB) or 'base' (768d, 134MB)
	 */
	constructor(modelSize: FastEmbedModelSize = 'small') {
		this.modelSize = modelSize;
		this.dimensions = MODEL_CONFIG[modelSize].dimensions;
	}

	/**
	 * Initialize the embedding model.
	 * Downloads the quantized ONNX model on first use.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this._doInitialize();
		await this.initPromise;
	}

	private async _doInitialize(): Promise<void> {
		const config = MODEL_CONFIG[this.modelSize];
		const startTime = Date.now();
		console.error(
			`[FastEmbedProvider] Loading ${config.name} (~${config.size})...`,
		);

		this.model = await FlagEmbedding.init({
			model: config.model,
		});

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.error(`[FastEmbedProvider] Model loaded in ${elapsed}s`);

		this.initialized = true;
	}

	/**
	 * Generate embeddings for multiple texts.
	 * FastEmbed handles batching internally via generator.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (!this.initialized || !this.model) {
			await this.initialize();
		}

		if (texts.length === 0) {
			return [];
		}

		const results: number[][] = [];

		// FastEmbed uses a generator pattern for batch processing
		for await (const batch of this.model!.embed(texts)) {
			results.push(...batch);
		}

		return results;
	}

	/**
	 * Generate embedding for a single text.
	 */
	async embedSingle(text: string): Promise<number[]> {
		const results = await this.embed([text]);
		return results[0]!;
	}

	/**
	 * Close the provider and free resources.
	 */
	close(): void {
		this.model = null;
		this.initialized = false;
	}
}
