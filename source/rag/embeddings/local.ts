/**
 * Local embedding provider using Transformers.js (ONNX runtime).
 *
 * Uses jina-embeddings-v2-base-code for code-optimized embeddings.
 * - 768 dimensions, 8K token context
 * - Trained on 150M+ code QA pairs from GitHub
 * - Supports 30 programming languages
 */

import {pipeline} from '@huggingface/transformers';
import type {EmbeddingProvider} from './types.js';

/**
 * Local embedding provider using Transformers.js.
 * Runs embeddings locally using ONNX runtime with Jina code model.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions: number;
	private modelName: string;
	// Using any due to complex union types in transformers.js
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private extractor: any = null;
	private initialized = false;
	private initPromise: Promise<void> | null = null;

	/**
	 * Create a local embedding provider.
	 * @param modelName - The HuggingFace model name (default: jina-embeddings-v2-base-code)
	 * @param dimensions - The embedding dimensions (768 for Jina v2)
	 */
	constructor(
		modelName: string = 'jinaai/jina-embeddings-v2-base-code',
		dimensions: number = 768,
	) {
		this.dimensions = dimensions;
		this.modelName = modelName;
	}

	/**
	 * Initialize the embedding model.
	 * Downloads the fp16 ONNX model (~321MB) on first use.
	 * Uses fp16 for best quality/size balance (~99% of fp32 accuracy).
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		// Prevent concurrent initialization
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this._doInitialize();
		await this.initPromise;
	}

	private async _doInitialize(): Promise<void> {
		// Log download start for visibility
		const startTime = Date.now();
		console.error(
			`[LocalEmbeddingProvider] Loading ${this.modelName} (fp16, ~321MB)...`,
		);

		// Create feature extraction pipeline with fp16 precision
		// fp16 provides ~99% of fp32 accuracy with half the download size
		this.extractor = await pipeline('feature-extraction', this.modelName, {
			dtype: 'fp16',
		});

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.error(`[LocalEmbeddingProvider] Model loaded in ${elapsed}s`);

		this.initialized = true;
	}

	// Max characters per text to avoid O(n²) attention blowup
	// ~2000 chars ≈ 500 tokens, keeps inference fast
	private static readonly MAX_TEXT_LENGTH = 2000;
	// Max texts per batch to limit memory usage
	private static readonly MAX_BATCH_SIZE = 8;

	/**
	 * Generate embeddings for multiple texts.
	 * Uses batched inference with size limits for optimal performance.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (!this.initialized || !this.extractor) {
			await this.initialize();
		}

		if (texts.length === 0) {
			return [];
		}

		// Truncate long texts to prevent slow inference
		const truncated = texts.map(t =>
			t.length > LocalEmbeddingProvider.MAX_TEXT_LENGTH
				? t.slice(0, LocalEmbeddingProvider.MAX_TEXT_LENGTH)
				: t,
		);

		// Process in smaller batches to limit memory and keep latency predictable
		const results: number[][] = [];
		const batchSize = LocalEmbeddingProvider.MAX_BATCH_SIZE;

		for (let i = 0; i < truncated.length; i += batchSize) {
			const batch = truncated.slice(i, i + batchSize);
			const batchResults = await this.embedBatch(batch);
			results.push(...batchResults);
		}

		return results;
	}

	/**
	 * Embed a single batch of texts.
	 */
	private async embedBatch(texts: string[]): Promise<number[][]> {
		const output = await this.extractor(texts, {
			pooling: 'mean',
			normalize: true,
		});

		// Output shape is [batch_size, dimensions]
		const data = output.data ?? output.ort_tensor?.data ?? output;
		const dims = this.dimensions;
		const results: number[][] = [];

		for (let i = 0; i < texts.length; i++) {
			const start = i * dims;
			const end = start + dims;
			results.push(Array.from((data as Float32Array).slice(start, end)));
		}

		return results;
	}

	/**
	 * Generate embedding for a single text with mean pooling.
	 */
	async embedSingle(text: string): Promise<number[]> {
		if (!this.initialized || !this.extractor) {
			await this.initialize();
		}

		// Get token embeddings from the model with mean pooling and normalization
		const output = await this.extractor(text, {
			pooling: 'mean',
			normalize: true,
		});

		// Extract the embedding data - output.data contains the Float32Array
		const data = output.data ?? output.ort_tensor?.data ?? output;
		return Array.from(data as Float32Array);
	}

	/**
	 * Close the provider and free resources.
	 */
	close(): void {
		this.extractor = null;
		this.initialized = false;
	}
}
