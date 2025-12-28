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

## Current State

### What Works
- [x] Local embeddings (Jina, transformers.js)
- [x] Cloud embeddings (Gemini, Mistral)
- [x] LanceDB vector storage
- [x] Semantic + hybrid search
- [x] MCP server protocol
- [x] Multi-editor setup wizard
- [x] File watching / incremental indexing

### What's Limited
- [ ] web-tree-sitter WASM ABI compatibility issues
- [ ] Some language grammars fail to load (C#, Dart, Swift, Kotlin, PHP)
- [ ] npm-only distribution
- [ ] No prebuilt binaries for native dependencies

---

## Phase 1: Native Tree-Sitter Migration

**Goal:** Replace web-tree-sitter with native tree-sitter for full language support and better performance.

**Timeline:** 2-3 days

### 1.1 Dependencies Update

```json
// package.json changes
{
  "dependencies": {
    // REMOVE
    "web-tree-sitter": "^0.26.3",
    "tree-sitter-wasms": "^0.1.13",

    // ADD - Native tree-sitter
    "tree-sitter": "^0.21.1",

    // ADD - Native grammar packages
    "tree-sitter-javascript": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0",
    "tree-sitter-python": "^0.21.0",
    "tree-sitter-go": "^0.21.0",
    "tree-sitter-rust": "^0.21.0",
    "tree-sitter-java": "^0.21.0",
    "tree-sitter-c-sharp": "^0.21.0",
    "tree-sitter-kotlin": "^0.3.8",
    "tree-sitter-swift": "^0.6.0",
    "tree-sitter-dart": "^1.0.0",
    "tree-sitter-php": "^0.23.0"
  },
  "devDependencies": {
    "prebuildify": "^6.0.0",
    "node-gyp": "^10.0.0"
  }
}
```

### 1.2 Chunker Refactor

```typescript
// source/rag/indexer/chunker.ts

// BEFORE: Async WASM loading
import {Parser, Language} from 'web-tree-sitter';

const parser = new Parser();
await Parser.init();
const lang = await Language.load(wasmPath);
parser.setLanguage(lang);

// AFTER: Synchronous native loading
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import Kotlin from 'tree-sitter-kotlin';
import Swift from 'tree-sitter-swift';
import Dart from 'tree-sitter-dart';
import PHP from 'tree-sitter-php';

const GRAMMARS: Record<SupportedLanguage, any> = {
  javascript: JavaScript,
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
  go: Go,
  rust: Rust,
  java: Java,
  csharp: CSharp,
  kotlin: Kotlin,
  swift: Swift,
  dart: Dart,
  php: PHP,
};

// Synchronous initialization
const parser = new Parser();
parser.setLanguage(GRAMMARS[language]);  // No await needed!
```

### 1.3 API Changes

| Before (web-tree-sitter) | After (native) |
|--------------------------|----------------|
| `await Parser.init()` | Not needed |
| `await Language.load(path)` | `require('tree-sitter-lang')` |
| `parser.setLanguage(lang)` | `parser.setLanguage(grammar)` |
| Async initialization | Sync initialization |
| WASM file resolution | Module resolution |

### 1.4 Fallback Strategy

```typescript
// Optional: Keep WASM as fallback for edge cases
let useNative = true;

try {
  const Parser = require('tree-sitter');
  // Native works
} catch (e) {
  console.warn('Native tree-sitter unavailable, falling back to WASM');
  useNative = false;
  const {Parser} = await import('web-tree-sitter');
  await Parser.init();
}
```

### 1.5 Testing

- [ ] All 12 languages parse correctly
- [ ] Export detection works for all languages
- [ ] Decorator extraction works for all languages
- [ ] Docstring extraction works for all languages
- [ ] Performance benchmark vs WASM

---

## Phase 2: Prebuildify CI/CD

**Goal:** Pre-compile native binaries for all major platforms so users don't need build tools.

**Timeline:** 1-2 days

### 2.1 Supported Platforms

| OS | Architecture | Node ABI | Priority |
|----|--------------|----------|----------|
| Linux | x64 | napi | P0 |
| Linux | arm64 | napi | P1 |
| macOS | x64 (Intel) | napi | P0 |
| macOS | arm64 (Apple Silicon) | napi | P0 |
| Windows | x64 | napi | P0 |
| Windows | arm64 | napi | P2 |

### 2.2 GitHub Actions Workflow

```yaml
# .github/workflows/prebuild.yml
name: Prebuild Native Binaries

on:
  push:
    branches: [master]
    tags: ['v*']
  pull_request:
    branches: [master]

jobs:
  prebuild:
    strategy:
      fail-fast: false
      matrix:
        include:
          # Linux x64
          - os: ubuntu-20.04
            arch: x64
            node: 20

          # Linux arm64 (cross-compile)
          - os: ubuntu-20.04
            arch: arm64
            node: 20

          # macOS Intel
          - os: macos-13
            arch: x64
            node: 20

          # macOS Apple Silicon
          - os: macos-14
            arch: arm64
            node: 20

          # Windows x64
          - os: windows-2022
            arch: x64
            node: 20

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      - name: Install dependencies
        run: npm ci

      - name: Build prebuilds
        run: npx prebuildify --napi --strip --arch ${{ matrix.arch }}

      - name: Test prebuilds
        run: npm test

      - name: Upload prebuilds
        uses: actions/upload-artifact@v4
        with:
          name: prebuilds-${{ matrix.os }}-${{ matrix.arch }}
          path: prebuilds/
          retention-days: 30

  # Merge all prebuilds and publish
  publish:
    needs: prebuild
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'

      - name: Download all prebuilds
        uses: actions/download-artifact@v4
        with:
          path: prebuilds/
          pattern: prebuilds-*
          merge-multiple: true

      - name: List prebuilds
        run: ls -la prebuilds/

      - name: Publish to npm
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 2.3 Package.json Scripts

```json
{
  "scripts": {
    "install": "prebuild-install || echo 'Prebuild not found, using fallback'",
    "prebuild": "prebuildify --napi --strip",
    "prebuild:all": "prebuildify-cross -i centos7-devtoolset7 -i alpine -i linux-arm64 -i darwin-x64 -i darwin-arm64"
  },
  "files": [
    "dist/",
    "prebuilds/"
  ]
}
```

---

## Phase 3: Standalone Executables

**Goal:** Create self-contained executables that don't require Node.js installation.

**Timeline:** 1-2 days

### 3.1 Executable Builder Selection

| Tool | Pros | Cons | Recommendation |
|------|------|------|----------------|
| **pkg** | Mature, widely used | Vercel maintenance unclear | Good choice |
| **nexe** | Active development | Less popular | Alternative |
| **caxa** | Simple, modern | Less features | For simple cases |
| **sea** (Node 20+) | Official Node.js | Experimental | Future option |

**Decision:** Use `pkg` for now, evaluate Node.js SEA when stable.

### 3.2 pkg Configuration

```json
// package.json
{
  "bin": {
    "viberag": "./dist/cli/index.js"
  },
  "pkg": {
    "scripts": "dist/**/*.js",
    "assets": [
      "dist/**/*.wasm",
      "node_modules/@anthropic-ai/**/*",
      "node_modules/onnxruntime-node/**/*"
    ],
    "targets": [
      "node20-linux-x64",
      "node20-linux-arm64",
      "node20-macos-x64",
      "node20-macos-arm64",
      "node20-win-x64"
    ],
    "outputPath": "standalone"
  }
}
```

### 3.3 Build Script

```bash
#!/bin/bash
# scripts/build-standalone.sh

set -e

echo "Building standalone executables..."

# Clean previous builds
rm -rf standalone/

# Build TypeScript
npm run build

# Package for each target
npx pkg . \
  --target node20-linux-x64,node20-linux-arm64,node20-macos-x64,node20-macos-arm64,node20-win-x64 \
  --output standalone/viberag \
  --compress GZip

# Rename outputs
mv standalone/viberag-linux-x64 standalone/viberag-linux-x64
mv standalone/viberag-linux-arm64 standalone/viberag-linux-arm64
mv standalone/viberag-macos-x64 standalone/viberag-darwin-x64
mv standalone/viberag-macos-arm64 standalone/viberag-darwin-arm64
mv standalone/viberag-win-x64.exe standalone/viberag-win-x64.exe

# Create checksums
cd standalone
sha256sum * > checksums.sha256
cd ..

echo "Build complete!"
ls -lh standalone/
```

### 3.4 GitHub Release Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build-standalone:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: node20-linux-x64
            artifact: viberag-linux-x64
          - os: ubuntu-latest
            target: node20-linux-arm64
            artifact: viberag-linux-arm64
          - os: macos-13
            target: node20-macos-x64
            artifact: viberag-darwin-x64
          - os: macos-14
            target: node20-macos-arm64
            artifact: viberag-darwin-arm64
          - os: windows-latest
            target: node20-win-x64
            artifact: viberag-win-x64.exe

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci
      - run: npm run build

      - name: Build standalone
        run: npx pkg . -t ${{ matrix.target }} -o ${{ matrix.artifact }}

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ matrix.artifact }}

  create-release:
    needs: build-standalone
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts/

      - name: Create checksums
        run: |
          cd artifacts
          find . -type f -exec sha256sum {} \; > checksums.sha256

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            artifacts/**/*
          generate_release_notes: true
          draft: false
```

---

## Phase 4: Package Manager Distribution

**Goal:** Distribute via Homebrew, apt, scoop, and other package managers.

**Timeline:** 2-3 days

### 4.1 Homebrew Tap

```ruby
# homebrew-viberag/Formula/viberag.rb
class Viberag < Formula
  desc "Local Code RAG MCP Server for AI coding assistants"
  homepage "https://github.com/YourOrg/viberag"
  version "0.2.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_ARM64"
    end
    on_intel do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/YourOrg/viberag/releases/download/v#{version}/viberag-linux-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64"
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

**Setup:**
```bash
# Create tap repository
gh repo create YourOrg/homebrew-viberag --public

# Users install via:
brew tap YourOrg/viberag
brew install viberag
```

### 4.2 Install Script

```bash
#!/bin/bash
# install.sh - Universal installer for viberag

set -e

REPO="YourOrg/viberag"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux*)  OS="linux" ;;
  darwin*) OS="darwin" ;;
  mingw*|msys*|cygwin*) OS="win" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY="viberag-${OS}-${ARCH}"
