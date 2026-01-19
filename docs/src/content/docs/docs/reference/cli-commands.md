---
title: CLI Commands
description: Slash commands available in the VibeRAG CLI.
---

## Commands

| Command           | Description                       |
| ----------------- | --------------------------------- |
| `/help`           | Show available commands           |
| `/clear`          | Clear the screen                  |
| `/terminal-setup` | Configure Shift+Enter for VS Code |
| `/init`           | Initialize VibeRAG                |
| `/index`          | Index the codebase                |
| `/reindex`        | Force full reindex                |
| `/search <query>` | Search the codebase               |
| `/eval`           | Run evaluation harness            |
| `/status`         | Show daemon and index status      |
| `/cancel`         | Cancel indexing or warmup         |
| `/mcp-setup`      | Configure MCP server for AI tools |
| `/clean`          | Remove VibeRAG from the project   |
| `/quit`           | Exit the CLI                      |

## Cancel

Use `/cancel` to stop the current daemon activity without shutting down the daemon:

- `/cancel` cancels any active indexing or warmup
- `/cancel indexing` cancels indexing only
- `/cancel warmup` cancels warmup only

After cancelling, you can re-run `/index` or `/reindex` if needed.
