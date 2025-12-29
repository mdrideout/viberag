# ADR-006: Distribution Strategy — Node.js Runtime over Standalone Binaries

## Status

Accepted

## Context

VibeRAG is a Code RAG MCP server distributed to developers using various AI coding assistants. We needed to decide on the distribution mechanism:

1. **Standalone executables** — Single binary, no runtime dependencies
2. **Node.js package** — Requires Node.js, distributed via npm

### The Appeal of Standalone Binaries

Standalone executables offer:
- Zero dependencies for end users
- Single file to download and run
- No version conflicts with user's environment

We extensively researched bundlers that could produce standalone Node.js executables.

### Bundler Research (Dec 2025)

| Bundler | Binary Size | Result | Blocker |
|---------|-------------|--------|---------|
| Bun compile | 157MB | Failed | LanceDB NAPI-RS dlopen |
| Deno compile | 642MB | Works | Impractical binary size |
| pkg/yao-pkg | N/A | Failed | ESM import.meta not supported |

#### Bun Compile Deep Dive

We fixed two issues:

1. **yoga.wasm** — ink v4 used `yoga-wasm-web` which Bun couldn't load
   - Solution: Upgraded to ink v6 (uses native `yoga-layout`)
   - Result: Fixed

2. **tree-sitter grammars** — Dynamic `require()` wasn't bundled
   - Solution: Changed to static imports
   - Result: Fixed

But we hit an insurmountable blocker:

3. **LanceDB NAPI-RS module** (93MB native `.node` file)
   ```
   error: dlopen(/$bunfs/root/lancedb.darwin-arm64.node, 0x0001):
     tried: '/$bunfs/root/lancedb.darwin-arm64.node' (no such file)
   ```

   **Root cause:** Bun includes the `.node` file in its virtual filesystem (`/$bunfs/root/`), but the OS's dynamic linker cannot load libraries from a virtual filesystem. According to Bun v1.2.13 release notes, native modules should be extracted to temp before dlopen — but this doesn't work for NAPI-RS modules.

   **Related issues:**
   - [oven-sh/bun#11598](https://github.com/oven-sh/bun/issues/11598)
   - [oven-sh/bun discussions#17618](https://github.com/oven-sh/bun/discussions/17618)

#### Workaround Considered and Rejected

Patching LanceDB's NAPI-RS loader to use static platform detection:

```javascript
if (process.platform === 'darwin' && process.arch === 'arm64') {
  module.exports = require('@lancedb/lancedb-darwin-arm64');
}
```

**Rejected because:**
- Requires maintaining patches against upstream LanceDB
- Fragile when LanceDB updates
- Significant ongoing maintenance burden

### Industry Precedent

| Tool | Distribution | Runtime Required |
|------|--------------|------------------|
| Google Gemini CLI | npm package | Node.js 20+ |
| OpenAI Codex CLI | npm + standalone | Node.js 18+ (npm) or none (binary) |
| Claude Code | Bun binary | None (custom renderer, no ink) |

Note: Claude Code avoids this issue by using a custom terminal renderer instead of ink, eliminating the yoga.wasm and tree-sitter dependencies.

## Decision

**We will distribute VibeRAG as an npm global package requiring Node.js 18+.**

Additionally, we will migrate from native tree-sitter to web-tree-sitter (WASM) to:
1. Reduce native dependencies from 13 packages to 1 (LanceDB only)
2. Eliminate platform-specific grammar installation issues
3. Achieve 100% platform compatibility for parsing

### Distribution Channels

1. **Primary:** `npm install -g viberag`
2. **Secondary:** Homebrew tap (declares Node.js dependency)

## Consequences

### Positive

1. **Maximum compatibility** — Works on all platforms Node.js supports
2. **No native module bundling issues** — npm handles platform-specific packages
3. **Local embeddings possible** — Can add `@xenova/transformers` without bundling concerns
4. **Simpler CI/CD** — npm publish vs building 5 platform binaries
5. **Faster iteration** — No bundler debugging when dependencies change
6. **Familiar to users** — Developers have Node.js; npm is universal

### Negative

1. **Requires Node.js** — Users must have Node.js 18+ installed
2. **Larger install footprint** — node_modules vs single binary
3. **Version management** — User's Node.js version matters
4. **Not truly standalone** — Can't just download and run

### Neutral

1. **Binary size moot** — npm package size (~20MB) vs Deno binary (642MB)
2. **Startup time similar** — Node.js startup is fast enough

## Alternatives Considered

### Alternative 1: Deno Compile (642MB binaries)

Works correctly but:
- 642MB per platform = 3.2GB total release size
- Startup time slower than Node.js
- Less ecosystem alignment

**Rejected:** Impractical binary size.

### Alternative 2: Wait for Bun Fix

Monitor [oven-sh/bun#11598](https://github.com/oven-sh/bun/issues/11598) and revisit when NAPI-RS extraction is fixed.

**Deferred:** Could offer as future alternative if Bun fixes the issue.

### Alternative 3: Replace LanceDB

Use SQLite with vector extension or pure-JS vector store.

**Rejected:** LanceDB is battle-tested and performant. Replacing it is high-risk.

### Alternative 4: Rust Rewrite

Rewrite in Rust for ~30MB single binaries.

**Deferred:** Significant effort. Possible long-term option.

## Implementation

### Phase 1: web-tree-sitter Migration

Replace 12 native tree-sitter grammar packages with `web-tree-sitter` + `tree-sitter-wasms`.

**Result:** Only LanceDB remains as native dependency (excellent prebuild coverage).

### Phase 2: npm Global Configuration

Configure `package.json` for global installation:
```json
{
  "bin": { "viberag": "./dist/cli/index.js" },
  "engines": { "node": ">=18.0.0" }
}
```

### Phase 3: Local Embeddings

Add `@huggingface/transformers` for offline/privacy-focused embedding support.

### Phase 4: Homebrew Tap

Create formula that depends on `node@18` and installs via npm.

## References

- [Bun v1.2.13 Release Notes](https://bun.sh/blog/bun-v1.2.13) — Native addon extraction
- [tree-sitter-wasms](https://github.com/sourcegraph/tree-sitter-wasms) — WASM grammars from Sourcegraph
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) — Similar distribution approach
