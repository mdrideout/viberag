# VibeRAG Universal Installation Plan

A comprehensive plan for making VibeRAG a universally installable Code RAG MCP server that works across platforms, architectures, and languages.

## Vision

Create a **zero-friction installation experience** for developers using any AI coding assistant (Claude Code, Cursor, VS Code Copilot, Zed, etc.) on any platform, enabling powerful semantic code search across polyglot codebases.

```
# The dream installation experience
npm install -g viberag          # Node.js developers
brew install viberag            # macOS users
curl -fsSL viberag.dev/i | sh   # Linux users
scoop install viberag           # Windows users
```

---

## Current State (Updated Dec 2025)

### What's Complete

- [x] Native tree-sitter migration (Phase 1)
- [x] All 12 language grammars working
- [x] LanceDB vector storage
- [x] Semantic + hybrid search
- [x] MCP server protocol
- [x] Multi-editor setup wizard
- [x] File watching / incremental indexing
- [x] CI/CD workflows (ci.yml, release.yml)
- [x] Grammar smoke tests

### What's In Progress

- [x] API-only embeddings (Gemini, Mistral, OpenAI implemented)
- [ ] Standalone executables via Deno compile (working) or Bun (needs ink v6)
- [ ] Package manager distribution (Homebrew, etc.)

### Bundler Status (Dec 2025)

| Bundler      | Binary Size | Status                        | Blocker                                        |
| ------------ | ----------- | ----------------------------- | ---------------------------------------------- |
| Bun compile  | 157MB       | Compiles but fails at runtime | ink v4 uses yoga-wasm-web, Bun can't load WASM |
| Deno compile | 642MB       | **Works correctly**           | Large binary size                              |
| pkg/yao-pkg  | N/A         | Fails                         | ESM import.meta not supported                  |

**Path to Bun:**

- ink v6 uses `yoga-layout` (native) instead of `yoga-wasm-web` (WASM)
- ink v6 requires React 19
- Need to upgrade ink + React + ink-select-input + ink-big-text + ink-gradient
- This would enable 157MB Bun binaries (4x smaller than Deno)

### Key Decision: API-Only Embeddings

**Removed:** Local embeddings via `@huggingface/transformers` and `fastembed`

**Reason:** These dependencies pull in `onnxruntime-node` (~210MB) with complex native dylib loading that breaks standalone binary compilation (pkg, Deno compile all failed).

**New approach:** API-based embeddings only:

- Gemini (free tier available)
- Mistral (codestral-embed-2505, best for code)
- OpenAI (text-embedding-3-large)

This reduces dependencies by ~730MB and enables Bun compile to work.

---

## Phase 1: Native Tree-Sitter Migration ✅ COMPLETE

**Status:** Done

- Migrated from web-tree-sitter to native tree-sitter v0.25.0
- All 12 language grammars working
- Synchronous initialization (no WASM loading)
- Grammar smoke tests passing

---

## Phase 1.5: API-Only Embeddings (NEW)

**Goal:** Remove local ML dependencies, implement cloud embedding APIs.

**Timeline:** 1 day

### 1.5.1 Remove Heavy Dependencies

```bash
npm uninstall @huggingface/transformers fastembed
```

**What gets removed:**
| Package | Size | Why Remove |
|---------|------|------------|
| @huggingface/transformers | 519MB | Pulls onnxruntime, sharp |
| fastembed | 164KB | Wrapper for onnxruntime |
| onnxruntime-node | 210MB | Native dylibs break pkg/Bun/Deno |

**What remains:**
| Package | Size | Status |
|---------|------|--------|
| tree-sitter + 12 grammars | ~327MB | Works with Bun compile |
| @lancedb/lancedb | 94MB | Node-API, should work |
| ink/react | ~5MB | Pure JS |

### 1.5.2 Embedding Provider Types

