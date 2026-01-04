/**
 * Embeddings module for generating vector embeddings.
 * Supports both local (ONNX) and cloud API providers.
 */

export {GeminiEmbeddingProvider} from './gemini.js';
export {Local4BEmbeddingProvider} from './local-4b.js';
export {LocalEmbeddingProvider} from './local.js';
export {MistralEmbeddingProvider} from './mistral.js';
export {OpenAIEmbeddingProvider} from './openai.js';
export {validateApiKey, type ValidationResult} from './validate.js';

export type {EmbeddingProvider, ModelProgressCallback} from './types.js';
