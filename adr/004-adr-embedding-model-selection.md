# ADR-004: Embedding Model Selection

## Status

Accepted (Updated)

## Context

VibeRAG needs embedding models to convert code into vectors for semantic search. Key requirements:

1. **Code-optimized** - Models should understand programming languages and code semantics
2. **Local-first option** - Support offline use without API keys
3. **Quality options** - Higher accuracy options for users willing to use cloud APIs
4. **Reasonable dimensions** - Balance between accuracy and storage/compute costs

## Decision

We support three embedding providers, selectable during `/init`:

### Provider Comparison

| Provider  | Model                        | Dimensions | Context   | Cost                 | Status      |
| --------- | ---------------------------- | ---------- | --------- | -------------------- | ----------- |
| Local\*   | jina-embeddings-v2-base-code | 768        | 8K tokens | Free                 | Implemented |
| Gemini    | text-embedding-004           | 768        | 2K tokens | Free tier            | Implemented |
| Mistral   | mistral-embed                | 1024       | 8K tokens | $0.10/1M             | Implemented |
| OpenAI    | text-embedding-3-large       | 3072       | 8K tokens | $0.13/1M             | Implemented |

\*Recommended for offline use and code-optimized embeddings.

### Local (Default, Implemented)

**Model**: `jinaai/jina-embeddings-v2-base-code` with int8 (q8) quantization

**Strengths**:

- Purpose-built for code, trained on GitHub data
- Supports 30+ programming languages
- 8K token context handles large functions without truncation
- Zero latency, works offline, no API costs
- ~161MB model size with q8 quantization

**Trade-offs**:

- Lower retrieval quality than cloud options
- First run requires model download

### Gemini (Implemented)

**Model**: `text-embedding-004`

**Strengths**:

- Google's embedding model with strong general-purpose performance
- Generous free tier (1,500 requests/min)
- Fast inference via API

**Trade-offs**:

- 2K token context limit - large functions get truncated
- Not specifically optimized for code
- Requires API key

### Mistral (Implemented)

**Model**: `mistral-embed`

**Strengths**:

- Good balance of quality and cost
- 1024 dimensions capture more semantic nuance
- 8K token context matches local model

**Trade-offs**:

- Requires API key and costs money for large codebases
- Higher dimensions mean slightly larger vector storage

### OpenAI (Implemented)

**Model**: `text-embedding-3-large`

**Strengths**:

- Highest quality embeddings
- 3072 dimensions for maximum semantic nuance
- 8K token context

**Trade-offs**:

- Highest cost ($0.13/1M tokens)
- Requires API key
- Largest vector storage requirements

## Implementation

### Provider Interface

```typescript
interface EmbeddingProvider {
	readonly dimensions: number;
	initialize(): Promise<void>;
	embed(texts: string[]): Promise<number[][]>;
	embedSingle(text: string): Promise<number[]>;
	close(): void;
}
```

All providers implement this interface, allowing seamless swapping based on user selection.

### Local Model Loading

The local provider uses `@huggingface/transformers` for ONNX inference:

```typescript
const model = await pipeline(
	'feature-extraction',
	'jinaai/jina-embeddings-v2-base-code',
	{
		dtype: 'q8', // int8 quantization for smaller size
	},
);
```

### Configuration

```typescript
export const PROVIDER_CONFIGS = {
	local: {
		model: 'jinaai/jina-embeddings-v2-base-code',
		dimensions: 768,
	},
	gemini: {
		model: 'text-embedding-004',
		dimensions: 768,
	},
	mistral: {
		model: 'mistral-embed',
		dimensions: 1024,
	},
	openai: {
		model: 'text-embedding-3-large',
		dimensions: 3072,
	},
};
```

### Dimension Handling

LanceDB stores vectors with fixed dimensions. When switching providers:

1. Delete existing `.viberag/` directory
2. Re-initialize with new provider
3. Full reindex required

This is acceptable for a local tool where reindexing is fast.

## Alternatives Considered

### OpenAI text-embedding-3-small

- Good accuracy but no code-specific training
- Requires API key for all use
- Rejected: No offline option, not code-optimized

### CodeBERT

- Open source, code-focused
- 512 token context limit too restrictive
- Rejected: Context window too small for code files

### Voyage Code 2

- Best-in-class code embeddings
- Expensive ($0.20/1M tokens)
- Rejected: Cost prohibitive for local tool

### BGE Models (bge-small-en, bge-base-en)

- Fast, small, good general embeddings
- Not trained on code
- Rejected: Jina's code-specific training provides better retrieval for code

## Consequences

### Positive

- **Zero-cost default**: Local model works offline without API keys
- **Code-optimized**: Jina model trained specifically on code
- **Large context**: 8K tokens handles most functions without splitting
- **Cloud options**: Gemini, Mistral, and OpenAI available for faster indexing

### Negative

- **~161MB download**: Local model requires initial download
- **No hot-swapping**: Changing provider requires full reindex

### Neutral

- Local model uses ~500MB RAM during inference
- Cloud providers add network latency but parallelize well
