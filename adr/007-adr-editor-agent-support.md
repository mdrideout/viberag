# ADR-007: Editor and Agent MCP Support

## Status

Accepted

## Context

VibeRAG's MCP setup wizard supports multiple AI coding tools. As the ecosystem evolves, new agents and IDEs add MCP support. This ADR documents:

1. Comprehensive reference for all currently supported editors (both local AND global configurations)
2. The standardized process for adding new editors
3. Grounded documentation links from official sources (via Context7)

## Currently Supported Editors

> **Last Updated:** January 2026 (via Context7 research)

### Scope Support Summary

| Editor          | Global Config | Project Config | CLI Command | Recommended Default  |
| --------------- | :-----------: | :------------: | :---------: | :------------------: |
| Claude Code     |      Yes      |      Yes       |     Yes     |      **Global**      |
| Cursor          |      Yes      |      Yes       |     No      |      **Global**      |
| VS Code Copilot | Yes (manual)  |      Yes       |     No      |      **Global**      |
| Windsurf        |      Yes      |       No       |     No      | Global (only option) |
| Zed             |      Yes      |      Yes       |     No      |      **Global**      |
| Gemini CLI      |      Yes      |      Yes       |     Yes     |      **Global**      |
| JetBrains IDEs  |    UI only    |       No       |     No      |   UI (only option)   |
| OpenAI Codex    |      Yes      |       No       |     Yes     | Global (only option) |
| OpenCode        |      Yes      |      Yes       |     No      |      **Global**      |
| Roo Code        |    UI only    |      Yes       |     No      |      **Global**      |

### Configuration Paths Reference

| Editor          | Global Path                           | Project Path            | JSON Key          | Format |
| --------------- | ------------------------------------- | ----------------------- | ----------------- | ------ |
| Claude Code     | `~/.claude.json`                      | `.mcp.json`             | `mcpServers`      | JSON   |
| Cursor          | `~/.cursor/mcp.json`                  | `.cursor/mcp.json`      | `mcpServers`      | JSON   |
| VS Code Copilot | User `settings.json` → `mcp.servers`  | `.vscode/mcp.json`      | `servers`         | JSON   |
| Windsurf        | `~/.codeium/windsurf/mcp_config.json` | N/A                     | `mcpServers`      | JSON   |
| Zed             | `~/.config/zed/settings.json`         | `.zed/settings.json`    | `context_servers` | JSON   |
| Gemini CLI      | `~/.gemini/settings.json`             | `.gemini/settings.json` | `mcpServers`      | JSON   |
| JetBrains IDEs  | Settings UI                           | N/A                     | N/A               | UI     |
| OpenAI Codex    | `~/.codex/config.toml`                | N/A                     | `mcp_servers`     | TOML   |
| OpenCode        | `~/.config/opencode/opencode.json`    | `opencode.json`         | `mcp`             | JSON   |
| Roo Code        | VS Code settings UI                   | `.roo/mcp.json`         | `mcpServers`      | JSON   |

### Working Directory (cwd) Support

> **Last Updated:** January 2026 (via Context7 research)

This table documents whether each editor supports explicit `cwd` (working directory) configuration for MCP servers, and what the default behavior is.

| Editor          | Has `cwd` Config | Default cwd                          | Variable Support                  |
| --------------- | :--------------: | ------------------------------------ | --------------------------------- |
| Claude Code     |       Yes        | Project root                         | `${workspaceFolder}`              |
| Cursor          |       Yes        | Project root                         | `${workspaceFolder}` in args      |
| VS Code Copilot |       Yes        | Project root                         | `${workspaceFolder}`              |
| Windsurf        |        No        | Unspecified (likely editor location) | N/A                               |
| Zed             |        No        | Extension receives `project` param   | N/A                               |
| Gemini CLI      |       Yes        | CLI's current directory              | Relative paths (e.g., `"./path"`) |
| JetBrains       |        No        | Unspecified                          | N/A                               |
| OpenAI Codex    |       Yes        | CLI's current directory              | Relative paths                    |
| OpenCode        |        No        | CLI's current directory              | N/A                               |
| Roo Code        |       Yes        | Project root                         | Relative paths                    |

**Documentation Sources:**