if [ "$OS" = "win" ]; then
  BINARY="${BINARY}.exe"
fi

# Get latest version
VERSION=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

echo "Installing viberag ${VERSION} for ${OS}-${ARCH}..."

# Download
URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
curl -fsSL "$URL" -o /tmp/viberag

# Install
chmod +x /tmp/viberag
sudo mv /tmp/viberag "${INSTALL_DIR}/viberag"

echo "viberag installed successfully!"
echo "Run 'viberag --help' to get started."
```

**Usage:**
```bash
curl -fsSL https://viberag.dev/install.sh | sh
```

### 4.3 Scoop (Windows)

```json
// scoop-bucket/viberag.json
{
  "version": "0.2.0",
  "description": "Local Code RAG MCP Server for AI coding assistants",
  "homepage": "https://github.com/YourOrg/viberag",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "https://github.com/YourOrg/viberag/releases/download/v0.2.0/viberag-win-x64.exe",
      "hash": "PLACEHOLDER_SHA256"
    }
  },
  "bin": "viberag-win-x64.exe",
  "checkver": "github",
  "autoupdate": {
    "architecture": {
      "64bit": {
        "url": "https://github.com/YourOrg/viberag/releases/download/v$version/viberag-win-x64.exe"
      }
    }
  }
}
```

### 4.4 APT Repository (Debian/Ubuntu)

```yaml
# .github/workflows/apt-repo.yml
name: Update APT Repository

