# VibeRAG

Local code RAG (Retrieval-Augmented Generation) for AI coding assistants. Index your codebase once, search semantically from any AI tool.

## Features

- **Semantic code search** - Find code by meaning, not just keywords
- **Local embeddings** - No API keys required, runs entirely offline
- **MCP server** - Works with Claude Code, Cursor, VS Code Copilot, and more
- **Incremental indexing** - Only re-embeds changed files
- **Multi-language support** - TypeScript, JavaScript, Python, Go, Rust, and more

## Install

```bash
npm install -g viberag
```

## Quick Start

```bash
# Initialize in your project
cd your-project
viberag

# Run /init to configure and index
/init

# Search your codebase
/search authentication handler
```

## MCP Server Setup

VibeRAG includes an MCP server that integrates with AI coding tools. Run `/mcp-setup` in the CLI to configure automatically, or set up manually:

### Supported Editors

| Editor              | Config Location                                   | Setup                                               |
| ------------------- | ------------------------------------------------- | --------------------------------------------------- |
| **Claude Code**     | `.mcp.json`                                       | Auto or `claude mcp add viberag -- npx viberag-mcp` |
| **VS Code Copilot** | `.vscode/mcp.json`                                | Auto                                                |
| **Cursor**          | `.cursor/mcp.json`                                | Auto                                                |
| **Roo Code**        | `.roo/mcp.json`                                   | Auto                                                |
| **Windsurf**        | `~/.codeium/windsurf/mcp_config.json`             | Manual merge                                        |
| **Zed**             | `~/Library/Application Support/Zed/settings.json` | Manual merge                                        |
| **Gemini CLI**      | `~/.gemini/settings.json`                         | `gemini mcp add viberag -- npx viberag-mcp`         |
| **OpenAI Codex**    | `~/.codex/config.toml`                            | `codex mcp add viberag -- npx viberag-mcp`          |
| **JetBrains IDEs**  | Settings UI                                       | Manual in Settings → AI Assistant → MCP             |

### Manual Configuration

For project-level configs (Claude Code, VS Code, Cursor, Roo Code), add to the appropriate file:

```json
{
	"mcpServers": {
		"viberag": {
			"command": "npx",
			"args": ["viberag-mcp"]
		}
	}
}
```

> **Note:** VS Code uses `"servers"` instead of `"mcpServers"`. Zed uses `"context_servers"`.

For global configs, merge the viberag entry into your existing configuration.

## CLI Commands

| Command           | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `/init`           | Initialize VibeRAG (configure embeddings, index codebase) |
| `/index`          | Index the codebase (incremental)                          |
| `/reindex`        | Force full reindex                                        |
| `/search <query>` | Semantic search                                           |
| `/status`         | Show index status                                         |
| `/mcp-setup`      | Configure MCP server for AI tools                         |
| `/clean`          | Remove VibeRAG from project                               |
| `/help`           | Show all commands                                         |

## Embedding Providers

Choose your embedding provider during `/init`:

| Provider  | Model        | Dims | Context | Cost     |
| --------- | ------------ | ---- | ------- | -------- |
| Local     | jina-v2-code | 768  | 8K      | Free     |
| Gemini    | gemini-embedding-001 | 768  | 2K      | $0.15/1M |
| Mistral\* | codestral    | 1024 | 8K      | $0.15/1M |

\*Recommended for best code retrieval quality.

- **Local** - No API key required, ~161MB model download, works offline
- **Gemini** - Requires `GEMINI_API_KEY`, free tier available
- **Mistral** - Requires `MISTRAL_API_KEY`, code-optimized embeddings

## How It Works

1. **Parsing** - Tree-sitter extracts functions, classes, and semantic chunks
2. **Embedding** - Code chunks are embedded using local or API-based models
3. **Storage** - Vectors stored in LanceDB (local, no server required)
4. **Search** - Hybrid search combines vector similarity + full-text search
5. **MCP** - AI tools query the index via the MCP protocol

## TODO: Benefits

- More than just code search.
- Semantic meaning search
- Search documentation, prompts, README markdown files.
- Code + Natural language understanding
- Hybrid search
- Full text search
- Token consumption comparisons
- Speed comparisons
- Number of requests comparisons.

## TODO:
- Change local model to Qwen options
  - Larger option (slow / more ram / best)
  - Smaller option (fast / less ram / lower quality)

