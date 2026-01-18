/**
 * V2 eval harness - generates queries from the indexed corpus and measures
 * retrieval quality + latency.
 *
 * This is a pragmatic harness intended to catch regressions and make search
 * quality measurable (MRR/Recall/Hit + p50/p95 latency).
 */

import type {SearchEngineV2} from '../search/engine.js';
import type {
	V2SearchIntent,
	V2SearchResponse,
	V2SearchScope,
} from '../search/types.js';
import type {StorageV2} from '../storage/index.js';

export type V2EvalOptions = {
	definition_samples?: number;
	concept_samples?: number;
	exact_text_samples?: number;
	similar_code_samples?: number;
	seed?: number;
	explain?: boolean;
	scope?: V2SearchScope;
};

type BucketResult = {
	queries: number;
	latency_ms: {p50: number; p95: number};
	metrics: Record<string, number>;
	failures: Array<Record<string, unknown>>;
};

export type V2EvalReport = {
	started_at: string;
	finished_at: string;
	duration_ms: number;
	options: Required<
		Pick<
			V2EvalOptions,
			| 'definition_samples'
			| 'concept_samples'
			| 'exact_text_samples'
			| 'similar_code_samples'
			| 'seed'
			| 'explain'
		>
	> & {scope: V2SearchScope};
	buckets: {
		definition: BucketResult;
		concept: BucketResult;
		exact_text: BucketResult;
		similar_code: BucketResult;
	};
};

export async function runV2Eval(args: {
	engine: SearchEngineV2;
	storage: StorageV2;
	options?: V2EvalOptions;
}): Promise<V2EvalReport> {
	const startedAt = new Date();
	const options: V2EvalReport['options'] = {
		definition_samples: args.options?.definition_samples ?? 25,
		concept_samples: args.options?.concept_samples ?? 20,
		exact_text_samples: args.options?.exact_text_samples ?? 20,
		similar_code_samples: args.options?.similar_code_samples ?? 15,
		seed: args.options?.seed ?? 1337,
		explain: args.options?.explain ?? false,
		scope: args.options?.scope ?? {},
	};

	const scope = options.scope;

	const definition = await evalDefinitions({
		engine: args.engine,
		storage: args.storage,
		samples: options.definition_samples,
		seed: options.seed,
		explain: options.explain,
		scope,
	});

	const concept = await evalConcept({
		engine: args.engine,
		storage: args.storage,
		samples: options.concept_samples,
		seed: options.seed,
		explain: options.explain,
		scope,
	});

	const exactText = await evalExactText({
		engine: args.engine,
		storage: args.storage,
		samples: options.exact_text_samples,
		seed: options.seed,
		explain: options.explain,
		scope,
	});

	const similarCode = await evalSimilarCode({
		engine: args.engine,
		storage: args.storage,
		samples: options.similar_code_samples,
		seed: options.seed,
		explain: options.explain,
		scope,
	});

	const finishedAt = new Date();

	return {
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: finishedAt.getTime() - startedAt.getTime(),
		options,
		buckets: {
			definition,
			concept,
			exact_text: exactText,
			similar_code: similarCode,
		},
	};
}

async function evalDefinitions(args: {
	engine: SearchEngineV2;
	storage: StorageV2;
	samples: number;
	seed: number;
	explain: boolean;
	scope: V2SearchScope;
}): Promise<BucketResult> {
	const latencies: number[] = [];
	const failures: Array<Record<string, unknown>> = [];

	const symbolRows = (await args.storage
		.getSymbolsTable()
		.query()
		.select(['symbol_id', 'symbol_name', 'file_path'])
		.toArray()) as Array<Record<string, unknown>>;

	const candidates = symbolRows
		.map(r => ({
			symbol_id: String(r['symbol_id'] ?? ''),
			symbol_name: String(r['symbol_name'] ?? ''),
			file_path: String(r['file_path'] ?? ''),
		}))
		.filter(r => r.symbol_id && r.symbol_name);

	const rng = mulberry32(args.seed);
	const sampled = sampleArray(candidates, args.samples, rng);

	let total = 0;
	let mrrSum = 0;
	let top3 = 0;

	for (const row of sampled) {
		const queries = [row.symbol_name];
		const fuzzed = fuzzDeleteMiddle(row.symbol_name);
		if (fuzzed) {
			queries.push(fuzzed);
		}

		for (const query of queries) {
			total += 1;
			const {result, elapsedMs} = await timedSearch(args.engine, query, {
				intent: 'definition',
				k: 10,
				explain: args.explain,
				scope: args.scope,
			});
			latencies.push(elapsedMs);

			const rank = rankOfId(result, 'definitions', row.symbol_id, 10);
			if (rank > 0) {
				mrrSum += 1 / rank;
				if (rank <= 3) top3 += 1;
			} else if (failures.length < 10) {
				failures.push({
					query,
					expected_symbol_id: row.symbol_id,
					expected_symbol_name: row.symbol_name,
					expected_file_path: row.file_path,
					top_hits: result.groups.definitions
						.slice(0, 5)
						.map(h => ({id: h.id, title: h.title, file_path: h.file_path})),
				});
			}
		}
	}

	return {
		queries: total,
		latency_ms: {
			p50: percentile(latencies, 50),
			p95: percentile(latencies, 95),
		},
		metrics: {
			mrr_at_10: total > 0 ? Number((mrrSum / total).toFixed(6)) : 0,
			top3_rate: total > 0 ? Number((top3 / total).toFixed(6)) : 0,
		},
		failures,
	};
}