on:
  release:
    types: [published]

jobs:
  update-apt:
    runs-on: ubuntu-latest
    steps:
      - name: Download release
        run: |
          curl -fsSL https://github.com/${GITHUB_REPOSITORY}/releases/download/${{ github.event.release.tag_name }}/viberag-linux-x64 -o viberag

      - name: Create .deb package
        run: |
          mkdir -p pkg/usr/local/bin
          cp viberag pkg/usr/local/bin/
          chmod +x pkg/usr/local/bin/viberag

          mkdir -p pkg/DEBIAN
          cat > pkg/DEBIAN/control << EOF
          Package: viberag
          Version: ${{ github.event.release.tag_name }}
          Section: devel
          Priority: optional
          Architecture: amd64
          Maintainer: YourOrg <support@yourorg.com>
          Description: Local Code RAG MCP Server
          EOF

          dpkg-deb --build pkg viberag.deb

      # Upload to apt repository (e.g., using Cloudsmith, Packagecloud, or self-hosted)
```

---

## Phase 5: Language Support Matrix

**Goal:** Ensure comprehensive language support with native tree-sitter.

### 5.1 Tier 1 Languages (Full Support)

| Language | Grammar Package | Export Detection | Decorators | Docstrings |
|----------|-----------------|------------------|------------|------------|
| JavaScript | tree-sitter-javascript | `export` keyword | `@decorator` | `/** */` |
| TypeScript | tree-sitter-typescript | `export` keyword | `@decorator` | `/** */` |
| TSX | tree-sitter-typescript | `export` keyword | `@decorator` | `/** */` |
| Python | tree-sitter-python | `_` prefix | `@decorator` | `"""docstring"""` |
| Go | tree-sitter-go | Capitalization | N/A | `// comment` |
| Rust | tree-sitter-rust | `pub` keyword | `#[attr]` | `///` or `//!` |
| Java | tree-sitter-java | `public` keyword | `@Annotation` | `/** */` |

