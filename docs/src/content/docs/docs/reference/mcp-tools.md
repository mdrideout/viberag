---
title: MCP Tools
description: MCP tools exposed by the VibeRAG server.
---

## Tool List

| Tool                   | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `codebase_search`      | Intent-routed search with grouped results and stable IDs for follow-ups |
| `help`                 | Tool guide + how search works                                           |
| `read_file_lines`      | Read an exact line range from disk                                      |
| `get_symbol_details`   | Fetch a symbol definition + deterministic metadata by `symbol_id`       |
| `find_references`      | Find usage occurrences (refs) for a symbol name or `symbol_id`          |
| `get_surrounding_code` | Expand a hit into neighbors (symbols/chunks) and related metadata       |
| `build_index`          | Build/update the index (incremental by default)                         |
| `get_status`           | Get index + daemon status summary                                       |
| `get_watcher_status`   | Get watcher status (auto-indexing)                                      |
| `cancel_operation`     | Cancel indexing or warmup without shutting down the daemon              |

## `help`

Returns a concise guide for tool usage and a summary of how search works.

Input:

```json
{
	"tool": "codebase_search"
}
```

## `codebase_search`

Search is intent-routed and returns grouped results.

Notes:

- Definition-style queries use **fuzzy name matching** (Levenshtein) on symbol names/qualnames to tolerate small typos.
- Set `explain: true` to see which channels contributed to each hit (FTS / fuzzy / vector) and which soft priors were applied.

Input:

```json
{
	"query": "string",
	"intent": "auto|definition|usage|concept|exact_text|similar_code",
	"scope": {
		"path_prefix": ["src/"],
		"path_contains": ["auth"],
		"path_not_contains": ["test", "__tests__", ".spec.", ".test."],
		"extension": [".ts", ".py"]
	},
	"k": 20,
	"explain": true
}
```

Output shape:

```json
{
	"intent_used": "definition",
	"filters_applied": {},
	"groups": {
		"definitions": [],
		"usages": [],
		"files": [],
		"blocks": []
	},
	"suggested_next_actions": []
}
```

Follow-ups:

- Use `get_symbol_details` to fetch full definition text + metadata for a `symbol_id`.
- Use `read_file_lines` to fetch a precise span from disk by `file_path` + line range.
- Use `get_surrounding_code` to fetch neighbor symbols/chunks around a hit.
- Use `find_references` for “where is X used?” style navigation.
