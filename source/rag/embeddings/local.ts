/**
 * Local embedding provider using Qwen3-Embedding-0.6B.
 *
 * Uses Qwen3-Embedding-0.6B Q8 via @huggingface/transformers (ONNX Runtime).
 * - 1024 dimensions
 * - ~700MB download (Q8 quantized)
 * - ~10GB RAM usage
 * - 32K context window
 *
 * Benefits:
 * - Works completely offline
 * - No API key required
 * - No per-token costs
 * - Data never leaves your machine
 */

import {pipeline} from '@huggingface/transformers';
import type {EmbeddingProvider, ModelProgressCallback} from './types.js';

const MODEL_NAME = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const DIMENSIONS = 1024;
const BATCH_SIZE = 8;

/**
 * Local embedding provider using Qwen3-Embedding-0.6B Q8.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = DIMENSIONS;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HuggingFace pipeline type is too complex
	private extractor: any = null;
	private initialized = false;

	async initialize(onProgress?: ModelProgressCallback): Promise<void> {
		if (this.initialized) return;

		// Track download progress for the model files
		let lastProgress = 0;
		const progressCallback = onProgress
			? (progress: {status: string; file?: string; progress?: number}) => {
					if (
						progress.status === 'progress' &&
						progress.progress !== undefined
					) {
						// Round to avoid too many updates
						const pct = Math.round(progress.progress);
						if (pct !== lastProgress) {
							lastProgress = pct;
							onProgress('downloading', pct, progress.file);
						}
					} else if (progress.status === 'ready') {
						onProgress('loading');
					}
				}
			: undefined;

		// Notify loading is starting
		onProgress?.('loading');

		// Load the model with q8 (int8) quantization for smaller size and faster inference
		// First load will download the model (~700MB)
		this.extractor = await pipeline('feature-extraction', MODEL_NAME, {
			dtype: 'q8', // int8 quantization
			progress_callback: progressCallback,
		});

		onProgress?.('ready');
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