### 5.2 Tier 2 Languages (Standard Support)

| Language | Grammar Package | Export Detection | Decorators | Docstrings |
|----------|-----------------|------------------|------------|------------|
| C# | tree-sitter-c-sharp | `public` keyword | `[Attribute]` | `/// <summary>` |
| Kotlin | tree-sitter-kotlin | default public | `@Annotation` | `/** */` |
| Swift | tree-sitter-swift | `public` keyword | `@attribute` | `///` |
| PHP | tree-sitter-php | `public` keyword | `#[Attr]` | `/** */` |
| Dart | tree-sitter-dart | `_` prefix | `@annotation` | `///` |

### 5.3 Future Languages (Planned)

| Language | Priority | Grammar Package |
|----------|----------|-----------------|
| C/C++ | P1 | tree-sitter-c, tree-sitter-cpp |
| Ruby | P1 | tree-sitter-ruby |
| Scala | P2 | tree-sitter-scala |
| Elixir | P2 | tree-sitter-elixir |
| Lua | P3 | tree-sitter-lua |
| Zig | P3 | tree-sitter-zig |

---

## Phase 6: Testing & Validation

**Goal:** Comprehensive testing across platforms and languages.

### 6.1 Test Matrix

```yaml
# .github/workflows/test.yml
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [18, 20, 22]

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm test
      - run: npm run test:integration
```

### 6.2 Language Integration Tests

```typescript
// source/rag/__tests__/native-languages.test.ts
describe('Native Tree-Sitter Languages', () => {
  const languages = [
    { ext: '.js', lang: 'javascript', grammar: 'tree-sitter-javascript' },
    { ext: '.ts', lang: 'typescript', grammar: 'tree-sitter-typescript' },
    { ext: '.py', lang: 'python', grammar: 'tree-sitter-python' },
    { ext: '.go', lang: 'go', grammar: 'tree-sitter-go' },
    { ext: '.rs', lang: 'rust', grammar: 'tree-sitter-rust' },
    { ext: '.java', lang: 'java', grammar: 'tree-sitter-java' },
    { ext: '.cs', lang: 'csharp', grammar: 'tree-sitter-c-sharp' },
    { ext: '.kt', lang: 'kotlin', grammar: 'tree-sitter-kotlin' },
    { ext: '.swift', lang: 'swift', grammar: 'tree-sitter-swift' },
    { ext: '.dart', lang: 'dart', grammar: 'tree-sitter-dart' },
    { ext: '.php', lang: 'php', grammar: 'tree-sitter-php' },
  ];

  test.each(languages)('$lang grammar loads correctly', ({ lang, grammar }) => {
    const Parser = require('tree-sitter');
    const Grammar = require(grammar);

    const parser = new Parser();
    expect(() => parser.setLanguage(Grammar)).not.toThrow();
  });

  test.each(languages)('$lang parses sample file', async ({ ext, lang }) => {
    const fixture = path.join(__dirname, `../../test-fixtures/codebase/sample${ext}`);
    const content = await fs.readFile(fixture, 'utf-8');

    const parser = new Parser();
    parser.setLanguage(GRAMMARS[lang]);

    const tree = parser.parse(content);
    expect(tree.rootNode).toBeDefined();
    expect(tree.rootNode.hasError()).toBe(false);
  });
});
```

