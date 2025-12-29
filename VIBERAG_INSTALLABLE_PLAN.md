# VibeRAG Universal Installation Plan

A comprehensive plan for making VibeRAG a universally installable Code RAG MCP server that works across platforms, architectures, and languages.

## Vision

Create a **zero-friction installation experience** for developers using any AI coding assistant (Claude Code, Cursor, VS Code Copilot, Zed, etc.) on any platform.

```bash
npm install -g viberag          # Primary installation method
brew install viberag            # macOS/Linux (Homebrew tap)
```

---

## Architecture Decision: Node.js Runtime

**Decision:** VibeRAG requires Node.js 18+ as a runtime dependency.

**This matches the approach used by:**
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) - Requires Node.js 20+
- Many production MCP servers and developer tools

**Why not standalone binaries?** See [Bundler Research](#bundler-research-dec-2025) below.

---

## Current State (Dec 2025)

### Completed

- [x] Native tree-sitter → web-tree-sitter migration ✅
- [x] 11/12 language grammars working (Dart temporarily disabled - version mismatch)
- [x] LanceDB vector storage
- [x] Semantic + hybrid search
- [x] MCP server protocol
- [x] Multi-editor setup wizard
- [x] File watching / incremental indexing
- [x] CI/CD workflows (ci.yml, release.yml)
- [x] Grammar smoke tests (updated for WASM)
- [x] API embeddings (Gemini, Mistral, OpenAI)
- [x] React 19 + ink v6 upgrade
- [x] npm global package configuration (`bin` field, `engines` field)
- [x] ADR-006 documenting distribution strategy decision
- [x] Local embeddings option (@xenova/transformers, jina-v2-code)

### In Progress

- [ ] Homebrew tap

### Known Issues

- **Dart grammar disabled**: tree-sitter-wasms Dart WASM uses version 15, but web-tree-sitter 0.24.7 only supports versions 13-14. Will be re-enabled when web-tree-sitter updates.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      viberag CLI                             │
├─────────────────────────────────────────────────────────────┤
│  ink v6 + React 19        │  MCP Server Protocol            │
├───────────────────────────┴─────────────────────────────────┤
│                     RAG Engine                               │
├─────────────────────────────────────────────────────────────┤
│  web-tree-sitter (WASM)   │  LanceDB (Native)               │
│  - 12 language grammars   │  - Vector storage               │
│  - Universal compatibility│  - Good prebuild coverage       │
├───────────────────────────┴─────────────────────────────────┤
│  Embeddings                                                  │
│  - API: Gemini, Mistral, OpenAI                             │
│  - Local: @xenova/transformers (optional)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Bundler Research (Dec 2025)

### Summary

| Bundler | Binary Size | Result | Blocker |
|---------|-------------|--------|---------|
| Bun compile | 157MB | ❌ Failed | LanceDB NAPI-RS dlopen |
| Deno compile | 642MB | ✅ Works | Large binary size |
| pkg/yao-pkg | N/A | ❌ Failed | ESM import.meta not supported |

**Conclusion:** Standalone executables are not viable due to native module bundling issues. Node.js runtime dependency is the pragmatic choice.

### Bun Compile Deep Dive

**What we fixed:**

1. **yoga.wasm issue** - ink v4 used `yoga-wasm-web` which Bun couldn't load
   - Solution: Upgraded to ink v6 which uses native `yoga-layout`
   - Result: ✅ yoga.wasm error eliminated

2. **tree-sitter grammars** - Dynamic `require()` wasn't bundled
   - Solution: Changed to static imports in `chunker.ts`
   - Result: ✅ All 12 grammars bundle correctly

**What blocked us:**

3. **LanceDB NAPI-RS module** (93MB native `.node` file)
   ```
   error: dlopen(/$bunfs/root/lancedb.darwin-arm64.node, 0x0001):
     tried: '/$bunfs/root/lancedb.darwin-arm64.node' (no such file)
   ```

   **Root cause:**
   - Bun's bundler includes the `.node` file in its virtual filesystem (`/$bunfs/root/`)
   - BUT the OS's dynamic linker cannot load from a virtual filesystem
   - According to [Bun v1.2.13](https://bun.sh/blog/bun-v1.2.13), native modules should be extracted to temp before dlopen
   - This extraction doesn't work correctly for NAPI-RS modules like LanceDB

   **Related issues:**
   - [oven-sh/bun#11598](https://github.com/oven-sh/bun/issues/11598) - FFI dlopen fails in compiled exe
   - [argon2 discussion](https://github.com/oven-sh/bun/discussions/17618) - NAPI module workarounds

**Workaround researched but rejected:**

Patching LanceDB's NAPI-RS loader to use static platform detection:
```javascript
// Would need to change from dynamic to static:
if (process.platform === 'darwin' && process.arch === 'arm64') {
  module.exports = require('@lancedb/lancedb-darwin-arm64');
}
```

**Rejected because:**
- Requires maintaining patches against upstream
- Fragile when LanceDB updates
- Significant ongoing maintenance burden

### Deno Compile

Works correctly but produces large binaries:

```bash
deno compile --allow-all --include node_modules --output viberag dist/cli/index.js
# Result: 642MB binary
```

**Why not use Deno:**
- 642MB per platform = 3.2GB total release size (5 platforms)
- Startup time slower than Bun
- Less ecosystem alignment (Claude Code uses Bun)

### pkg / yao-pkg

Both fail immediately:
```
Error: ESM import.meta.url is not supported in pkg
```

Not viable for ESM projects.

---

## web-tree-sitter Migration

### Why Migrate

| Aspect | Native tree-sitter | web-tree-sitter |
|--------|-------------------|-----------------|
| Native modules | 12 packages | 0 packages |
| Platform support | ~85% (prebuilds) | 100% (WASM) |
| Build tools needed | Sometimes | Never |
| Install failures | Possible | None |

**Result:** Reduces native dependencies from 13 packages to 1 (LanceDB only).

### Language Support

All 12 languages available via [tree-sitter-wasms](https://github.com/sourcegraph/tree-sitter-wasms) (Sourcegraph):

| Language | WASM Size | Status |
|----------|-----------|--------|
| JavaScript | ~200KB | ✅ |
| TypeScript | ~300KB | ✅ |
| TSX | ~300KB | ✅ |
| Python | ~200KB | ✅ |
| Go | ~200KB | ✅ |
| Rust | ~400KB | ✅ |
| Java | ~300KB | ✅ |
| C# | 3.98MB | ✅ |
| Kotlin | 4.05MB | ✅ |
| Swift | 3.15MB | ✅ |
| Dart | 985KB | ✅ |
| PHP | ~300KB | ✅ |

### API Compatibility

All APIs used in `chunker.ts` are available in web-tree-sitter:

| API | Native | web-tree-sitter |
|-----|--------|-----------------|
| `node.type` | ✅ | ✅ |
| `node.text` | ✅ | ✅ |
| `node.children` | ✅ | ✅ |
| `node.parent` | ✅ | ✅ |
| `node.previousSibling` | ✅ | ✅ |
| `node.childForFieldName()` | ✅ | ✅ |
| `node.startPosition.row` | ✅ | ✅ |
| `parser.setLanguage()` | ✅ | ✅ |
| `parser.parse()` | ✅ | ✅ |

**Key difference:** Initialization is async in web-tree-sitter:
```typescript
// Native (sync)
const parser = new Parser();
parser.setLanguage(JavaScript);

// web-tree-sitter (async)
await Parser.init();
const JavaScript = await Parser.Language.load('tree-sitter-javascript.wasm');
const parser = new Parser();
parser.setLanguage(JavaScript);
```

### Migration Tasks

1. Replace `tree-sitter` with `web-tree-sitter`
2. Replace 12 native grammar packages with `tree-sitter-wasms`
3. Update `Chunker` class for async initialization
4. Update `Indexer` to await chunker init
5. Test all 12 languages

---

## Embeddings Strategy

### API Embeddings (Default)

| Provider | Model | Dimensions | Cost |
|----------|-------|------------|------|
| Gemini | text-embedding-004 | 768 | Free tier |
| Mistral | codestral-embed-2505 | 1024 | Paid |
| OpenAI | text-embedding-3-large | 3072 | Paid |

**Default:** Gemini (free tier, good quality)

### Local Embeddings

**Status:** ✅ Implemented

Uses `jinaai/jina-embeddings-v2-base-code` via `@xenova/transformers`:

```typescript
import { pipeline } from '@xenova/transformers';

const embedder = await pipeline('feature-extraction', 'jinaai/jina-embeddings-v2-base-code', {
  quantized: true  // int8 for smaller size (~161MB)
});
const embedding = await embedder(text, { pooling: 'mean', normalize: true });
```

**Specs:**
- 768 dimensions (same as Gemini)
- 8K token context window
- Trained on 150M+ code QA pairs
- int8 quantized (~161MB model)

**Benefits:**
- Works completely offline
- No API key required
- No per-token costs
- Data never leaves machine

**Tradeoffs:**
- First run downloads model (~161MB)
- Slower than API for large batches

---

## Distribution Strategy

### Primary: npm Global

```bash
npm install -g viberag
```

**package.json configuration:**
```json
{
  "name": "viberag",
  "bin": {
    "viberag": "./dist/cli/index.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "files": [
    "dist/",
    "wasm/"
  ]
}
```

### Secondary: Homebrew Tap

```ruby
# homebrew-viberag/Formula/viberag.rb
class Viberag < Formula
  desc "Local Code RAG MCP Server for AI coding assistants"
  homepage "https://github.com/YourOrg/viberag"

  depends_on "node@18"

  def install
    system "npm", "install", "-g", "viberag", "--prefix", prefix
  end

  test do
    system "#{bin}/viberag", "--version"
  end
end
```

**Usage:**
```bash
brew tap yourorg/viberag
brew install viberag
```

---

## Implementation Phases

### Phase 1: web-tree-sitter Migration

**Status:** ✅ Complete

**Completed:**
1. ✅ Removed 12 native tree-sitter packages from `package.json`
2. ✅ Added `web-tree-sitter` and `tree-sitter-wasms` dependencies
3. ✅ Refactored `Chunker` class with async `initialize()` method
4. ✅ WASM grammar loading via `Parser.Language.load()`
5. ✅ Memory cleanup via `parser.delete()` in `close()`
6. ✅ `npm install` verified
7. ✅ `npm run build` verified
8. ✅ `npm run test:smoke` - 11/12 grammars working

**Known Issue:**
- Dart grammar temporarily disabled due to tree-sitter version mismatch
- tree-sitter-wasms Dart WASM is version 15
- web-tree-sitter 0.24.7 supports versions 13-14
- Will be re-enabled when web-tree-sitter updates

**Files Modified:**
- `source/rag/indexer/chunker.ts` - Complete rewrite for web-tree-sitter
- `source/rag/__tests__/grammar-smoke.test.ts` - Updated for WASM
- `package.json` - Dependencies updated

### Phase 2: npm Global Configuration

**Status:** ✅ Complete

**Completed:**
1. ✅ `bin` field in package.json (viberag, viberag-mcp)
2. ✅ Shebang in CLI entry point (`#!/usr/bin/env node`)
3. ✅ `files` field configured (dist, scripts)
4. ✅ `engines` field set to `>=18.0.0`

**Pending:**
- [ ] Test `npm link` locally
- [ ] Test `npm pack` and install

**Files:**
- `package.json` ✅
- `dist/cli/index.js` ✅

### Phase 3: Local Embeddings

**Status:** ✅ Complete

**Completed:**
1. ✅ Added `@xenova/transformers` as regular dependency
2. ✅ Created `LocalEmbeddingProvider` class with jina-v2-code model
3. ✅ Added 'local' to EmbeddingProviderType
4. ✅ Updated factory methods in indexer and search
5. ✅ Updated InitWizard with local as recommended option
6. ✅ `npm run build` verified

**Files Modified:**
- `source/rag/embeddings/local.ts` (new)
- `source/rag/embeddings/index.ts`
- `source/common/types.ts`
- `source/rag/config/index.ts`
- `source/rag/indexer/indexer.ts`
- `source/rag/search/index.ts`
- `source/cli/components/InitWizard.tsx`
- `package.json`

### Phase 4: Homebrew Tap

**Status:** Not started

**Tasks:**
1. Create `homebrew-viberag` repository
2. Write Formula
3. Test installation
4. Document in README

### Phase 5: CI/CD Updates

**Status:** Partially complete

**Tasks:**
1. Remove Bun compile from release workflow
2. Add npm publish step
3. Add Homebrew formula update automation

**Files:**
- `.github/workflows/release.yml`

---

## Node.js Version Support

| Node.js | Status | Notes |
|---------|--------|-------|
| 18.x | ✅ Supported | Oldest LTS, minimum |
| 20.x | ✅ Supported | Current LTS |
| 22.x | ✅ Supported | Latest |

**Engines field:**
```json
{
  "engines": {
    "node": ">=18.0.0"
  }
}
```

---

## Native Dependencies

After web-tree-sitter migration, only ONE native dependency remains:

| Package | Size | Prebuild Coverage |
|---------|------|-------------------|
| @lancedb/lancedb | 94MB | Excellent |

**LanceDB prebuild platforms:**
- ✅ darwin-x64
- ✅ darwin-arm64
- ✅ linux-x64-gnu
- ✅ linux-arm64-gnu
- ✅ linux-x64-musl
- ✅ win32-x64

**Fallback:** If no prebuild, requires Rust toolchain to compile.

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Installation success rate | >99% |
| Platform coverage | All Node.js platforms |
| Language support | 12 languages |
| npm package size | <20MB (excluding optional deps) |
| Startup time | <2s |

---

## Future Considerations

### Ollama Integration

For users who want local embeddings without bundled ONNX:

```typescript
// Use Ollama's embedding endpoint
const response = await fetch('http://localhost:11434/api/embed', {
  method: 'POST',
  body: JSON.stringify({
    model: 'nomic-embed-text',
    input: texts
  })
});
```

User manages Ollama separately - no native deps in our codebase.

### Standalone Binary (Future)

If Bun fixes NAPI-RS module extraction:
- Monitor [oven-sh/bun#11598](https://github.com/oven-sh/bun/issues/11598)
- 157MB binaries would be possible
- Could offer as alternative to npm

### Rust Rewrite (Long-term)

For maximum performance and smallest binary:
- tree-sitter has native Rust bindings
- LanceDB has Rust API
- Single <30MB binary possible
- No runtime dependencies
