# ADR-004: Embedding Model Selection

## Status

Accepted

## Context

VibeRAG needs embedding models to convert code into vectors for semantic search. Key requirements:

1. **Code-optimized** - Models should understand programming languages and code semantics
2. **Local-first option** - Support offline use without API keys
3. **Quality options** - Higher accuracy options for users willing to use cloud APIs
4. **Reasonable dimensions** - Balance between accuracy and storage/compute costs

## Decision

We support three embedding providers, selectable during `/init`:

### Provider Comparison

| Provider | Model | Dimensions | Context | Cost |
| -------- | ----- | ---------- | ------- | ---- |
| Local | jina-embeddings-v2-base-code | 768 | 8K tokens | Free |
| Gemini | gemini-embedding-001 | 768 | 2K tokens | Free tier / $0.15/1M |
| Mistral | codestral-embed-2505 | 1024 | 8K tokens | $0.15/1M |

**Recommended**: Mistral (codestral-embed) for best code retrieval quality.

### Local (Default)

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

### Gemini

**Model**: `gemini-embedding-001`

**Strengths**:
- Google's embedding model with strong general-purpose performance
- Generous free tier (1,500 requests/min)
- Fast inference via API

**Trade-offs**:
- 2K token context limit - large functions get truncated or split more aggressively
- Not specifically optimized for code
- Requires API key

### Mistral (Recommended)

**Model**: `codestral-embed-2505`

**Strengths**:
- Specifically designed for code understanding
- Built on Codestral, Mistral's code-focused model family
- 1024 dimensions capture more semantic nuance than 768-dim models
- 8K token context matches local model
- Strong performance on code retrieval benchmarks

**Trade-offs**:
- Requires API key and costs money for large codebases
- Higher dimensions mean slightly larger vector storage

## Implementation

### Provider Interface

```typescript
interface EmbeddingProvider {
	embed(texts: string[]): Promise<number[][]>;
	dimensions: number;
	close(): Promise<void>;
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
		device: 'auto', // Uses GPU if available
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
- **Flexibility**: Users choose their quality/cost trade-off
- **Code-optimized**: All options have strong code understanding (Jina trained on code, Mistral built for code)
- **Large context**: 8K tokens (local/Mistral) handles most functions without splitting

### Negative

- **~161MB download**: Local model requires initial download
- **No hot-swapping**: Changing provider requires full reindex

### Neutral

- Local model uses ~500MB RAM during inference
- Cloud providers add network latency but parallelize well