async function evalConcept(args: {
	engine: SearchEngineV2;
	storage: StorageV2;
	samples: number;
	seed: number;
	explain: boolean;
	scope: V2SearchScope;
}): Promise<BucketResult> {
	const latencies: number[] = [];
	const failures: Array<Record<string, unknown>> = [];

	const symbolRows = (await args.storage
		.getSymbolsTable()
		.query()
		.select(['symbol_id', 'file_path', 'docstring', 'signature'])
		.toArray()) as Array<Record<string, unknown>>;

	const candidates = symbolRows
		.map(r => ({
			symbol_id: String(r['symbol_id'] ?? ''),
			file_path: String(r['file_path'] ?? ''),
			docstring: typeof r['docstring'] === 'string' ? r['docstring'] : null,
			signature: typeof r['signature'] === 'string' ? r['signature'] : null,
		}))
		.map(r => ({
			...r,
			query: normalizeDocQuery(r.docstring ?? r.signature ?? ''),
		}))
		.filter(r => r.symbol_id && r.file_path && r.query.length >= 12);

	const rng = mulberry32(args.seed ^ 0xabcddcba);
	const sampled = sampleArray(candidates, args.samples, rng);

	let total = 0;
	let hits = 0;

	for (const row of sampled) {
		total += 1;
		const {result, elapsedMs} = await timedSearch(args.engine, row.query, {
			intent: 'concept',
			k: 50,
			explain: args.explain,
			scope: args.scope,
		});
		latencies.push(elapsedMs);

		const ok =
			hasFilePathHit(result, row.file_path, 50) ||
			hasIdHit(result, row.symbol_id, 50);
		if (ok) {
			hits += 1;
		} else if (failures.length < 10) {
			failures.push({
				query: row.query,
				expected_symbol_id: row.symbol_id,
				expected_file_path: row.file_path,
				top_files: result.groups.files.slice(0, 5).map(h => h.file_path),
				top_defs: result.groups.definitions
					.slice(0, 5)
					.map(h => ({id: h.id, file_path: h.file_path, title: h.title})),
			});
		}
	}

	return {
		queries: total,
		latency_ms: {
			p50: percentile(latencies, 50),
			p95: percentile(latencies, 95),
		},
		metrics: {
			recall_at_50: total > 0 ? Number((hits / total).toFixed(6)) : 0,
		},
		failures,
	};
}

async function evalExactText(args: {
	engine: SearchEngineV2;
	storage: StorageV2;
	samples: number;
	seed: number;
	explain: boolean;
	scope: V2SearchScope;
}): Promise<BucketResult> {
	const latencies: number[] = [];
	const failures: Array<Record<string, unknown>> = [];

	const refsRows = (await args.storage
		.getRefsTable()
		.query()
		.where("ref_kind = 'string_literal'")
		.select(['file_path', 'start_line', 'token_text'])
		.toArray()) as Array<Record<string, unknown>>;

	const candidates = refsRows
		.map(r => ({
			file_path: String(r['file_path'] ?? ''),
			start_line: Number(r['start_line'] ?? 0),
			token_text: String(r['token_text'] ?? ''),
		}))
		.filter(
			r =>
				r.file_path &&
				r.start_line > 0 &&
				r.token_text.length >= 8 &&
				r.token_text.length <= 160,
		);

	const rng = mulberry32(args.seed ^ 0x53f00d);
	const sampled = sampleArray(
		dedupeBy(candidates, r => `${r.file_path}:${r.start_line}:${r.token_text}`),
		args.samples,
		rng,
	);

	let total = 0;
	let hit5 = 0;

	for (const row of sampled) {
		total += 1;
		const {result, elapsedMs} = await timedSearch(args.engine, row.token_text, {
			intent: 'exact_text',
			k: 5,
			explain: args.explain,
			scope: args.scope,
		});
		latencies.push(elapsedMs);

		const ok = result.groups.blocks.slice(0, 5).some(hit => {
			if (hit.file_path !== row.file_path) return false;
			return hit.start_line <= row.start_line && hit.end_line >= row.start_line;
		});

		if (ok) {
			hit5 += 1;
		} else if (failures.length < 10) {
			failures.push({
				query: row.token_text,
				expected_file_path: row.file_path,
				expected_line: row.start_line,
				top_blocks: result.groups.blocks.slice(0, 5).map(h => ({
					file_path: h.file_path,
					start_line: h.start_line,
					end_line: h.end_line,
				})),
			});
		}
	}

	return {
		queries: total,
		latency_ms: {
			p50: percentile(latencies, 50),
			p95: percentile(latencies, 95),
		},
		metrics: {
			hit_at_5: total > 0 ? Number((hit5 / total).toFixed(6)) : 0,
		},
		failures,
	};
}

