/**
 * Embeddings module for generating vector embeddings.
 * Supports both local (ONNX) and cloud API providers.
 */

export {GeminiEmbeddingProvider} from './gemini.js';
export {LocalEmbeddingProvider} from './local.js';
export {MistralEmbeddingProvider} from './mistral.js';
export {OpenAIEmbeddingProvider} from './openai.js';

export type {EmbeddingProvider} from './types.js';