```typescript
// source/common/types.ts
export type EmbeddingProviderType =
	| 'gemini' // gemini-embedding-001 (768d, free tier)
	| 'mistral' // codestral-embed-2505 (1024d, best for code)
	| 'openai'; // text-embedding-3-large (3072d, highest quality)
```

### 1.5.3 Implement API Providers

```typescript
// source/rag/embeddings/gemini.ts
export class GeminiEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 768;

	async embed(texts: string[]): Promise<number[][]> {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1/models/embedding-001:batchEmbedContents?key=${this.apiKey}`,
			{
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					requests: texts.map(text => ({
						model: 'models/embedding-001',
						content: {parts: [{text}]},
					})),
				}),
			},
		);
		const data = await response.json();
		return data.embeddings.map((e: any) => e.values);
	}
}

// source/rag/embeddings/mistral.ts
export class MistralEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 1024;

	async embed(texts: string[]): Promise<number[][]> {
		const response = await fetch('https://api.mistral.ai/v1/embeddings', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: 'codestral-embed-2505',
				input: texts,
			}),
		});
		const data = await response.json();
		return data.data.map((d: any) => d.embedding);
	}
}

// source/rag/embeddings/openai.ts
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions = 3072;

	async embed(texts: string[]): Promise<number[][]> {
		const response = await fetch('https://api.openai.com/v1/embeddings', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: 'text-embedding-3-large',
				input: texts,
			}),
		});
		const data = await response.json();
		return data.data.map((d: any) => d.embedding);
	}
}
```

### 1.5.4 Update Init Wizard

Update the init wizard to only show API options:

```
? Select embedding provider:
  ❯ Gemini (Free tier, 768d) - Recommended for getting started
    Mistral codestral-embed (1024d) - Best for code
    OpenAI text-embedding-3-large (3072d) - Highest quality
