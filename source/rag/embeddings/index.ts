/**
 * Embeddings module for generating vector embeddings.
 * Supports both local (ONNX) and cloud API providers.
 */

export {GeminiEmbeddingProvider} from './gemini.js';
export {Local4BEmbeddingProvider} from './local-4b.js';
export {LocalEmbeddingProvider, clearCachedPipeline} from './local.js';
export {MistralEmbeddingProvider} from './mistral.js';
export {MockEmbeddingProvider} from './mock.js';
export {OpenAIEmbeddingProvider} from './openai.js';
export {
	validateApiKey,
	type ValidationResult,
	type ValidateApiKeyOptions,
} from './validate.js';

export type {
	EmbeddingProvider,
	ModelProgressCallback,
	ChunkMetadata,
	EmbedOptions,
} from './types.js';

// Shared utilities for API-based providers
export {
	CONCURRENCY,
	BATCH_DELAY_MS,
	MAX_RETRIES,
	INITIAL_BACKOFF_MS,
	MAX_BACKOFF_MS,
	sleep,
	isRateLimitError,
	isTransientApiError,
	isRetriableError,
	withRetry,
	processBatchesWithLimit,
	chunk,
	type ApiProviderCallbacks,
	type BatchMetadata,
} from './api-utils.js';
