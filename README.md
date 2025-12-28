# VibeRAG

Local code RAG (Retrieval-Augmented Generation) for AI coding assistants. Index your codebase once, search semantically from any AI tool.

## Features

- **Semantic code search** - Find code by meaning, not just keywords
- **Local embeddings** - No API keys required (optional cloud providers for speed)
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
| `/help`           | Show all commands                                         |

## Embedding Providers

Configure during `/init`:

| Provider     | Model                               | Dimensions | Speed   | API Key |
| ------------ | ----------------------------------- | ---------- | ------- | ------- |
| `local`      | jina-embeddings-v2-base-code (fp16) | 768        | Medium  | No      |
| `local-fast` | jina-embeddings-v2-base-code (int8) | 768        | Fast    | No      |
| `gemini`     | gemini-embedding-001                | 768        | Fastest | Yes     |
| `mistral`    | codestral-embed-2505                | 1024       | Fast    | Yes     |

## How It Works

1. **Parsing** - Tree-sitter extracts functions, classes, and semantic chunks
2. **Embedding** - Code chunks are embedded using your chosen provider
3. **Storage** - Vectors stored in local SQLite with vec0 extension
4. **Search** - Hybrid search combines vector similarity + full-text search
5. **MCP** - AI tools query the index via the MCP protocol

## License

MIT
