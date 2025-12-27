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

| Provider | Model | Dimensions | Context | Accuracy | Cost |
|----------|-------|------------|---------|----------|------|
| Local | jina-v2-base-code | 768 | 8K | ~70% | Free |
| Gemini | gemini-embedding-001 | 768 | 2K | 75% | $0.15/1M |
| Mistral | codestral-embed-2505 | 1024 | 8K | 85% | $0.15/1M |

### Local (Default)

**Model**: `jinaai/jina-embeddings-v2-base-code` (fp16 quantized)

- **Why Jina**: Purpose-built for code, trained on GitHub data, understands 30+ programming languages
- **Why fp16**: Reduces model size from ~600MB to ~321MB with minimal accuracy loss
- **Trade-off**: Lower accuracy than cloud options, but zero latency and no API costs

### Gemini

**Model**: `gemini-embedding-001`

- **Why Gemini**: Google's general-purpose embedding model with strong multilingual support
- **Free tier**: 1,500 requests/min, suitable for most projects
- **Trade-off**: 2K context limit means large files get chunked more aggressively

### Mistral

**Model**: `codestral-embed-2505`

- **Why Mistral**: Highest accuracy for code (85% on code retrieval benchmarks)
- **Why 1024 dims**: Higher dimensionality captures more semantic nuance
- **Trade-off**: Requires API key, costs money for large codebases

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

The local provider uses `@xenova/transformers` for ONNX inference:

```typescript
const model = await pipeline('feature-extraction', 'jinaai/jina-embeddings-v2-base-code', {
  dtype: 'fp16',
  device: 'auto',  // Uses GPU if available
});
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
- Rejected: No offline option

### CodeBERT

- Open source, code-focused
- 512 token context limit too restrictive
- Rejected: Context window too small for code files

### Voyage Code 2

- Best-in-class code embeddings
- Expensive ($0.20/1M tokens)
- Rejected: Cost prohibitive for local tool

## Consequences

### Positive

- **Zero-cost option**: Local model works offline without API keys
- **Flexibility**: Users choose their accuracy/cost trade-off
- **Code-optimized**: All options understand programming concepts

### Negative

- **321MB download**: Local model requires initial download
- **Accuracy gap**: Local model ~15% lower accuracy than Mistral
- **No hot-swapping**: Changing provider requires reindex

### Neutral

- Accuracy percentages are approximate (based on MTEB code retrieval benchmarks)
- Local model uses ~500MB RAM during inference