### 6.3 Platform Smoke Tests

```typescript
// source/rag/__tests__/platform.test.ts
describe('Platform Compatibility', () => {
  it('identifies correct platform', () => {
    expect(['darwin', 'linux', 'win32']).toContain(process.platform);
  });

  it('identifies correct architecture', () => {
    expect(['x64', 'arm64']).toContain(process.arch);
  });

  it('loads native bindings', () => {
    expect(() => require('tree-sitter')).not.toThrow();
  });

  it('ONNX runtime loads', async () => {
    const { InferenceSession } = await import('onnxruntime-node');
    expect(InferenceSession).toBeDefined();
  });
});
```

---

## Phase 7: Documentation & Website

**Goal:** Create documentation and landing page for the project.

### 7.1 Documentation Structure

```
docs/
├── index.md                 # Home / Getting Started
├── installation.md          # All installation methods
├── configuration.md         # Config options
├── languages.md             # Supported languages
├── mcp-setup.md            # MCP server setup
├── api-reference.md        # CLI commands
├── troubleshooting.md      # Common issues
└── contributing.md         # Development guide
```

### 7.2 Landing Page (viberag.dev)

```
┌─────────────────────────────────────────────────────────────┐
│                        VIBERAG                              │
│         Local Code RAG for AI Coding Assistants             │
│                                                             │
│  Semantic code search for Claude, Cursor, Copilot & more   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  npm install -g viberag                             │   │
│  │  viberag init                                       │   │
│  │  viberag mcp-setup                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [Get Started]  [Documentation]  [GitHub]                   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  FEATURES                                                   │
│  ✓ 12+ Programming Languages                               │
│  ✓ Semantic & Hybrid Search                                │
│  ✓ Local Embeddings (No API Keys)                          │
│  ✓ Multi-Editor Support                                    │
│  ✓ Incremental Indexing                                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Timeline

| Phase | Description | Duration | Dependencies |
|-------|-------------|----------|--------------|
| 1 | Native Tree-Sitter Migration | 2-3 days | None |
| 2 | Prebuildify CI/CD | 1-2 days | Phase 1 |
| 3 | Standalone Executables | 1-2 days | Phase 2 |
| 4 | Package Manager Distribution | 2-3 days | Phase 3 |
| 5 | Language Support Matrix | Ongoing | Phase 1 |
| 6 | Testing & Validation | 1-2 days | Phase 1-3 |
| 7 | Documentation & Website | 2-3 days | Phase 1-4 |

**Total Estimated Time:** 2-3 weeks

---

## Success Metrics

1. **Installation Success Rate:** >99% of npm installs succeed without build errors
2. **Platform Coverage:** 5 platforms (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64)
3. **Language Support:** 12+ languages with full AST parsing
4. **Parse Performance:** <100ms for files up to 10,000 lines
5. **Package Size:** <100MB for npm package with prebuilds
6. **Standalone Size:** <150MB per platform executable

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Grammar package breaking changes | Pin versions, test in CI |
| Prebuild failures on exotic platforms | WASM fallback |
| pkg bundling issues | Explicit asset configuration |
| Large package size | Compress prebuilds, lazy loading |
| Native binding ABI changes | Rebuild on Node.js major versions |

---

## Long-Term Considerations

### Rust Rewrite (Future)
For maximum performance and smallest binary size, consider rewriting core parsing in Rust:
- tree-sitter has native Rust bindings
- ort crate for ONNX embeddings
- Single <20MB binary
- No runtime dependencies

### WASI Support (Future)
WebAssembly System Interface could enable:
- Running in browsers
- Edge compute (Cloudflare Workers, etc.)
- Truly universal single binary

---

## Appendix: Full CI/CD Configuration

See `.github/workflows/` for complete workflow files:
- `ci.yml` - Continuous integration
- `prebuild.yml` - Native binary prebuilds
- `release.yml` - Standalone executables & GitHub release
- `publish.yml` - npm publishing
- `homebrew.yml` - Homebrew formula updates
