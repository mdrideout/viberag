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
| **OpenCode**        | `~/.config/opencode/opencode.json`                | Manual merge                                        |
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

| Model      | Quant | Download | RAM   |
| ---------- | ----- | -------- | ----- |
| Qwen3-0.6B | Q8    | ~700MB   | ~10GB |

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

## AI Agent Best Practices

VibeRAG works best when AI agents use **sub-agents for exploration tasks**. This keeps the main conversation context clean and uses ~8x fewer tokens.

### Why Sub-Agents?

When an AI calls viberag directly, all search results expand the main context. Sub-agents run searches in isolated context windows and return only concise summaries.

| Approach | Context Usage | Token Efficiency |
|----------|---------------|------------------|
| Direct viberag calls | 24k tokens | Baseline |
| Sub-agent delegation | 3k tokens | **8x better** |

### Platform-Specific Guidance

#### Claude Code
```
# For exploration tasks, use the Task tool:
Task(subagent_type='Explore', prompt='Use viberag to find how authentication works')

# For parallel comprehensive search:
Task(subagent_type='Explore', prompt='Search auth patterns') # runs in parallel
Task(subagent_type='Explore', prompt='Search login flows')   # with this one
```

Add to your `CLAUDE.md`:
```markdown
When exploring the codebase, use Task(subagent_type='Explore') and instruct it
to use viberag_search or viberag_multi_search. This keeps the main context clean.
```

#### VS Code Copilot
- Use **Agent HQ** to delegate exploration to background agents
- Background agents can iterate with viberag without blocking your session
- Use `/delegate` to hand off exploration tasks to Copilot coding agent

#### Cursor
- Enable **Agent mode** for multi-step exploration
- Agent mode can orchestrate multiple viberag searches autonomously
- Consider the [Sub-Agents MCP server](https://playbooks.com/mcp/shinpr-sub-agents) for Claude Code-style delegation

#### Windsurf
- **Cascade** automatically plans multi-step tasks
- Enable **Turbo Mode** for autonomous exploration
- Cascade's planning agent will orchestrate viberag calls efficiently

#### Roo Code
- Use **Architect mode** for exploration and understanding
- **Boomerang tasks** coordinate complex multi-mode workflows
- Each mode (Architect, Code, Debug) can use viberag with focused context

#### Gemini CLI
- Create **extensions** that scope viberag tools for specific tasks
- Extensions can bundle viberag with custom prompts for specialized exploration
- Use `gemini mcp add viberag` then reference in extension configs

#### OpenAI Codex
- Use **Agents SDK** to orchestrate viberag as an MCP tool
- Codex can run as an MCP server itself for multi-agent setups
- Approval modes control how autonomously Codex explores

#### JetBrains IDEs
- **Junie** agent handles multi-step exploration autonomously
- **Claude Agent** integration provides sub-agent-like capabilities
- Access viberag through AI Chat with multi-agent support

#### Zed
- Use **External Agents** (Claude Code, Codex, Gemini CLI) for exploration
- Set `auto_approve` in settings for autonomous agent operation
- ACP (Agent Client Protocol) enables BYO agent integration

### Quick Lookup vs Exploration

| Task Type | Recommended Approach |
|-----------|---------------------|
| "Where is function X defined?" | Direct `viberag_search` with mode='definition' |
| "What file handles Y?" | Direct `viberag_search` - single query |
| "How does authentication work?" | **Sub-agent** - needs multiple searches |
| "Find all API endpoints" | **Sub-agent** or `viberag_multi_search` |
| "Understand the data flow" | **Sub-agent** - iterative exploration |

### For Platforms Without Sub-Agents

Use `viberag_multi_search` to run multiple search strategies in a single call:

```json
{
  "searches": [
    {"query": "authentication", "mode": "semantic"},
    {"query": "auth login", "mode": "exact"},
    {"query": "user session", "mode": "hybrid", "bm25_weight": 0.5}
  ],
  "merge_results": true,
  "merge_strategy": "rrf"
}
```

This provides comprehensive coverage without multiple round-trips.
