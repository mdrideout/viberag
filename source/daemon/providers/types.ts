/**
 * Embedding Provider Types.
 *
 * Types for embedding providers that generate vector embeddings from text.
 */

import type {Logger} from '../lib/logger.js';

/**
 * Progress callback for model loading/downloading.
 * @param status - Current status: 'downloading', 'loading', 'ready'
 * @param progress - Download progress 0-100 (only for 'downloading')
 * @param message - Optional message (e.g., file being downloaded)
 */
export type ModelProgressCallback = (
	status: 'downloading' | 'loading' | 'ready',
	progress?: number,
	message?: string,
) => void;

/**
 * Metadata for a single chunk, used for detailed failure logging.
 */
export interface ChunkMetadata {
	/** File path for this chunk */
	filepath: string;
	/** Start line number (1-indexed) */
	startLine: number;
	/** End line number (1-indexed) */
	endLine: number;
	/** Text size in characters */
	size: number;
}

/**
 * Options for embedding operations.
 */
export interface EmbedOptions {
	/** Metadata for each chunk being embedded (parallel array to texts) */
	chunkMetadata?: ChunkMetadata[];
	/** Logger for debug output on failures */
	logger?: Logger;
	/** Offset for cumulative chunk numbering in progress display */
	chunkOffset?: number;
}

/**
 * Embedding provider interface for generating vector embeddings.
 */
export interface EmbeddingProvider {
	/** Number of dimensions in the embedding vectors */
	readonly dimensions: number;

	/**
	 * Initialize the provider (load model, etc.)
	 * Must be called before using embed() or embedSingle().
	 * @param onProgress - Optional callback for download/loading progress
	 */
	initialize(onProgress?: ModelProgressCallback): Promise<void>;

	/**
	 * Generate embeddings for multiple texts.
	 * @param texts - Array of text strings to embed
	 * @param options - Optional settings for logging and metadata
	 * @returns Array of embedding vectors (one per text), null when embedding fails
	 */
	embed(
		texts: string[],
		options?: EmbedOptions,
	): Promise<Array<number[] | null>>;

	/**
	 * Generate embedding for a single text.
	 * Optimized for query embedding.
	 * @param text - Text string to embed
	 * @returns Embedding vector
	 */
	embedSingle(text: string): Promise<number[]>;

	/**
	 * Close the provider and free resources.
	 */
	close(): void;
}
