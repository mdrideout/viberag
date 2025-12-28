# ADR-005: Code Indexing Strategy — Facts Not Interpretations

## Status

Accepted

## Context

VibeRAG provides semantic code search for AI coding assistants via MCP. To improve search precision and enable new query types, we considered enriching the index with pre-computed metadata about code chunks.

The key tension:

1. **More metadata = better filtering** — If we know a file is a "test file", we can exclude it from production code searches
2. **Heuristic metadata = risk of errors** — If we wrongly classify a file as "test", it gets silently excluded from results

AI agents rely on our search results to understand codebases. **Silent false negatives are the worst failure mode** — the AI doesn't know what it's missing, can't recover, and may produce incorrect analysis or changes.

### Query Types We Must Support

| Query Type        | Example                           | Ideal Approach                   |
| ----------------- | --------------------------------- | -------------------------------- |
| Conceptual        | "How does authentication work?"   | Semantic (vector) search         |
| Exact symbol      | "Find handlePaymentWebhook"       | Keyword (BM25) search            |
| Definition lookup | "Where is UserService defined?"   | Metadata filter                  |
| Exhaustive        | "Find ALL uses of deprecated API" | Full scan with keyword match     |
| Scoped            | "Auth code, not tests"            | Filtered search                  |
| Similar code      | "Find code like this pattern"     | Vector search with code as query |

### The Metadata Dilemma

We evaluated two approaches:

**Approach A: Rich pre-computed categories**

```
file_category: "test" | "source" | "config"
service_name: "api" | "frontend" | "worker"
is_api_endpoint: true | false
event_type: "publish" | "subscribe" | null
```

**Approach B: Raw facts only**

```
filepath: "src/api/auth/handlers.ts"
extension: ".ts"
type: "function"
name: "handleLogin"
decorator_names: "Get,Auth"
is_exported: true
```

## Decision

We adopt **Approach B: Store facts, not interpretations**.

### What We Index

#### 1. Existing Fields (unchanged)

- `filepath`, `filename`, `extension` — File location facts
- `type` — AST-derived: "function", "class", "method", "module"
- `name` — Symbol name from AST
- `start_line`, `end_line` — Location in file
- `text` — The actual code content
- `vector` — Embedding for semantic search

#### 2. New Deterministic Fields

- `signature` — Function/method signature line (first line of declaration)
- `docstring` — Extracted documentation (JSDoc, Python docstring, etc.)
- `is_exported` — Boolean: does this symbol have `export` modifier?
- `decorator_names` — Comma-separated list of decorator/annotation names

All new fields are **deterministic extractions from the AST**. If the extraction is wrong, it's a bug to fix — not a heuristic that varies by codebase.

### What We Do NOT Index

| Rejected Field    | Reason                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `file_category`   | Heuristic. What's a "test file" varies by project. `src/test-utils/helpers.ts` — is that a test? Conventions differ. |
| `service_name`    | Heuristic. Requires knowing project structure. Could be wrong, causing silent exclusions.                            |
| `language`        | Redundant. We have `extension`. AI can map `.ts` → TypeScript if needed.                                             |
| `is_api_endpoint` | Framework-specific. Express, Fastify, NestJS, Flask all differ. Detection is fragile.                                |
| `event_type`      | Framework-specific. EventEmitter, Kafka, Pub/Sub, custom buses — too many patterns.                                  |
| `complexity_tier` | Arbitrary. "Simple" vs "complex" is subjective and low-value.                                                        |

### How AI Agents Filter Instead

Instead of pre-computed categories, we provide **transparent path-based filters**:

```typescript
// AI wants: "Find auth code, not tests"

// BAD: Opaque category (we might be wrong)
filters: { file_category: "source", path_contains: ["auth"] }

// GOOD: Explicit path exclusion (AI controls exactly what's excluded)
filters: {
  path_contains: ["auth"],
  path_not_contains: ["test", "__tests__", "spec", ".test.", ".spec."]
}
```

The AI sees exactly what's being filtered. If the project has unusual conventions, the AI can adjust.

### Why Multi-Stage Search Beats Detection

We considered pre-computing event publishers/subscribers and API endpoints. Instead, we rely on multi-stage search:

**Pre-computed detection (rejected):**

- Must understand every framework's patterns
- Breaks when patterns change or are custom
- False positives/negatives are invisible to AI
- Maintenance burden for new frameworks

**Multi-stage search (adopted):**

