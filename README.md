![VibeRAG Banner](https://github.com/mdrideout/viberag/blob/master/viberag-banner-opt.png?raw=true)

# VIBERAG MCP Server

**Free, Open Source, Local / Offline Capable, Container-Free Semantic Search For Your Codebase**

VibeRAG is fully local, offline capable MCP server for local codebase search.

- Intent-routed codebase search (definitions/files/blocks/usages)
- Hybrid retrieval (full-text + vector search)
- Explainable results with stable follow-ups (open spans, get symbols, find usages)

VibeRAG automatically indexes your codebase into a local container-free vector database ([lancedb](https://lancedb.com/)). Every time you make a change, the indexes are automatically updated.

## Install

```bash
npm install -g viberag
```

## Quick Start

```bash
# Initialize in your project
cd your-project
viberag

# Run the initialization wizard to configure embeddings, run initial indexing, and automatically configure MCP server integration.
/init

# In addition to allowing Agents to search via the MCP server,
# you can search yourself via the CLI.
/search authentication handler
```

### Example

When using a coding agent like [Claude Code](https://claude.ai/code), add `use viberag` to your prompt.

```bash
────────────────────────────────────────────────────────────────────
> How is authentication handled in this repo? use viberag
────────────────────────────────────────────────────────────────────
```

> **Tip:** include "`use viberag`" in your prompt to ensure your agent will use viberag's codebase search features. Most agents will select MCP tools as appropriate, but sometimes they need a little help with explicit prompting.

## Features

- **CLI based setup** - CLI commands and wizards for setup, editor integration, and configuration
- **Agent-first search** - Find definitions, entry files, and relevant blocks (not just “chunks”)
- **Flexible embeddings** - Local model (offline, free) or cloud providers (Gemini, Mistral, OpenAI)
- **MCP server** - Works with Claude Code, Cursor, VS Code Copilot, and more
- **Automatic incremental indexing** - Watches for file changes (respects `.gitignore`) and reindexes only what has changed in real time
- **Cancelable indexing** - Supports `/cancel` and clear status reporting via `/status`
- **Multi-language support** - TypeScript, JavaScript, Python, Go, Rust, and more
- **Blazing fast** - The data storage and search functionality is local on your machine, meaning the full power of your machine can churn through massive amounts of data and execute complex search queries in milliseconds.

### How It Works:

Your coding agent would normally use Search / Grep / Find and guess search terms that are relevant. VibeRAG indexes the codebase into a local vector database (based on [lancedb](https://lancedb.com/)) and can use semantic search to find all relevant code snippets even if the search terms are not exact.

When searching for "authentication", VibeRAG will find all code snippets that are relevant to authentication, such as "login", "logout", "register", and names of functions and classes like `AuthDependency`, `APIKeyCache`, etc.

This ensures comprehensive search of your codebase so you don't miss important files and features that are relevant to your changes or refactor.

### Great for Monorepos

Semantic search is especially useful in monorepos, where you may be trying to understand how different parts of the codebase interact with each other. Viberag can find all the pieces with fewer searches, fewer tokens used, and a shorter amount of time spent searching.

### Embedding Models

_All options store embeddings and indexed data on your local machine_

- **Local:** You can use a locally run embedding model ([Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)) so that nothing leaves your machine. This has a smaller vocabulary and is only recommended for privacy and offline concerns.

- **Recommended:** API generated embeddings from [Gemini](https://ai.google.dev/gemini-api/docs/embeddings), [OpenAI](https://platform.openai.com/docs/guides/embeddings), and [Mistral](https://docs.mistral.ai/capabilities/embeddings) are recommended for the largest vocabulary and highest quality semantic meaning.
  - These embeddings are very affordable at ~10 - 15 cents per million tokens.
  - A typical codebase can be indexed for pennies

## MCP Server

VibeRAG includes an MCP server that integrates with AI coding tools.

### IDE / Agent Setup Wizard

Run `/mcp-setup` in the VibeRAG CLI for interactive setup. This wizard will attempt to automatically configure your coding agents / editors with viberags MCP server settings.

```bash
# Start viberag
$ viberag

# Run the setup wizard (after having initialized with /init)
$ /mcp-setup

# Automatic configuration wizard
╭───────────────────────────────────────────────────────────────╮
│ MCP Setup Wizard                                              │
│                                                               │
│ Select AI coding tool(s) to configure:                        │
│ (Space to toggle, Enter to confirm)                           │
│                                                               │
│ > [x] Claude Code (auto-setup)                                │
│   [ ] Cursor (auto-setup)                                     │
│   [ ] Gemini CLI (global config)                              │
│   [ ] JetBrains IDEs (manual setup)                           │
│   [ ] OpenAI Codex (global config)                            │
│   [ ] OpenCode (global config)                                │
│   [ ] Roo Code (auto-setup)                                   │
│   [ ] VS Code Copilot (auto-setup)                            │
│   [ ] Windsurf (global config)                                │
│   [ ] Zed (global config)                                     │
│                                                               │
│ 1 selected | ↑/↓ move, Space toggle, Enter confirm, Esc cancel│
╰───────────────────────────────────────────────────────────────╯
```

The wizard can auto-configure project-level configs and merge into global configs.

---

### Manual Setup Instructions

The following sections describe manual MCP server setup configurations for various editors and agents.

<details>
<summary><strong>Claude Code</strong></summary>

**CLI Command:**

```bash
claude mcp add viberag -- npx viberag-mcp
```

**Global Config:** `~/.claude.json`

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

**Project Config:** `.mcp.json`

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

**Verify:** Run `/mcp` in Claude Code, look for "viberag: connected"

[Documentation](https://docs.anthropic.com/en/docs/claude-code/mcp)

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Global Config:** `~/.cursor/mcp.json`

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

**Project Config:** `.cursor/mcp.json`

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

**Verify:** Settings → Cursor Settings → MCP, verify "viberag" shows with toggle enabled

[Documentation](https://docs.cursor.com/context/model-context-protocol)

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

**CLI Command:**

```bash
gemini mcp add viberag -- npx viberag-mcp
```

**Global Config:** `~/.gemini/settings.json`

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

**Project Config:** `.gemini/settings.json`

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

**Verify:** Run `/mcp` in Gemini CLI, look for "viberag" in server list

[Documentation](https://googlegemini.io/gemini-cli/docs/mcp)

</details>

<details>
<summary><strong>JetBrains IDEs</strong></summary>

**UI Setup:**

1. Open Settings → Tools → AI Assistant → MCP
2. Click "Add Server"
3. Set name: `viberag`
4. Set command: `npx`
5. Set args: `viberag-mcp`

**Verify:** Settings → Tools → AI Assistant → MCP, verify "viberag" shows green in Status column

[Documentation](https://www.jetbrains.com/help/ai-assistant/mcp.html)

</details>

<details>
<summary><strong>OpenAI Codex</strong></summary>

**CLI Command:**

```bash
codex mcp add viberag -- npx -y viberag-mcp
```

**Global Config:** `~/.codex/config.toml`

```toml
[mcp_servers.viberag]
command = "npx"
args = ["-y", "viberag-mcp"]
```

> **Note:** The `-y` flag is required for npx to auto-confirm package installation

**Verify:** Run `/mcp` in Codex TUI, look for "viberag" in server list

[Documentation](https://codex.openai.com/docs/tools/mcp-servers)

</details>

<details>
<summary><strong>OpenCode</strong></summary>

**Global Config:** `~/.config/opencode/opencode.json` (Linux/macOS) or `%APPDATA%/opencode/opencode.json` (Windows)

```json
{
	"mcp": {
		"viberag": {
			"type": "local",
			"command": ["npx", "-y", "viberag-mcp"]
		}
	}
}
```

**Project Config:** `opencode.json`

```json
{
	"mcp": {
		"viberag": {
			"type": "local",
			"command": ["npx", "-y", "viberag-mcp"]
		}
	}
}
```

> **Note:** OpenCode uses `"mcp"` key and requires `"type": "local"` with command as an array

**Verify:** Check MCP servers list in OpenCode, verify "viberag" appears and is enabled

[Documentation](https://opencode.ai/docs/tools/mcp)

</details>

<details>
<summary><strong>Roo Code</strong></summary>

**Global Config:** UI only — Click MCP icon in Roo Code pane header → Edit Global MCP

**Project Config:** `.roo/mcp.json`

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

**Verify:** Click MCP icon in Roo Code pane header, verify "viberag" appears in server list

[Documentation](https://docs.roocode.com/features/mcp/using-mcp-in-roo)

</details>

<details>
<summary><strong>VS Code Copilot</strong></summary>

**Global Config:** Add to User `settings.json` under `mcp.servers`:

```json
{
	"mcp": {
		"servers": {
			"viberag": {
				"command": "npx",
				"args": ["viberag-mcp"]
			}
		}
	}
}
```

**Project Config:** `.vscode/mcp.json`

```json
{
	"servers": {
		"viberag": {
			"command": "npx",
			"args": ["viberag-mcp"]
		}
	}
}
```

> **Note:** VS Code uses `"servers"` instead of `"mcpServers"`

> **Required:** Enable Agent Mode in VS Code settings:
>
> - Settings → search `chat.agent.enabled` → check the box, OR
> - Add `"chat.agent.enabled": true` to your User `settings.json`

**Verify:** Cmd/Ctrl+Shift+P → "MCP: List Servers", verify "viberag" appears

[Documentation](https://code.visualstudio.com/docs/copilot/chat/mcp-servers)

</details>

<details>
<summary><strong>Windsurf</strong></summary>

**Global Config:** `~/.codeium/windsurf/mcp_config.json`

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

**Verify:** Click Plugins icon in Cascade panel, verify "viberag" shows in plugin list

[Documentation](https://docs.windsurf.com/windsurf/cascade/mcp)

</details>

<details>
<summary><strong>Zed</strong></summary>

**Global Config:** `~/.config/zed/settings.json`

```json
{
	"context_servers": {
		"viberag": {
			"source": "custom",
			"command": "npx",
			"args": ["viberag-mcp"]
		}
	}
}
```

**Project Config:** `.zed/settings.json`

```json
{
	"context_servers": {
		"viberag": {
			"source": "custom",
			"command": "npx",
			"args": ["viberag-mcp"]
		}
	}
}
```

> **Note:** Zed uses `"context_servers"` instead of `"mcpServers"` and requires `"source": "custom"` for non-extension servers

**Verify:** Open Agent Panel settings, verify "viberag" shows green indicator

[Documentation](https://zed.dev/docs/ai/mcp)

</details>

---

## Exposed MCP Tools

Search v2 exposes a small set of agent-centric tools. Backward compatibility
with legacy tool names is not provided.

| Tool             | Description                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `search`         | Intent-routed search with grouped results + stable IDs for follow-ups |
| `open_span`      | Read an exact line range from disk                                    |
| `get_symbol`     | Fetch a symbol definition + deterministic metadata by `symbol_id`     |
| `find_usages`    | Find usage occurrences (refs) for a symbol name or `symbol_id`        |
| `expand_context` | Expand a hit into neighbors (symbols/chunks) and related metadata     |
| `index`          | Build/update the v2 index (incremental by default)                    |
| `status`         | Get v2 index status and daemon status summary                         |
| `watch_status`   | Get watcher status (auto-indexing)                                    |
| `cancel`         | Cancel indexing or warmup without shutting down the daemon            |

### `search`

Single entry point with intent routing. Use `scope` for transparent filters.

- `intent`: `auto|definition|usage|concept|exact_text|similar_code`
- `scope`: `path_prefix`, `path_contains`, `path_not_contains`, `extension`
- `explain`: include per-hit channels + ranking priors

Example:

```json
{
	"query": "how does authentication work",
	"intent": "concept",
	"scope": {
		"path_prefix": ["src/"],
		"path_not_contains": ["test", "__tests__", ".spec.", ".test."]
	},
	"k": 20,
	"explain": true
}
```

Follow-ups: `get_symbol`, `open_span`, `expand_context`, `find_usages`.

## CLI Commands

VibeRAG includes a CLI for easy execution of initialization, indexing, setup, and other things you may want to manually control outside of agent use.

| Command           | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `/init`           | Initialize VibeRAG (configure embeddings, index codebase) |
| `/index`          | Index the codebase (incremental)                          |
| `/reindex`        | Force full reindex                                        |
| `/search <query>` | Semantic search                                           |
| `/status`         | Show daemon and index status                              |
| `/cancel`         | Cancel indexing or warmup                                 |
| `/mcp-setup`      | Configure MCP server for AI tools                         |
| `/clean`          | Remove VibeRAG from project                               |
| `/help`           | Show all commands                                         |

## Logs

VibeRAG writes per-service logs to `.viberag/logs/` with hourly rotation:

- `.viberag/logs/daemon/` - daemon lifecycle and IPC errors
- `.viberag/logs/indexer/` - indexing progress, retries, and batch failures
- `.viberag/logs/mcp/` - MCP server errors
- `.viberag/logs/cli/` - CLI errors

If indexing appears slow or retries are happening, check the latest file under
`.viberag/logs/indexer/`.

## Embedding Providers

Choose your embedding provider during `/init`:

### Local Model - Offline, Free

| Model      | Quant | Download | RAM    |
| ---------- | ----- | -------- | ------ |
| Qwen3-0.6B | Q8    | ~700MB   | ~1.5GB |

- Works completely offline, no API key required
- Initial indexing may take time; future updates are incremental
- Works great for code and natural language (docs, docstrings, code comments, etc.)

### Cloud Providers - Fastest, Best Quality, Largest Vocabulary

| Provider | Model                  | Dims | Cost      | Get API Key                                             |
| -------- | ---------------------- | ---- | --------- | ------------------------------------------------------- |
| Gemini   | gemini-embedding-001   | 1536 | Free tier | [Google AI Studio](https://aistudio.google.com)         |
| Mistral  | codestral-embed        | 1536 | $0.10/1M  | [Mistral Console](https://console.mistral.ai/api-keys/) |
| OpenAI   | text-embedding-3-large | 1536 | $0.13/1M  | [OpenAI Platform](https://platform.openai.com/api-keys) |

- **Gemini** - Free tier available, great for getting started
- **Mistral** - Code-optimized embeddings for technical content
- **OpenAI** - Fast and reliable with low cost

API keys are entered during the `/init` wizard and stored securely in `.viberag/config.json` (automatically added to `.gitignore`).

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

| Approach             | Context Usage | Token Efficiency |
| -------------------- | ------------- | ---------------- |
| Direct viberag calls | 24k tokens    | Baseline         |
| Sub-agent delegation | 3k tokens     | **8x better**    |

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
to use the viberag `search` tool (and follow-ups like `get_symbol` / `open_span`). This keeps the main context clean.
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

| Task Type                       | Recommended Approach                                 |
| ------------------------------- | ---------------------------------------------------- |
| "Where is function X defined?"  | `search` with `intent="definition"`                  |
| "What file handles Y?"          | `search` with `intent="concept"` (check `files`)     |
| "How does authentication work?" | **Sub-agent** - needs multi-step search + follow-ups |
| "Find all API endpoints"        | **Sub-agent** - iterative search + scope filters     |
| "Understand the data flow"      | **Sub-agent** - iterative exploration                |

### For Platforms Without Sub-Agents

Use a few targeted `search` calls with different intents, then follow up with
`get_symbol`, `open_span`, `expand_context`, and `find_usages` as needed.

Example sequence:

```json
{"query": "authentication", "intent": "concept", "k": 20}
```

```json
{
	"query": "login",
	"intent": "definition",
	"k": 20,
	"scope": {"path_prefix": ["src/"]}
}
```

```json
{"symbol_name": "login", "k": 200}
```

## Troubleshooting

### Watcher EMFILE (too many open files)

Large repos can exceed OS watch limits. The watcher now honors `.gitignore`, but if you still see EMFILE:

- Add more ignores in `.gitignore` to reduce watched files.
- Increase OS limits:
  - macOS: raise `kern.maxfiles`, `kern.maxfilesperproc`, and `ulimit -n`
  - Linux: raise `fs.inotify.max_user_watches`, `fs.inotify.max_user_instances`, and `ulimit -n`

### Index failures (network/API errors)

If indexing fails due to transient network/API issues:

- Run `/status` to confirm daemon/index state.
- Re-run `/index` after connectivity is stable.
- Use `/cancel` to stop a stuck run, then `/reindex` if you need a clean rebuild.
