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

### Local Model - Offline, Free

| Model      | Quant | Download | RAM    |
| ---------- | ----- | -------- | ------ |
| Qwen3-0.6B | Q8    | ~700MB   | ~10GB  |

- Works completely offline, no API key required
- Initial indexing may take time; future updates are incremental

### Frontier Models - Fastest, Best Quality

| Provider | Model                  | Dims | Cost      |
| -------- | ---------------------- | ---- | --------- |
| Gemini   | gemini-embedding-001   | 768  | Free tier |
| Mistral  | codestral-embed        | 1024 | $0.10/1M  |
| OpenAI   | text-embedding-3-small | 1536 | $0.02/1M  |

- **Gemini** - Free tier available with `GEMINI_API_KEY`
- **Mistral** - Code-optimized embeddings. Requires `MISTRAL_API_KEY`
- **OpenAI** - Fast and reliable. Requires `OPENAI_API_KEY`

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

## TODO: Check

- Do we limit viberag search that would prevent it from being exhaustive, returning all relevant results? Are we clear about what is truncated?

# Test Edit

This is a test. Again. Test. hair dye