- **VS Code Copilot**: [VS Code MCP Servers](https://github.com/microsoft/vscode-docs/blob/main/docs/copilot/customization/mcp-servers.md) — Quote: "cwd: The working directory of the server. You can use `${workspaceFolder}` to reference the root of the workspace."
- **Cursor**: [Cursor MCP Configuration](https://docs.cursor.com/context/mcp) — Quote: "You can use `${workspaceFolder}` to reference the root of your project for arguments."
- **Roo Code**: [Roo Code MCP Usage](https://github.com/roocodeinc/roo-code-docs/blob/main/docs/features/mcp/using-mcp-in-roo.mdx) — Quote: `"cwd": "/path/to/project/root"` shown in STDIO transport config example
- **Gemini CLI**: [Gemini CLI MCP Server](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) — Quote: `"cwd": "./mcp-servers/python"` shown in config; "Working directory for Stdio transport"
- **OpenAI Codex**: [Codex MCP Configuration](https://github.com/context7/developers_openai_codex/blob/main/mcp.md) — Quote: "For STDIO servers, you can specify... the working directory `cwd`"
- **Zed**: [Zed MCP Extensions](https://github.com/zed-industries/zed/blob/main/docs/src/extensions/mcp-extensions.md) — Quote: Extension method receives `project: &zed::Project` parameter; no cwd field in custom server JSON config
- **Windsurf**: [Windsurf MCP Configuration](https://github.com/context7/windsurf/blob/main/plugins/cascade/mcp.md) — Config shows `command`, `args`, `env` only; no cwd option documented
- **JetBrains**: [JetBrains AI Assistant MCP](https://github.com/context7/jetbrains_help/blob/main/ai-assistant/mcp.md) — Config examples use absolute paths; no cwd option in server configuration
- **OpenCode**: [OpenCode MCP Servers](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/mcp-servers.mdx) — Local server config shows `type`, `command`, `environment`, `enabled`; no cwd option documented

**Key Findings:**

1. **IDE-based editors** (VS Code, Cursor, Roo Code) default to the **project/workspace root** as the working directory when no `cwd` is specified

2. **CLI-based tools** (Gemini CLI, Codex, OpenCode) default to the **current working directory** where the CLI was launched

3. **Editors with explicit `cwd` support** can be configured:
   - **VS Code**: `"cwd": "${workspaceFolder}"`
   - **Cursor**: Uses `${workspaceFolder}` in args
   - **Roo Code**: `"cwd": "/path/to/project/root"`
   - **Gemini CLI**: `"cwd": "./mcp-servers/python"`
   - **OpenAI Codex**: `cwd = "./path"` in TOML

4. **Editors without `cwd` support** (Windsurf, Zed, JetBrains, OpenCode):
   - Use absolute paths in command args when project path is needed
   - Zed extensions receive a `project` parameter for context

**Implications for VibeRAG:**

Since viberag-mcp needs to access the project's `.viberag/` directory, it uses `process.cwd()` as the project root (`source/mcp/index.ts:17`).

**No changes needed to setup or wizards.** The current approach works correctly because:

1. **IDE-based editors** (VS Code, Cursor, Windsurf, Zed, JetBrains, Roo Code) launch MCP processes with the workspace/project root as the working directory
2. **CLI-based tools** (Claude Code, Gemini CLI, Codex, OpenCode) inherit the user's shell cwd, which is typically the project directory
3. **Global configs work correctly** — while the MCP config is global, each editor session spawns a separate MCP process with its own cwd set to the active project

This is the **standard pattern** for MCP servers. Each project gets its own MCP process instance with the correct working directory, regardless of whether the config is global or project-scoped.

**Configuration Examples with `cwd`:**

```json
// VS Code Copilot (.vscode/mcp.json)
{
  "servers": {
    "viberag": {
      "command": "npx",
      "args": ["-y", "viberag-mcp"],
      "cwd": "${workspaceFolder}"
    }
  }
}

// Roo Code (.roo/mcp.json)
{
  "mcpServers": {
    "viberag": {
      "command": "npx",
      "args": ["-y", "viberag-mcp"],
      "cwd": "/path/to/project/root"
    }
  }
}

// Gemini CLI (~/.gemini/settings.json)
{
  "mcpServers": {
    "viberag": {
      "command": "npx",
      "args": ["-y", "viberag-mcp"],
      "cwd": "./my-project"
    }
  }
}
```

```toml
# OpenAI Codex (~/.codex/config.toml)
[mcp_servers.viberag]
command = "npx"
args = ["-y", "viberag-mcp"]
cwd = "/path/to/project"
```

### Post-Setup Enablement Requirements

> **Last Updated:** January 2026 (via Context7 research)

After configuring an MCP server, **you may need to explicitly enable the MCP server inside the editor/IDE**. Each editor has different mechanisms for enabling MCP servers:

| Editor          | Enablement Method                                           |
| --------------- | ----------------------------------------------------------- |
| Claude Code     | Automatic (servers start when configured)                   |
| Cursor          | Settings → Features → MCP (toggle per server)               |
| VS Code Copilot | Must enable `chat.agent.enabled: true` in VS Code settings  |
| Windsurf        | Tools tab (toggle per tool)                                 |
| Zed             | Agent settings: `agent.enabled` and per-profile controls    |
| Gemini CLI      | Automatic (servers start when configured)                   |
| JetBrains       | UI toggle in Settings → AI Assistant → MCP                  |
| OpenAI Codex    | `enabled = true/false` in config.toml                       |
| OpenCode        | `"enabled": true/false` in config                           |
| Roo Code        | "Enable MCP Servers" checkbox + per-server `disabled` field |

**Key Examples:**

```json
// VS Code: Enable Agent Mode in User settings.json
{
	"chat.agent.enabled": true
}
```

```json
// OpenCode: Enable/disable per server
{
	"mcp": {
		"viberag": {
			"type": "local",
			"command": ["npx", "-y", "viberag-mcp"],
			"enabled": true
		}
	}
}
```

```toml
# OpenAI Codex: Enable/disable per server
[mcp_servers.viberag]
command = "npx"
args = ["-y", "viberag-mcp"]
enabled = true
```

**Documentation Sources:**

- **VS Code Copilot**: [VS Code Agent Mode](https://github.com/microsoft/vscode-docs/blob/main/blogs/2025/04/07/agentMode.md) — Quote: "set `setting(chat.agent.enabled:true)` in your settings"
- **Cursor**: [Cursor MCP Docs](https://cursor.com/docs/context/mcp) — Quote: "Click the toggle next to any server to enable/disable"
- **Roo Code**: [Roo Code MCP Usage](https://github.com/roocodeinc/roo-code-docs/blob/main/docs/features/mcp/using-mcp-in-roo.mdx) — Quote: "Click the server icon → Check/Uncheck 'Enable MCP Servers'"
- **OpenCode**: [OpenCode MCP Servers](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/mcp-servers.mdx) — Quote: "You can disable a server by setting `enabled` to `false`"
- **OpenAI Codex**: [Codex MCP Config](https://github.com/context7/developers_openai_codex/blob/main/mcp.md) — Quote: "You can disable a configured server without removing it by setting `enabled = false`"

**Implications for VibeRAG Wizard:**

The wizard should display a general note that users may need to enable the MCP server inside their editor after configuration.

---

## Detailed Editor Documentation

### 1. Claude Code

**Supports:** Global, Project, CLI

| Scope               | Path             | Description                                 |
| ------------------- | ---------------- | ------------------------------------------- |
| **Local** (default) | `~/.claude.json` | Private to current project, not shared      |
| **User**            | `~/.claude.json` | Available across all projects for this user |
| **Project**         | `.mcp.json`      | Shared with team via version control        |

**CLI Commands:**

```bash
# Add to local scope (default) - stored in ~/.claude.json
claude mcp add viberag -- npx viberag-mcp

# Explicitly specify local scope
claude mcp add viberag --scope local -- npx viberag-mcp

# Add to user scope - available across all projects
claude mcp add viberag --scope user -- npx viberag-mcp

# Add to project scope - stored in .mcp.json for team sharing
claude mcp add viberag --scope project -- npx viberag-mcp
```

**Configuration Example (`.mcp.json` or `~/.claude.json`):**

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

**Precedence:** Project scope > Local/User scope

**Documentation Sources:**

- [Claude Code MCP Scopes](https://github.com/context7/code_claude/blob/main/en/mcp.md) - Quote: "local (the default) makes the server available only in the current project. project shares the configuration with everyone in the project via a .mcp.json file. user makes the server available across all your projects."
- [Plugin MCP Integration](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/mcp-integration/SKILL.md)

---

### 2. Cursor

**Supports:** Global, Project

| Scope       | Path                 | Description                    |
| ----------- | -------------------- | ------------------------------ |
| **Global**  | `~/.cursor/mcp.json` | Available across all projects  |
| **Project** | `.cursor/mcp.json`   | Project-specific configuration |

**Configuration Example:**

```json
{
	"mcpServers": {
		"viberag": {
			"command": "npx",
			"args": ["-y", "viberag-mcp"]
		}
	}
}
```

**Precedence:** Project config takes precedence when both exist

**Documentation Sources:**

- [Cursor MCP Configuration](https://docs.cursor.com/de/context/mcp) - Quote: "This configuration is typically placed in `.cursor/mcp.json` or `~/.cursor/mcp.json`"

---

### 3. VS Code Copilot

**Supports:** Global (User Settings), Project, Workspace, Remote

| Scope                  | Path                               | Description                 |
| ---------------------- | ---------------------------------- | --------------------------- |
| **User Settings**      | `settings.json` → `mcp.servers`    | Global for all workspaces   |
| **Workspace Settings** | `.code-workspace` → `settings.mcp` | Multi-root workspace        |
| **Project**            | `.vscode/mcp.json`                 | Project-specific, shareable |
| **Remote Settings**    | Remote `settings.json`             | For remote development      |

**Global Configuration (User `settings.json`):**

```json
{
	"mcp": {
		"servers": {
			"viberag": {
				"command": "npx",
				"args": ["-y", "viberag-mcp"]
			}
		}
	}
}
```

**Project Configuration (`.vscode/mcp.json`):**

```json
{
	"servers": {
		"viberag": {
			"command": "npx",
			"args": ["-y", "viberag-mcp"]
		}
	}
}
```

**Special Requirements:**

- Uses `servers` key, not `mcpServers`
- **JSONC Format:** VS Code uses JSONC (JSON with Comments) for settings files. Comments and trailing commas are allowed.

**Precedence:** Workspace > User settings

**Implementation Note (Auto-Config Limitation):**

VS Code's global MCP config is stored in User `settings.json`, which has platform-specific paths:

- macOS: `~/Library/Application Support/Code/User/settings.json`
- Linux: `~/.config/Code/User/settings.json`
- Windows: `%APPDATA%\Code\User\settings.json`

Due to this complexity and the need to safely merge into existing user settings (which contain many other VS Code preferences), the MCP setup wizard shows **manual instructions for global scope** while providing **auto-configuration for project scope** only (`.vscode/mcp.json`).

**Documentation Sources:**

- [VS Code MCP Servers](https://github.com/microsoft/vscode-docs/blob/main/docs/copilot/customization/mcp-servers.md)
- [VS Code v1.99 Release Notes](https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_99.md) - Quote: "MCP servers can be configured under the `mcp` section in your user, remote, or `.code-workspace` settings, or in `.vscode/mcp.json` in your workspace"

---

### 4. Windsurf

**Supports:** Global only

| Scope      | Path                                                    | Description |
| ---------- | ------------------------------------------------------- | ----------- |
| **Global** | `~/.codeium/windsurf/mcp_config.json`                   | macOS/Linux |
| **Global** | `C:\Users\[Username]\.codeium\windsurf\mcp_config.json` | Windows     |

**Configuration Example:**

```json
{
	"mcpServers": {
		"viberag": {
			"command": "npx",
			"args": ["-y", "viberag-mcp"]
		}
	}
}
```

**Note:** Windsurf does NOT support project-level MCP configuration. Global only.

**Documentation Sources:**

- [Windsurf MCP Configuration](https://github.com/context7/windsurf-windsurf/blob/main/cascade/mcp.md)
- [Windsurf Cascade MCP](https://docs.windsurf.com/windsurf/cascade/mcp)
- [Windsurf Config Location](https://github.com/context7/docs_windsurf_com-windsurf-getting-started/blob/main/windsurf/mcp.md) - Shows `~/.codeium/windsurf` as config directory

---

### 5. Zed

**Supports:** Global, Project

| Scope       | Path                                 | Description                    |
| ----------- | ------------------------------------ | ------------------------------ |
| **Global**  | `~/.config/zed/settings.json`        | macOS and Linux                |
| **Global**  | `$XDG_CONFIG_HOME/zed/settings.json` | Linux (if XDG_CONFIG_HOME set) |
| **Project** | `.zed/settings.json`                 | Project-specific settings      |

**Configuration Example:**

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

**Special Requirements:**

- **`"source": "custom"` is REQUIRED** for non-extension MCP servers
- Uses `context_servers` key (not `mcpServers`)
- Global path is `~/.config/zed/settings.json` on BOTH macOS and Linux
- **JSONC Format:** Zed uses JSONC (JSON with Comments) for settings files. Comments (`//`, `/* */`) and trailing commas are allowed.

**Implementation Note (Bug Fix):**

Zed's settings.json commonly contains comments. The MCP setup wizard must handle JSONC format:

```typescript
// source/cli/commands/mcp-setup.ts
// 1. stripJsonComments() - Strips // and /* */ comments before parsing
// 2. readJsonConfig() - Uses stripJsonComments() for JSONC support
// 3. mergeConfig() - Must use generateZedViberagConfig() for "source": "custom"
```

Without JSONC parsing, `JSON.parse()` fails on files with comments, causing the wizard to show "Skipped" instead of successfully merging the config.

**Precedence:** Project settings merge with global; some settings like `theme` only apply from global

**Documentation Sources:**

- [Zed Configuration](https://github.com/context7/zed_dev/blob/main/configuring-zed.md) - Quote: "The user settings JSON file, typically located at `~/.config/zed/settings.json`... Project-specific settings can be managed by creating a `.zed/settings.json` file within the project's root directory"
- [Zed AI MCP](https://github.com/context7/zed_dev/blob/main/ai/mcp.md)

---

### 6. Gemini CLI

**Supports:** Global (User), Project, System, CLI

| Scope                | Path                                                                  | Description        |
| -------------------- | --------------------------------------------------------------------- | ------------------ |
| **System Defaults**  | `/etc/gemini-cli/system-defaults.json` (Linux)                        | Lowest precedence  |
|                      | `/Library/Application Support/GeminiCli/system-defaults.json` (macOS) |                    |
|                      | `C:\ProgramData\gemini-cli\system-defaults.json` (Windows)            |                    |
| **User**             | `~/.gemini/settings.json`                                             | User-wide settings |
| **Project**          | `.gemini/settings.json`                                               | Project-specific   |
| **System Overrides** | `/etc/gemini-cli/settings.json` (Linux)                               | Highest precedence |
|                      | `/Library/Application Support/GeminiCli/settings.json` (macOS)        |                    |
|                      | `C:\ProgramData\gemini-cli\settings.json` (Windows)                   |                    |

**CLI Commands:**

```bash
# Add to user scope (default)
gemini mcp add viberag -- npx viberag-mcp

# Explicitly specify scope
gemini mcp add viberag --scope user -- npx viberag-mcp
gemini mcp add viberag --scope project -- npx viberag-mcp

# List configured servers
gemini mcp list

# Remove server
gemini mcp remove viberag
```

**Configuration Example:**

```json
{
	"mcpServers": {
		"viberag": {
			"command": "npx",
			"args": ["-y", "viberag-mcp"]
		}
	}
}
```

**Precedence:** System overrides > Project > User > System defaults

**Documentation Sources:**

- [Gemini CLI Configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md) - Quote: "User settings file: `~/.gemini/settings.json`... Project settings file: `.gemini/settings.json` within your project's root directory"
- [Gemini CLI MCP Server](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)

---

### 7. JetBrains IDEs

**Supports:** UI only (global)

| Scope         | Path                                  | Description            |
| ------------- | ------------------------------------- | ---------------------- |
| **Global UI** | Settings → Tools → AI Assistant → MCP | IDE-wide configuration |

**Manual Setup Steps:**

1. Open Settings (⌘, on macOS, Ctrl+Alt+S on Windows/Linux)
2. Navigate to Tools → AI Assistant → MCP
3. Click "Add Server"
4. Configure:
   - Name: `viberag`
   - Command: `npx`
   - Args: `viberag-mcp`
5. Click OK

**Note:** JetBrains uses UI-based configuration only. No file-based MCP config for project or global scope.

**Documentation Sources:**

- [JetBrains AI Assistant MCP](https://github.com/context7/jetbrains_help/blob/main/ai-assistant/mcp.md)
- [Official JetBrains MCP Docs](https://www.jetbrains.com/help/ai-assistant/mcp.html)

---

### 8. OpenAI Codex

**Supports:** Global only, CLI

| Scope      | Path                   | Description             |
| ---------- | ---------------------- | ----------------------- |
| **Global** | `~/.codex/config.toml` | User-wide configuration |

**CLI Commands:**

```bash
# Add MCP server (note: -y flag is required for npx)
codex mcp add viberag -- npx -y viberag-mcp

# List servers
codex mcp list

# Remove server
codex mcp remove viberag
```

**Manual Configuration (`~/.codex/config.toml`):**

```toml
[mcp_servers.viberag]
command = "npx"
args = ["-y", "viberag-mcp"]
```

**Important Notes:**

- Codex uses **TOML format**, not JSON
- Global config only (no project-level config)
- The `-y` flag is **required** for npx to auto-confirm package installation
- Access MCP servers in Codex TUI with `/mcp` command

**Documentation Sources:**

- [Codex MCP Configuration](https://platform.openai.com/docs/codex/mcp) - Official OpenAI docs
- [Codex CLI Reference](https://github.com/openai/codex/blob/main/docs/config.md) - Config file format
- [Context7 Codex Docs](https://github.com/context7/developers_openai_codex/blob/main/mcp.md) - Quote: "codex mcp add context7 -- npx -y @upstash/context7-mcp"

---

### 9. OpenCode

**Supports:** Global, Project

| Scope       | Path                               | Description        |
| ----------- | ---------------------------------- | ------------------ |
| **Global**  | `~/.config/opencode/opencode.json` | User-wide settings |
| **Project** | `opencode.json`                    | Project root       |
| **Custom**  | `OPENCODE_CONFIG` env var          | Custom config path |

**Global Configuration (`~/.config/opencode/opencode.json`):**

```json
{
	"$schema": "https://opencode.ai/config.json",
	"mcp": {
		"viberag": {
			"type": "local",
			"command": ["npx", "-y", "viberag-mcp"],
			"enabled": true
		}
	}
}
```

**Special Requirements:**

- Uses `type: "local"` for stdio servers
- Command is an ARRAY (not string): `["npx", "-y", "viberag-mcp"]`
- Uses `mcp` key (not `mcpServers`)

**Precedence:** `OPENCODE_CONFIG` > Project > Global

**Documentation Sources:**

- [OpenCode Configuration](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/config.mdx) - Quote: "Your global configuration should be placed in `~/.config/opencode/opencode.json`"
- [OpenCode MCP Servers](https://github.com/context7/opencode_ai/blob/main/mcp-servers.md)

---

### 10. Roo Code

**Supports:** Global (UI), Project

| Scope       | Path                          | Description             |
| ----------- | ----------------------------- | ----------------------- |
| **Global**  | VS Code extension settings UI | Extension-wide settings |
| **Project** | `.roo/mcp.json`               | Project-specific        |

**Project Configuration (`.roo/mcp.json`):**

```json
{
	"mcpServers": {
		"viberag": {
			"command": "npx",
			"args": ["-y", "viberag-mcp"]
		}
	}
}
```

**Global Configuration (via UI):**

1. Click the MCP icon (server icon) in Roo Code pane header
2. Click "Edit Global MCP"
3. Add server configuration

**Implementation Note (Auto-Config Limitation):**

Roo Code stores global MCP configuration via its VS Code extension UI, not a standalone config file. The MCP setup wizard shows **manual instructions for global scope** while providing **auto-configuration for project scope** only (`.roo/mcp.json`).

**Precedence:** Project-level takes precedence over global

**Documentation Sources:**

- [Roo Code MCP Usage](https://github.com/roocodeinc/roo-code-docs/blob/main/docs/features/mcp/using-mcp-in-roo.mdx)
- [Roo Code v3.11 Release Notes](https://github.com/roocodeinc/roo-code-docs/blob/main/docs/update-notes/v3.11.0.md) - Quote: "Project-Level MCP Config... using a `.roo/mcp.json` file within your project's root directory. This allows for tailored MCP setups specific to different projects and takes precedence over global MCP settings."

---

## Decision: Scope Strategy

### Default to Global Configuration

**Rationale for preferring global scope:**

1. **One-time setup** — Users configure once, works across all projects
2. **No per-project overhead** — No need to re-initialize for each new project
3. **Simpler mental model** — "Install once, use everywhere"
4. **Fewer files** — Doesn't add config files to every project

**When to use project scope:**

1. Team sharing — Config needs to be in version control
2. Project-specific settings — Different MCP configurations per project
3. CI/CD — Reproducible builds need explicit dependencies

### Wizard Behavior

The MCP setup wizard should:

1. **Default to global** when the editor supports it
2. **Offer project option** as an alternative for editors with dual support
3. **Auto-select global** for global-only editors (Windsurf, Codex)
4. **Show UI instructions** for UI-only editors (JetBrains)

---

## Decision: Adding New Editors

When adding a new editor/agent to the MCP wizard, follow this checklist:

### Phase 1: Research with Context7

**Always start by fetching the latest official documentation.**

```
1. Use Context7 resolve-library-id to find the editor's docs
2. Query for "MCP server configuration global user settings"
3. Query for "MCP server configuration project local settings"
4. Look for BOTH project-level and global config options
5. Document the config file path, format, and JSON key structure
6. Note any special requirements (e.g., Zed's "source": "custom")
```

**Key information to extract:**

| Field                | Example (Gemini CLI)                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| Global config        | `~/.gemini/settings.json`                                                      |
| Project config       | `.gemini/settings.json`                                                        |
| JSON key             | `mcpServers`                                                                   |
| Config format        | JSON                                                                           |
| CLI command          | `gemini mcp add`                                                               |
| Precedence           | Project > User > System defaults                                               |
| Special requirements | None                                                                           |
| Documentation URL    | https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md |

### Phase 2: Choose Config Scope Strategy

| Editor Type                    | Default Scope   | Offer Choice? |
| ------------------------------ | --------------- | ------------- |
| Supports both global + project | **Global**      | Yes           |
| Global only                    | Global          | No            |
| Project only                   | Project         | No            |
| UI only                        | UI instructions | N/A           |

### Phase 3: Code Changes

#### 3.1 Update `source/cli/data/mcp-editors.ts`

Add the new editor with BOTH paths where applicable:

```typescript
{
  id: 'new-editor',
  name: 'New Editor',
  // For editors supporting both, use global as default
  globalConfigPath: '~/.new-editor/config.json',  // NEW FIELD
  projectConfigPath: '.new-editor/mcp.json',      // NEW FIELD
  configFormat: 'json',
  scope: 'global',                                // Default scope
  supportsGlobal: true,                           // NEW FIELD
  supportsProject: true,                          // NEW FIELD
  canAutoCreate: false,                           // false for global (needs merge)
  cliCommand: null,
  docsUrl: 'https://...',
  jsonKey: 'mcpServers',
  description: 'global config',
  restartInstructions: 'Restart New Editor',
  verificationSteps: ['...'],
}
```

#### 3.2 Handle Special Config Paths (if needed)

For platform-specific global paths:

```typescript
export function getNewEditorConfigPath(): string {
	const platform = process.platform;
	if (platform === 'darwin' || platform === 'linux') {
		return path.join(os.homedir(), '.config/new-editor/config.json');
	} else {
		return path.join(os.homedir(), 'AppData/Roaming/NewEditor/config.json');
	}
}
```

#### 3.3 Handle Special Config Formats (if needed)

```typescript
// Example: Zed requires "source": "custom"
export function generateZedViberagConfig(): object {
	return {
		source: 'custom',
		command: 'npx',
		args: ['viberag-mcp'],
	};
}

// Example: OpenCode requires array command and type field
export function generateOpenCodeViberagConfig(): object {
	return {
		type: 'local',
		command: ['npx', '-y', 'viberag-mcp'],
	};
}
```

#### 3.4 Handle Removal/Cleanup

The `/clean` command and `CleanWizard` remove viberag from configured editors. Key functions in `mcp-setup.ts`:

```typescript
// Remove viberag from a parsed config object
export function removeViberagFromConfig(
	existing: object,
	editor: EditorConfig,
): object | null;

// Remove viberag from an editor's config file
export async function removeViberagConfig(
	editor: EditorConfig,
	projectRoot: string,
): Promise<McpRemovalResult>;

// Find all editors that have viberag configured
export async function findConfiguredEditors(
	projectRoot: string,
): Promise<{projectScope: EditorConfig[]; globalScope: EditorConfig[]}>;
```

**Important:** Removal uses the same `readJsonConfig()` which handles JSONC. This ensures removal works for Zed/VS Code configs with comments.

**Removal behavior:**

- **Works for both global AND project configs** — `findConfiguredEditors()` scans both scopes
- Removes only the `viberag` key from the servers object
- Preserves all other MCP servers and settings
- Keeps the config file even if servers object becomes empty
- Returns `McpRemovalResult` with success/failure status

**Scope handling in CleanWizard:**

- Scans all configured editors in both project and global scopes
- Shows user which configs will be removed (grouped by scope)
- Removes from each config file independently

**For editors with CLI commands:**

```bash
# Claude Code
claude mcp remove viberag

# Gemini CLI
gemini mcp remove viberag

# OpenAI Codex
codex mcp remove viberag
```

### Phase 4: Documentation Updates

1. Update this ADR with new editor section including:
   - Both global AND project paths
   - Configuration examples for each scope
   - Special requirements
   - Precedence rules
   - Grounded documentation links

2. Update README.md with setup instructions

### Phase 5: Testing

```
Setup Testing
[ ] Global config creation works
[ ] Global config merge works (doesn't overwrite existing)
[ ] Global config merge works with JSONC (comments, trailing commas)
[ ] Project config creation works (if supported)
[ ] Scope selection UI works correctly
[ ] Editor recognizes the MCP server
[ ] Special config format is correct (e.g., Zed's "source": "custom")

Removal Testing
[ ] Removal from global config works
[ ] Removal from project config works (if supported)
[ ] Removal preserves other MCP servers
[ ] Removal works with JSONC configs
[ ] findConfiguredEditors() detects the editor
```

---

## Consequences

### Positive

1. **One-time setup** — Global default means users configure once
2. **Comprehensive documentation** — Both scopes documented for all editors
3. **Flexibility** — Users can choose project scope when needed
4. **Grounded references** — All config paths traced to official documentation

### Negative

1. **Global config risks** — Merge operations could conflict with existing settings
2. **Research overhead** — Must check Context7 for each new editor

### Mitigations

1. **Safe merging** — Only add `viberag` key, preserve all other settings
2. **Backup recommendation** — Suggest users backup global config before modification
3. **Version notes** — Document when research was done (see "Last Updated")

---

## Checklist Summary

```
Research
[ ] Query Context7 for GLOBAL MCP configuration
[ ] Query Context7 for PROJECT MCP configuration
[ ] Identify JSON key structure
[ ] Note special config requirements
[ ] Document precedence rules
[ ] Save all documentation URLs

Code Changes
[ ] Add to EditorId type in mcp-editors.ts
[ ] Add to EDITORS array with both paths
[ ] Add platform path helper (if needed)
[ ] Add config generator (if special format needed)
[ ] Update wizard to support scope selection

Documentation
[ ] Add to this ADR with both scopes documented
[ ] Update README.md
[ ] Include config examples for each scope
[ ] Link to official documentation

Testing
[ ] Test global config creation
[ ] Test global config merge
[ ] Test JSONC handling (if editor uses comments)
[ ] Test removal from global config
[ ] Test removal from project config
[ ] Test project config creation (if supported)
[ ] Test scope selection in wizard
```

---

## References

- [Context7 MCP](https://context7.com) — Up-to-date library documentation
- [MCP Specification](https://modelcontextprotocol.io) — Model Context Protocol standard
- [VibeRAG MCP Setup Code](../source/cli/commands/mcp-setup.ts) — Implementation reference
- [VibeRAG MCP Editors Data](../source/cli/data/mcp-editors.ts) — Editor configuration registry
