---
title: MCP Tools
description: MCP tools exposed by the VibeRAG server (Search v2).
---

## Tool List

| Tool             | Description                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `search`         | Intent-routed search with grouped results and stable IDs for follow-ups |
| `open_span`      | Read an exact line range from disk                                      |
| `get_symbol`     | Fetch a symbol definition + deterministic metadata by `symbol_id`       |
| `find_usages`    | Find usage occurrences (refs) for a symbol name or `symbol_id`          |
| `expand_context` | Expand a hit into neighbors (symbols/chunks) and related metadata       |
| `index`          | Build/update the v2 index (incremental by default)                      |
| `status`         | Get v2 index status and daemon status summary                           |
| `watch_status`   | Get watcher status (auto-indexing)                                      |
| `cancel`         | Cancel indexing or warmup without shutting down the daemon              |

## `search`

Search is intent-routed and returns grouped results.

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

- Use `get_symbol` to fetch full definition text + metadata for a `symbol_id`.
- Use `open_span` to fetch a precise span from disk by `file_path` + line range.
- Use `expand_context` to fetch neighbor symbols/chunks around a hit.
- Use `find_usages` for “where is X used?” style navigation.