```

### 1.5.5 API Key Configuration

Store API keys in `.viberag/config.json`:

```json
{
	"embeddingProvider": "gemini",
	"apiKeys": {
		"gemini": "AIza...",
		"mistral": "...",
		"openai": "sk-..."
	}
}
```

Or via environment variables:

- `GEMINI_API_KEY`
- `MISTRAL_API_KEY`
- `OPENAI_API_KEY`

---

## Phase 2: CI/CD & Testing ✅ MOSTLY COMPLETE

**Status:** CI workflows created, need updates for Bun

### 2.1 Current Workflows

- `.github/workflows/ci.yml` - Lint + test matrix (3 OS × 2 Node versions)
- `.github/workflows/release.yml` - Build standalone executables

### 2.2 Updates Needed

- Update release.yml to use Bun compile instead of pkg
- Add Bun installation step
- Test Bun compile on all platforms

---

## Phase 3: Standalone Executables

**Goal:** Create self-contained executables.

**Timeline:** 1-2 days

### 3.1 Current Solution: Deno Compile

Deno compile works today with our current dependencies:

```bash
# Build standalone executable
deno compile --allow-all --no-check --include node_modules --output viberag dist/cli/index.js
```

**Result:** 642MB working binary

### 3.2 Future Solution: Bun Compile (requires ink v6)

| Factor               | Bun                | Deno     |
| -------------------- | ------------------ | -------- |
| tree-sitter support  | ✅ v1.1.34+        | ✅       |
| Native addon loading | ✅ Node-API        | ✅       |
| Anthropic backing    | ✅ Acquired        | ❌       |
| Claude Code uses     | ✅ Yes             | ❌       |
| Binary size          | 157MB              | 642MB    |
| Startup time         | Fast               | Medium   |
| ink v4 (current)     | ❌ yoga.wasm fails | ✅ Works |
| ink v6 (needed)      | ✅ Would work      | ✅ Works |

**Key insight:** [Anthropic acquired Bun](https://bun.com/blog/bun-joins-anthropic) and Claude Code ships as a Bun executable. However, Claude Code uses a custom renderer instead of ink to avoid the yoga.wasm issue.

### 3.3 ink v6 Upgrade Path

To enable Bun compile (157MB binaries instead of 642MB):

```bash
# These packages need React 19 compatible versions
npm install react@19 @types/react@19 --legacy-peer-deps
npm install ink@6 --legacy-peer-deps
# May need to update or replace:
# - ink-select-input (currently requires ink ^4)
# - ink-big-text
# - ink-gradient
```

### 3.4 Bun Compile Configuration (Future)

```bash
# Build standalone executable
bun build ./dist/cli/index.js --compile --outfile viberag
```

### 3.5 Updated Release Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            target: bun-linux-x64
            artifact: viberag-linux-x64

          - os: ubuntu-24.04-arm64
            target: bun-linux-arm64
            artifact: viberag-linux-arm64

          - os: macos-13
            target: bun-darwin-x64
            artifact: viberag-darwin-x64

          - os: macos-14
            target: bun-darwin-arm64
            artifact: viberag-darwin-arm64

          - os: windows-latest
            target: bun-windows-x64
            artifact: viberag-win-x64.exe

    runs-on: ${{ matrix.os }}
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Build TypeScript
        run: bun run build

      - name: Build standalone executable
        run: bun build dist/cli/index.js --compile --target ${{ matrix.target }} --outfile ${{ matrix.artifact }}

      - name: Package (Unix)
        if: runner.os != 'Windows'
        run: |
          chmod +x ${{ matrix.artifact }}
          tar -czvf ${{ matrix.artifact }}.tar.gz ${{ matrix.artifact }}

      - name: Package (Windows)
        if: runner.os == 'Windows'
        run: Compress-Archive -Path ${{ matrix.artifact }} -DestinationPath ${{ matrix.artifact }}.zip

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: |
            *.tar.gz
            *.zip

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts/
          merge-multiple: true

      - name: Create checksums
        working-directory: artifacts
        run: |
          sha256sum *.tar.gz *.zip > checksums.sha256

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            artifacts/*.tar.gz
            artifacts/*.zip
            artifacts/checksums.sha256
          generate_release_notes: true

  publish-npm:
    needs: release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: 'https://registry.npmjs.org'

      - run: bun install
      - run: bun run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 3.6 Actual Binary Sizes (Tested)

After removing ML stack:

| Bundler      | darwin-arm64 | Notes                   |
| ------------ | ------------ | ----------------------- |
| Deno compile | 642MB        | Works today             |
| Bun compile  | 157MB        | Needs ink v6 + React 19 |

**With ink v6 (projected):**

| Platform     | Bun Size | Deno Size |
| ------------ | -------- | --------- |
| linux-x64    | ~160MB   | ~650MB    |
| linux-arm64  | ~160MB   | ~650MB    |
| darwin-x64   | ~160MB   | ~650MB    |
| darwin-arm64 | 157MB    | 642MB     |
| win-x64      | ~170MB   | ~700MB    |

**Total release size with Bun:** ~850MB (5 platforms)
**Total release size with Deno:** ~3.3GB (5 platforms)

---

## Phase 4: Package Manager Distribution

**Goal:** Distribute via Homebrew, apt, scoop, and install scripts.

**Timeline:** 2-3 days

### 4.1 Homebrew Tap

```ruby
# homebrew-viberag/Formula/viberag.rb
class Viberag < Formula
  desc "Local Code RAG MCP Server for AI coding assistants"
  homepage "https://github.com/YourOrg/viberag"
  version "0.2.0"
  license "AGPL-3.0"

  on_macos do
    on_arm do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER"
    end
    on_intel do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER"
    end
    on_intel do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-linux-x64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  def install
    bin.install "viberag"
  end

  test do
    system "#{bin}/viberag", "--version"
  end
end
```

### 4.2 Install Script

```bash
#!/bin/bash
# install.sh - Universal installer for viberag
set -e

REPO="YourOrg/viberag"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux*)  OS="linux" ;;
  darwin*) OS="darwin" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

