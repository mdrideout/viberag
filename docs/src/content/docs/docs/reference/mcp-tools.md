---
title: MCP Tools
description: MCP tools exposed by the VibeRAG server.
---

## Tool List

| Tool                       | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `codebase_search`          | Semantic, keyword, or hybrid search for code      |
| `codebase_parallel_search` | Run multiple search strategies in parallel        |
| `viberag_index`            | Index the codebase (incremental by default)       |
| `viberag_status`           | Index status plus daemon progress and warmup      |
| `viberag_cancel`           | Cancel indexing or warmup without stopping daemon |
| `viberag_watch_status`     | File watcher status for auto-indexing             |

## Status and Cancellation

- Use `viberag_status` to check indexing progress, last progress time, and failures.
- Use `viberag_cancel` to stop long-running or stuck indexing runs, then re-run
  `viberag_index` if you need a clean index.

## Search Output

`codebase_search` returns metadata-only results by default to keep payloads small.
Set `include_text=true` to include chunk text in each result.

## Parallel Search Output

`codebase_parallel_search` returns metadata-only results by default to keep payloads small.
Set `include_text=true` to include chunk text in merged results, and
`include_individual=true` to include per-search result lists.