Comprehensive Embedding Model Comparison (January 2026)

  Current VibeRAG Providers

  | Provider | Model                                            | Type            | Dims             | Context | Code   | Docs/NL | Price    | MTEB Score        |
  |----------|--------------------------------------------------|-----------------|------------------|---------|--------|---------|----------|-------------------|
  | Mistral  | https://mistral.ai/news/codestral-embed          | Code-optimized  | 1024 (256-3072)  | 8K      | ⭐⭐⭐ | ⭐⭐    | $0.15/1M | SWE-Bench SOTA    |
  | Gemini   | https://ai.google.dev/gemini-api/docs/embeddings | General-purpose | 768 (up to 3072) | 2K      | ⭐⭐⭐ | ⭐⭐⭐  | $0.15/1M | MTEB Multi #1     |
  | OpenAI   | text-embedding-3-large                           | General-purpose | 3072             | 8K      | ⭐⭐⭐ | ⭐⭐⭐  | $0.13/1M | Cross-domain best |
  | Local    | jina-v2-code                                     | Code-specific   | 768              | 8K      | ⭐⭐   | ⭐      | Free     | -                 |

  State-of-the-Art Local Models (January 2026)

  | Model                                                                | Params             | Dims | Context | Code   | Docs/NL | License       | Notes                         |
  |----------------------------------------------------------------------|--------------------|------|---------|--------|---------|---------------|-------------------------------|
  | https://qwenlm.github.io/blog/qwen3-embedding/                       | 8B                 | 4096 | 8K      | ⭐⭐⭐ | ⭐⭐⭐  | Apache 2.0    | MTEB Code: 80.68, 100+ langs  |
  | https://huggingface.co/Qwen/Qwen3-Embedding-0.6B                     | 0.6B               | 1024 | 8K      | ⭐⭐⭐ | ⭐⭐⭐  | Apache 2.0    | MTEB Code: 75.41, lightweight |
  | https://www.qodo.ai/blog/qodo-embed-1-code-embedding-code-retrieval/ | 1.5B               | -    | 8K      | ⭐⭐⭐ | ⭐⭐    | OpenRAIL++    | CoIR: 68.53, beats 7B models  |
  | https://huggingface.co/nomic-ai/nomic-embed-code                     | 7B                 | 768  | -       | ⭐⭐⭐ | ⭐⭐    | Apache 2.0    | CodeSearchNet SOTA, Go: 93.8% |
  | https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe              | 475M (305M active) | 768  | 512     | ⭐⭐   | ⭐⭐⭐  | Apache 2.0    | MoE, 100 languages            |
  | https://ai.google.dev/gemma/docs/embeddinggemma/model_card           | 308M               | 768  | 2K      | ⭐⭐⭐ | ⭐⭐⭐  | Gemma license | <200MB RAM, 22ms EdgeTPU      |
  | https://huggingface.co/BAAI/bge-m3                                   | -                  | 1024 | 8K      | ⭐⭐   | ⭐⭐⭐  | MIT           | 100+ langs, hybrid retrieval  |

  ---
  Key Findings for Code + Natural Language

  Would have the same "hair dye" problem:
  - ❌ codestral-embed - Code-optimized, "code-to-text ratio tuned" but code-focused
  - ❌ jina-v2-code - Code-specific embeddings

  Would work for code + docs/prompts:
  - ✅ gemini-embedding-001 - General-purpose, 100+ languages, excellent cross-domain
  - ✅ OpenAI text-embedding-3-large - "Superior cross-domain performance"
  - ✅ Qwen3-Embedding - Explicitly supports 100+ natural + programming languages

  ---
  Recommendation for VibeRAG

  Best Local Model for Code + Natural Language: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B

  | Advantage     | Details                                                              |
  |---------------|----------------------------------------------------------------------|
  | Balanced      | MTEB Code: 75.41, explicitly supports both code and natural language |
  | Lightweight   | Only 0.6B params vs 7-8B for alternatives                            |
  | Performance   | Outperforms jina-v2 (58.98) by 16+ points on code                    |
  | Multilingual  | 100+ languages including programming languages                       |
  | License       | Apache 2.0 (fully open commercial use)                               |
  | Flexible dims | 1024 default, can be reduced                                         |

  Alternative: https://developers.googleblog.com/en/introducing-embeddinggemma/ - If you need ultra-lightweight (308M params, <200MB RAM).

  ---

## TODO: Check

- Do we limit viberag search that would prevent it from being exhaustive, returning all relevant results? Are we clear about what is truncated?

# Test Edit

This is a test. Again. Test. hair dye