VERSION=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
BINARY="viberag-${OS}-${ARCH}"

echo "Installing viberag ${VERSION} for ${OS}-${ARCH}..."

curl -fsSL "https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}.tar.gz" | tar xz
chmod +x "$BINARY"
sudo mv "$BINARY" "${INSTALL_DIR}/viberag"

echo "viberag installed successfully!"
viberag --version
```

**Usage:**

```bash
curl -fsSL https://viberag.dev/install.sh | sh
```

---

## Phase 5: Language Support Matrix

**Status:** Complete with native tree-sitter

### Tier 1 Languages (Full Support)

| Language   | Grammar Package        | Export Detection | Decorators    | Docstrings        |
| ---------- | ---------------------- | ---------------- | ------------- | ----------------- |
| JavaScript | tree-sitter-javascript | `export` keyword | `@decorator`  | `/** */`          |
| TypeScript | tree-sitter-typescript | `export` keyword | `@decorator`  | `/** */`          |
| TSX        | tree-sitter-typescript | `export` keyword | `@decorator`  | `/** */`          |
| Python     | tree-sitter-python     | `_` prefix       | `@decorator`  | `"""docstring"""` |
| Go         | tree-sitter-go         | Capitalization   | N/A           | `// comment`      |
| Rust       | tree-sitter-rust       | `pub` keyword    | `#[attr]`     | `///` or `//!`    |
| Java       | tree-sitter-java       | `public` keyword | `@Annotation` | `/** */`          |

### Tier 2 Languages (Standard Support)

| Language | Grammar Package          | Export Detection | Decorators    | Docstrings      |
| -------- | ------------------------ | ---------------- | ------------- | --------------- |
| C#       | tree-sitter-c-sharp      | `public` keyword | `[Attribute]` | `/// <summary>` |
| Kotlin   | tree-sitter-kotlin       | default public   | `@Annotation` | `/** */`        |
| Swift    | tree-sitter-swift        | `public` keyword | `@attribute`  | `///`           |
| PHP      | tree-sitter-php          | `public` keyword | `#[Attr]`     | `/** */`        |
| Dart     | @sengac/tree-sitter-dart | `_` prefix       | `@annotation` | `///`           |

---

## Implementation Order

1. **Phase 1.5:** Remove local embeddings, implement API providers
2. **Phase 3:** Test Bun compile with reduced dependencies
3. **Phase 2:** Update CI/CD for Bun
4. **Phase 4:** Package manager distribution
5. **Phase 5:** Already complete

---

## Success Metrics (Updated)

| Metric                    | Target       | Notes                               |
| ------------------------- | ------------ | ----------------------------------- |
| Installation success rate | >99%         | No build tools needed               |
| Platform coverage         | 5 platforms  | linux/darwin x64/arm64, win-x64     |
| Language support          | 12 languages | All working with native tree-sitter |
| Standalone binary size    | <150MB       | Down from ~900MB+ with ML stack     |
| npm package size          | <50MB        | Just dist + scripts                 |
| Startup time              | <2s          | Bun is fast                         |

---

## Risk Mitigation

| Risk                                  | Mitigation                          |
| ------------------------------------- | ----------------------------------- |
| Bun compile issues with native addons | Test thoroughly, fallback to npm    |
| API rate limits                       | Implement retry with backoff        |
| API cost concerns                     | Default to Gemini (free tier)       |
| LanceDB native issues                 | Already tested, works with Node-API |

---

## Future Considerations

### Optional Local Embeddings (Phase 6)

If users strongly request local embeddings:

- Document Ollama as external option
- `viberag` just calls `http://localhost:11434/api/embed`
- User manages Ollama separately
- No native ML deps in our codebase

### Rust Rewrite (Long-term)

For maximum performance and smallest binary:

- tree-sitter has native Rust bindings
- Single <20MB binary possible
- No runtime dependencies
