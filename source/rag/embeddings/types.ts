/**
 * Embedding provider interface for generating vector embeddings.
 */
export interface EmbeddingProvider {
	/** Number of dimensions in the embedding vectors */
	readonly dimensions: number;

	/**
	 * Initialize the provider (load model, etc.)
	 * Must be called before using embed() or embedSingle().
	 */
	initialize(): Promise<void>;

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