```
Stage 1: viberag_search(query="event publish emit", mode="semantic")
         → Finds event-related code

Stage 2: viberag_search(query="order-created", mode="exact")
         → Finds specific event references

Stage 3: AI reads results, interprets which are publishers vs subscribers
```

The AI has domain knowledge we don't. It can handle framework variations, custom patterns, and ambiguous cases.

## Consequences

### Positive

1. **No silent false negatives** — We never exclude code the AI should see due to misclassification
2. **Framework-agnostic** — Works with any framework, any conventions, any project structure
3. **AI-controlled filtering** — Agents construct explicit filters, can adjust for unusual projects
4. **No maintenance burden** — Don't need to track new frameworks or pattern variations
5. **Transparent behavior** — AI can reason about what's filtered and why

### Negative

1. **More verbose filter construction** — AI must explicitly exclude test paths instead of `category != 'test'`
2. **No pre-computed graphs** — Event flow tracing requires multi-stage search, not single query
3. **AI does more work** — Interpretation happens at query time, not index time

### Neutral

1. **Multi-stage search pattern** — Neither better nor worse, just different. AI chains calls instead of one complex query.
2. **Decorator-based filtering** — Partially replaces endpoint detection. `decorator_contains: "Get"` finds route handlers without understanding the framework.

## Alternatives Considered

### 1. Configurable Categories

Allow users to define category rules in `.viberag/categories.json`:

```json
{
	"test": ["**/test/**", "**/*.test.*"],
	"api": ["src/api/**"]
}
```

**Rejected**: Adds configuration complexity. Users would need to maintain rules. Defaults would still be wrong for some projects.

### 2. Confidence-Scored Categories

Store categories with confidence scores, let AI decide threshold:

```
file_category: "test"
category_confidence: 0.8
```

**Rejected**: Adds complexity without solving the core problem. Low-confidence classifications are still classifications.

### 3. Framework Detection Plugins

Pluggable detectors for Express, NestJS, Django, etc.:

```typescript
plugins: [expressDetector, nestjsDetector, djangoDetector];
```

**Rejected**: Maintenance burden. Always behind on new frameworks. Still fragile for custom patterns.

### 4. Hybrid: Facts + Optional Categories

Store facts always, categories optionally based on user config.

**Rejected**: Complexity. Two code paths. Users confused about when categories exist.

## Implementation Notes

### Safe Metadata Extraction

All new fields use deterministic AST extraction:

**Signature**: First line of function/class/method declaration

```typescript
// Input
export async function handleLogin(req: Request, res: Response): Promise<void> {
	// ... body
}

// Extracted signature
('export async function handleLogin(req: Request, res: Response): Promise<void>');
```

**Docstring**: First comment/string in function body

```typescript
// Input
function calculate(x: number) {
	/** Calculates the result */
	return x * 2;
}

// Extracted docstring
('Calculates the result');
```

**is_exported**: Presence of `export` keyword

```typescript
export function foo() {} // is_exported = true
function bar() {} // is_exported = false
```

**decorator_names**: List of decorator identifiers

```typescript
@Get('/users')
@Auth()
@Validate(UserSchema)
async getUsers() {}

// decorator_names = "Get,Auth,Validate"
```

### Filter Implementation

Path filters map to LanceDB WHERE clauses:

| Filter                        | LanceDB                        |
| ----------------------------- | ------------------------------ |
| `path_prefix: "src/api/"`     | `filepath LIKE 'src/api/%'`    |
| `path_contains: ["auth"]`     | `filepath LIKE '%auth%'`       |
| `path_not_contains: ["test"]` | `filepath NOT LIKE '%test%'`   |
| `extension: [".ts"]`          | `extension = '.ts'`            |
| `type: ["function"]`          | `type = 'function'`            |
| `is_exported: true`           | `is_exported = true`           |
| `decorator_contains: "Get"`   | `decorator_names LIKE '%Get%'` |

### Symbol Index (Phase 3)

The symbol index is a separate table tracking definitions vs usages:

```
| name | role | filepath | line |
|------|------|----------|------|
| UserService | definition | src/services/user.ts | 15 |
| UserService | import | src/api/auth.ts | 3 |
| UserService | usage | src/api/auth.ts | 45 |
```

This is **deterministic** — a definition is a definition, an import is an import. No heuristics involved.

## References

- ADR-004: Embedding Model Selection (related: what we embed)
- MCP_ENHANCE_PLAN.md (implementation details)
