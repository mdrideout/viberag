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
| Local     | jina-embeddings-v2-base-code | 768        | 8K tokens | Free                 | Implemented |
| Gemini    | gemini-embedding-001         | 768        | 2K tokens | Free tier / $0.15/1M | Planned     |
| Mistral\* | codestral-embed-2505         | 1024       | 8K tokens | $0.15/1M             | Planned     |

\*Recommended for best code retrieval quality.

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

### Gemini (Planned)

**Model**: `gemini-embedding-001`

**Strengths**:

- Google's embedding model with strong general-purpose performance
- Generous free tier (1,500 requests/min)
- Fast inference via API

**Trade-offs**:

- 2K token context limit - large functions get truncated
- Not specifically optimized for code
- Requires API key

### Mistral (Planned)

**Model**: `codestral-embed-2505`

**Strengths**:

- Specifically designed for code understanding
- Built on Codestral, Mistral's code-focused model family
- 1024 dimensions capture more semantic nuance
- 8K token context matches local model
- Strong performance on code retrieval benchmarks

**Trade-offs**:

- Requires API key and costs money for large codebases
- Higher dimensions mean slightly larger vector storage

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
		dtype: 'q8',
	},
	gemini: {
		model: 'gemini-embedding-001',
		dimensions: 768,
	},
	mistral: {
		model: 'codestral-embed-2505',
		dimensions: 1024,
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
- **Cloud options**: Gemini and Mistral available for faster indexing (when implemented)

### Negative

- **~161MB download**: Local model requires initial download
- **No hot-swapping**: Changing provider requires full reindex
- **Cloud providers pending**: Gemini and Mistral implementations in progress

### Neutral

- Local model uses ~500MB RAM during inference
- Cloud providers add network latency but parallelize well
