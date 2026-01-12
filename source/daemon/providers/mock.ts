/**
 * Mock embedding provider for testing.
 *
 * Generates deterministic hash-based embeddings that:
 * - Run instantly (no model loading)
 * - Are deterministic (same input = same output)
 * - Normalized to unit length
 * - Support any dimension count
 *
 * Usage:
 * - Unit tests that need embeddings but don't need semantic quality
 * - Testing search infrastructure without ONNX overhead
 * - CI pipeline fast checks
 */

import type {
	EmbeddingProvider,
	ModelProgressCallback,
	EmbedOptions,
} from './types.js';

const DEFAULT_DIMENSIONS = 1024;

/**
 * Mock embedding provider using deterministic hash-based vectors.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions: number;

	constructor(dimensions: number = DEFAULT_DIMENSIONS) {
		this.dimensions = dimensions;
	}

	async initialize(_onProgress?: ModelProgressCallback): Promise<void> {
		// No initialization needed - instant startup
	}

	async embed(texts: string[], _options?: EmbedOptions): Promise<number[][]> {
		return texts.map(t => this.hashToVector(t));
	}

	async embedSingle(text: string): Promise<number[]> {
		return this.hashToVector(text);
	}

	/**
	 * Convert text to a deterministic unit vector.
	 * Uses a simple hash-based approach to generate pseudo-random but repeatable values.
	 */
	private hashToVector(text: string): number[] {
		const seed = this.hash(text);

		// Generate deterministic pseudo-random values
		const vec = new Array(this.dimensions).fill(0).map((_, i) => {
			// LCG-like pseudo-random based on seed and index
			const state =
				(((seed * (i + 1) * 1103515245 + 12345) >>> 0) % 0x7fffffff) /
				0x7fffffff;
			return state * 2 - 1; // Range [-1, 1]
		});

		// Normalize to unit length
		const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
		return vec.map(v => (magnitude > 0 ? v / magnitude : 0));
	}

	/**
	 * Simple string hash function (djb2).
	 */
	private hash(str: string): number {
		let h = 5381;
		for (let i = 0; i < str.length; i++) {
			h = (h * 33) ^ str.charCodeAt(i);
			h = h >>> 0; // Convert to unsigned 32-bit
		}
		return h;
	}

	close(): void {
		// Nothing to close
	}
}
