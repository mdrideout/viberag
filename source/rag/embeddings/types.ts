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
	 * @returns Array of embedding vectors (one per text)
	 */
	embed(texts: string[]): Promise<number[][]>;

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