async function evalSimilarCode(args: {
	engine: SearchEngineV2;
	storage: StorageV2;
	samples: number;
	seed: number;
	explain: boolean;
	scope: V2SearchScope;
}): Promise<BucketResult> {
	const latencies: number[] = [];
	const failures: Array<Record<string, unknown>> = [];

	const chunkRows = (await args.storage
		.getChunksTable()
		.query()
		.select(['chunk_id', 'file_path', 'code_text'])
		.toArray()) as Array<Record<string, unknown>>;

	const candidates = chunkRows
		.map(r => ({
			chunk_id: String(r['chunk_id'] ?? ''),
			file_path: String(r['file_path'] ?? ''),
			code_text: String(r['code_text'] ?? ''),
		}))
		.filter(r => r.chunk_id && r.file_path && r.code_text.length >= 40);

	const rng = mulberry32(args.seed ^ 0x9910);
	const sampled = sampleArray(candidates, args.samples, rng);

	let total = 0;
	let mrrSum = 0;

	for (const row of sampled) {
		total += 1;
		const query = row.code_text.slice(0, 600);
		const {result, elapsedMs} = await timedSearch(args.engine, query, {
			intent: 'similar_code',
			k: 10,
			explain: args.explain,
			scope: args.scope,
		});
		latencies.push(elapsedMs);

		const rank = rankOfId(result, 'blocks', row.chunk_id, 10);
		if (rank > 0) {
			mrrSum += 1 / rank;
		} else if (failures.length < 10) {
			failures.push({
				query_preview: query.slice(0, 120),
				expected_chunk_id: row.chunk_id,
				expected_file_path: row.file_path,
				top_blocks: result.groups.blocks
					.slice(0, 5)
					.map(h => ({id: h.id, file_path: h.file_path, title: h.title})),
			});
		}
	}

	return {
		queries: total,
		latency_ms: {
			p50: percentile(latencies, 50),
			p95: percentile(latencies, 95),
		},
		metrics: {
			mrr_at_10: total > 0 ? Number((mrrSum / total).toFixed(6)) : 0,
		},
		failures,
	};
}

async function timedSearch(
	engine: SearchEngineV2,
	query: string,
	options: {
		intent: Exclude<V2SearchIntent, 'auto'>;
		k: number;
		explain: boolean;
		scope: V2SearchScope;
	},
): Promise<{result: V2SearchResponse; elapsedMs: number}> {
	const start = Date.now();
	const result = await engine.search(query, {
		intent: options.intent,
		k: options.k,
		explain: options.explain,
		scope: options.scope,
	});
	return {result, elapsedMs: Date.now() - start};
}

function rankOfId(
	result: V2SearchResponse,
	group: keyof V2SearchResponse['groups'],
	id: string,
	k: number,
): number {
	const hits = result.groups[group].slice(0, k);
	const idx = hits.findIndex(h => h.id === id);
	return idx >= 0 ? idx + 1 : 0;
}

function hasIdHit(result: V2SearchResponse, id: string, k: number): boolean {
	const groups = result.groups;
	const all = [
		...groups.definitions,
		...groups.usages,
		...groups.files,
		...groups.blocks,
	].slice(0, k * 4);
	return all.some(h => h.id === id);
}

function hasFilePathHit(
	result: V2SearchResponse,
	filePath: string,
	k: number,
): boolean {
	const groups = result.groups;
	const all = [
		...groups.definitions,
		...groups.usages,
		...groups.files,
		...groups.blocks,
	].slice(0, k * 4);
	return all.some(h => h.file_path === filePath);
}

function normalizeDocQuery(text: string): string {
	const cleaned = text
		.replace(/^[\s/*#-]+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned;
}

function fuzzDeleteMiddle(text: string): string | null {
	if (text.length < 6) return null;
	const i = Math.floor(text.length / 2);
	return (text.slice(0, i) + text.slice(i + 1)).trim() || null;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[idx] ?? 0;
}

function sampleArray<T>(items: T[], n: number, rng: () => number): T[] {
	if (n <= 0 || items.length === 0) return [];
	if (items.length <= n) return items;
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy.slice(0, n);
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = keyFn(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

function mulberry32(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t += 0x6d2b79f5;
		let x = t;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}
