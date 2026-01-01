/**
 * Local embedding provider using Qwen3-Embedding-4B.
 *
 * ⚠️  NOT CURRENTLY AVAILABLE
 *
 * No transformers.js-compatible ONNX version exists yet.
 * The zhiqing/Qwen3-Embedding-4B-ONNX model has files in root instead of onnx/ subfolder.
 * Waiting for onnx-community to release a properly structured version.
 *
 * When available:
 * - 2560 dimensions
 * - ~8GB download (full precision)
 * - ~8GB RAM usage
 * - 32K context window
 * - +5 MTEB points over 0.6B (69.45 vs 64.33)
 */

import type {EmbeddingProvider, ModelProgressCallback} from './types.js';

const DIMENSIONS = 2560;

const NOT_AVAILABLE_ERROR =
	'local-4b is not available yet.\n\n' +
	'No transformers.js-compatible ONNX version of Qwen3-Embedding-4B exists.\n' +
	'The zhiqing/Qwen3-Embedding-4B-ONNX model has incorrect file structure.\n\n' +
	'Options:\n' +
	'  1. Use "local" (0.6B Q8) - works now, ~1.2GB RAM\n' +
	'  2. Use "gemini" - free API, best quality\n' +
	'  3. Wait for onnx-community to release 4B version\n\n' +
	'Run "viberag /init" to choose a different provider.';

/**
 * Local embedding provider using Qwen3-Embedding-4B FP32.
 * Currently throws an error - no compatible ONNX model available.
 */
export class Local4BEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = DIMENSIONS;

	async initialize(_onProgress?: ModelProgressCallback): Promise<void> {
		throw new Error(NOT_AVAILABLE_ERROR);
	}

	async embed(_texts: string[]): Promise<number[][]> {
		throw new Error(NOT_AVAILABLE_ERROR);
	}

	async embedSingle(_text: string): Promise<number[]> {
		throw new Error(NOT_AVAILABLE_ERROR);
	}

	close(): void {
		// Nothing to close
	}
}
