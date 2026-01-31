# ADR-004: Embedding Model Selection

## Status

Accepted (Updated January 2026)

## Context

VibeRAG needs embedding models to convert code into vectors for semantic search. Key requirements:

1. **Code-optimized** - Models should understand programming languages and code semantics
2. **Local-first option** - Support offline use without API keys
3. **Quality options** - Higher accuracy options for users willing to use cloud APIs
4. **Reasonable dimensions** - Balance between accuracy and storage/compute costs

## Decision

We support four embedding providers, selectable during `/init`:

### Provider Comparison

| Provider | Model                  | Dimensions | Context    | Cost      | Status      |
| -------- | ---------------------- | ---------- | ---------- | --------- | ----------- |
| Local    | Qwen3-Embedding-0.6B   | 1024       | 32K tokens | Free      | Implemented |
| Gemini\* | gemini-embedding-001   | 1536       | 2K tokens  | Free tier | Implemented |
| Mistral  | codestral-embed        | 1536       | 8K tokens  | $0.10/1M  | Implemented |
| OpenAI   | text-embedding-3-large | 1536       | 8K tokens  | $0.13/1M  | Implemented |

\*Default provider - fast API with generous free tier.

### Local (Implemented)

**Model**: `Qwen/Qwen3-Embedding-0.6B` with int8 (q8) quantization

**Strengths**:

- Strong embedding quality from Qwen3 architecture
- 32K token context handles entire files without truncation
- Zero latency, works offline, no API costs
- ~700MB model download, ~1.2GB RAM usage

**Trade-offs**:

- Lower retrieval quality than cloud options
- First run requires model download
- Slower than API providers for large codebases

### Gemini (Default, Implemented)

**Model**: `gemini-embedding-001`

**Strengths**:

- Google's embedding model with strong general-purpose performance
- Generous free tier (1,500 requests/min)
- Fast inference via API
- 1536 dimensions for good semantic capture

**Trade-offs**:

- 2K token context limit - large functions get truncated
- Not specifically optimized for code
- Requires API key

### Mistral (Implemented)

**Model**: `codestral-embed`

**Strengths**:

- Code-optimized embedding model from Mistral AI
- 1536 dimensions capture semantic nuance
- 8K token context handles most code files
- Good balance of quality and cost

**Trade-offs**:

- Requires API key and costs money for large codebases

### OpenAI (Implemented)

**Model**: `text-embedding-3-large` with reduced dimensions (1536)

**Strengths**:

- Highest quality embeddings from OpenAI
- Uses Matryoshka Representation Learning for efficient dimension reduction
- 1536 dimensions (reduced from 3072) for storage efficiency
- 8K token context

**Trade-offs**:

- Requires API key
- Higher cost than text-embedding-3-small ($0.13/1M vs $0.02/1M)

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
	'Qwen/Qwen3-Embedding-0.6B',
	{
		dtype: 'q8', // int8 quantization for smaller size
	},
);
```

### Configuration

```typescript
export const PROVIDER_CONFIGS = {
	local: {
		model: 'Qwen/Qwen3-Embedding-0.6B',
		dimensions: 1024,
	},
	gemini: {
		model: 'gemini-embedding-001',
		dimensions: 1536,
	},
	mistral: {
		model: 'codestral-embed',
		dimensions: 1536,
	},
	openai: {
		model: 'text-embedding-3-large',
		dimensions: 1536,
	},
};
```

### Dimension Handling

LanceDB stores vectors with fixed dimensions. When switching providers:

1. Delete the project's data directory (`~/.local/share/viberag/projects/<projectId>/`, override via `VIBERAG_HOME`) or run `/clean`
2. Re-initialize with new provider
3. Full reindex required

This is acceptable for a local tool where reindexing is fast.

## Alternatives Considered

### Jina Embeddings v2 (Previously Used)

- `jinaai/jina-embeddings-v2-base-code` - 768 dimensions, 8K context
- Replaced by Qwen3-Embedding-0.6B for better quality and larger context window

### OpenAI text-embedding-3-large

- Higher quality (3072 dimensions)
- Higher cost ($0.13/1M tokens)
- Rejected: Cost-to-benefit ratio not justified for code search

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

- **Cloud default**: Gemini provides fast indexing with free tier
- **Offline option**: Local model works without API keys
- **Large context**: 32K tokens (local) handles entire files without splitting
- **Multiple options**: Users can choose based on their needs

### Negative

- **~700MB download**: Local model requires initial download
- **No hot-swapping**: Changing provider requires full reindex

### Neutral

- Local model uses ~1.2GB RAM during inference
- Cloud providers add network latency but parallelize well
