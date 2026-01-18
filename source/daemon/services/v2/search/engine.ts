/**
 * V2 SearchEngine - intent routed retrieval over v2 tables.
 *
 * The goal is high-recall, agent-friendly results with explainability and
 * stable follow-up handles.
 */

import * as lancedb from '@lancedb/lancedb';
import type {Table} from '@lancedb/lancedb';
import {loadConfig, type EmbeddingProviderType} from '../../../lib/config.js';
import type {Logger} from '../../../lib/logger.js';
import {isAbortError, throwIfAborted} from '../../../lib/abort.js';
import {GeminiEmbeddingProvider} from '../../../providers/gemini.js';
import {LocalEmbeddingProvider} from '../../../providers/local.js';
import {MistralEmbeddingProvider} from '../../../providers/mistral.js';
import {OpenAIEmbeddingProvider} from '../../../providers/openai.js';
import type {EmbeddingProvider} from '../../../providers/types.js';
import {StorageV2} from '../storage/index.js';
import type {
	V2SearchIntent,
	V2SearchOptions,
	V2SearchResponse,
	V2SearchScope,
	V2HitBase,
	V2ExplainChannel,
	V2NextAction,
	V2FindUsagesOptions,
	V2FindUsagesResponse,
	V2UsageRef,
} from './types.js';

const DEFAULT_K = 20;
const RRF_K = 60;

export type SearchEngineV2Options = {
	logger?: Logger;
	storage?: StorageV2;
};

type Candidate = {
	table: 'symbols' | 'chunks' | 'files' | 'refs';
	id: string;
	file_path: string;
	start_line: number;
	end_line: number;
	title: string;
	snippet: string;
	is_exported?: boolean;
	ref_kind?: string;
	token_text?: string;
	module_name?: string | null;
	imported_name?: string | null;
	channels: V2ExplainChannel[];
};

export class SearchEngineV2 {
	private readonly projectRoot: string;
	private storage: StorageV2 | null = null;
	private embeddings: EmbeddingProvider | null = null;
	private logger: Logger | null = null;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private readonly externalStorage: boolean;

	constructor(projectRoot: string, options?: SearchEngineV2Options | Logger) {
		this.projectRoot = projectRoot;

		if (options && typeof options === 'object' && 'logger' in options) {
			this.logger = options.logger ?? null;
			if (options.storage) {
				this.storage = options.storage;
				this.externalStorage = true;
			} else {
				this.externalStorage = false;
			}
		} else {
			this.logger = (options as Logger | undefined) ?? null;
			this.externalStorage = false;
		}
	}

	async warmup(signal?: AbortSignal): Promise<void> {
		await this.ensureInitialized(signal);
	}

	async search(
		query: string,
		options: V2SearchOptions = {},
	): Promise<V2SearchResponse> {
		const intent = options.intent ?? 'auto';
		const intent_used = intent === 'auto' ? routeIntent(query) : intent;
		const k = options.k ?? DEFAULT_K;
		const explain = options.explain ?? true;
		const scope = options.scope ?? {};

		await this.ensureInitialized();
		const filterClause = buildScopeFilter(scope);

		const queryVector = await this.embeddings!.embedSingle(query);

		const groups = {
			definitions: [] as V2HitBase[],
			usages: [] as V2HitBase[],
			files: [] as V2HitBase[],
			blocks: [] as V2HitBase[],
		};

		switch (intent_used) {
			case 'definition': {
				const defs = await this.retrieveDefinitions(
					query,
					queryVector,
					k,
					filterClause,
					explain,
				);
				groups.definitions = defs;
				break;
			}
			case 'concept': {
				const [files, defs, blocks] = await Promise.all([
					this.retrieveFiles(
						query,
						queryVector,
						Math.max(5, Math.round(k / 3)),
						filterClause,
						explain,
					),
					this.retrieveDefinitions(
						query,
						queryVector,
						Math.max(10, Math.round(k / 2)),
						filterClause,
						explain,
					),
					this.retrieveBlocks(
						query,
						queryVector,
						Math.max(10, Math.round(k / 2)),
						filterClause,
						explain,
					),
				]);
				groups.files = files;
				groups.definitions = defs;
				groups.blocks = blocks;
				break;
			}
			case 'exact_text': {
				const blocks = await this.retrieveExactText(
					query,
					k,
					filterClause,
					explain,
				);
				groups.blocks = blocks;
				break;
			}
			case 'similar_code': {
				const blocks = await this.retrieveSimilarCode(
					queryVector,
					k,
					filterClause,
					explain,
				);
				groups.blocks = blocks;
				break;
			}
			case 'usage': {
				const usages = await this.retrieveUsages(
					query,
					k,
					filterClause,
					explain,
				);
				groups.usages = usages;
				break;
			}
			default: {
				// Fallback: treat as concept
				const [files, defs, blocks] = await Promise.all([
					this.retrieveFiles(
						query,
						queryVector,
						Math.max(5, Math.round(k / 3)),
						filterClause,
						explain,
					),
					this.retrieveDefinitions(
						query,
						queryVector,
						Math.max(10, Math.round(k / 2)),
						filterClause,
						explain,
					),
					this.retrieveBlocks(
						query,
						queryVector,
						Math.max(10, Math.round(k / 2)),
						filterClause,
						explain,
					),
				]);
				groups.files = files;
				groups.definitions = defs;
				groups.blocks = blocks;
			}
		}

		const suggested_next_actions = buildNextActions(groups);

		return {
			intent_used,
			filters_applied: scope,
			groups,
			suggested_next_actions,
		};
	}

	async getSymbol(symbol_id: string): Promise<Record<string, unknown> | null> {
		await this.ensureInitialized();
		const table = await this.getSymbolsTable();
		const rows = await table
			.query()
			.where(`symbol_id = '${escapeForEquality(symbol_id)}'`)
			.select([
				'symbol_id',
				'repo_id',
				'revision',
				'file_path',
				'extension',
				'language_hint',
				'start_line',
				'end_line',
				'symbol_kind',
				'symbol_name',
				'qualname',
				'parent_symbol_id',
				'signature',
				'docstring',
				'is_exported',
				'decorator_names',
				'context_header',
				'code_text',
				'identifiers',
				'identifier_parts',
				'called_names',
				'string_literals',
				'content_hash',
				'file_hash',
			])
			.limit(1)
			.toArray();
		if (rows.length === 0) return null;
		const row = rows[0] as Record<string, unknown>;
		return row;
	}

	async expandContext(args: {
		table: 'symbols' | 'chunks' | 'files';
		id: string;
		limit?: number;
	}): Promise<Record<string, unknown>> {
		await this.ensureInitialized();
		const limit = args.limit ?? 25;

		if (args.table === 'symbols') {
			const symbol = await this.getSymbol(args.id);
			if (!symbol) {
				return {found: false, table: 'symbols', id: args.id};
			}
			const file_path = String(symbol['file_path'] ?? '');
			const [neighbors, chunks] = await Promise.all([
				this.getSymbolsInFile(file_path, limit),
				this.getChunksForSymbol(args.id, limit),
			]);
			return {
				found: true,
				table: 'symbols',
				symbol,
				neighbors,
				chunks,
			};
		}

		if (args.table === 'chunks') {
			const table = await this.getChunksTable();
			const rows = await table
				.query()
				.where(`chunk_id = '${escapeForEquality(args.id)}'`)
				.select([
					'chunk_id',
					'repo_id',
					'revision',
					'file_path',
					'extension',
					'start_line',
					'end_line',
					'owner_symbol_id',
					'chunk_kind',
					'context_header',
					'code_text',
					'identifiers',
					'identifier_parts',
					'called_names',
					'string_literals',
					'content_hash',
					'file_hash',
				])
				.limit(1)
				.toArray();
			if (rows.length === 0) {
				return {found: false, table: 'chunks', id: args.id};
			}
			const chunk = rows[0] as Record<string, unknown>;
			const owner = chunk['owner_symbol_id']
				? String(chunk['owner_symbol_id'])
				: null;
			const file_path = String(chunk['file_path'] ?? '');
			const [neighbors, ownerSymbol, siblingChunks] = await Promise.all([
				this.getSymbolsInFile(file_path, limit),
				owner ? this.getSymbol(owner) : Promise.resolve(null),
				owner ? this.getChunksForSymbol(owner, limit) : Promise.resolve([]),
			]);
			return {
				found: true,
				table: 'chunks',
				chunk,
				owner_symbol: ownerSymbol,
				neighbors,
				sibling_chunks: siblingChunks,
			};
		}

		if (args.table === 'files') {
			const file = await this.getFile(args.id);
			if (!file) {
				return {found: false, table: 'files', id: args.id};
			}
			const file_path = String(file['file_path'] ?? '');
			const neighbors = await this.getSymbolsInFile(file_path, limit);
			return {
				found: true,
				table: 'files',
				file,
				neighbors,
			};
		}

		return {found: false, table: args.table, id: args.id};
	}

	async findUsages(
		options: V2FindUsagesOptions,
	): Promise<V2FindUsagesResponse> {
		await this.ensureInitialized();
		const k = options.k ?? 200;
		const scope = options.scope ?? {};
		const filterClause = buildScopeFilter(scope);

		const resolvedSymbolId = options.symbol_id?.trim() || undefined;
		let resolvedSymbolName = options.symbol_name?.trim() || '';

		if (resolvedSymbolId) {
			const symbolRow = await this.resolveSymbolNameFromId(resolvedSymbolId);
			if (symbolRow?.symbol_name) {
				resolvedSymbolName = symbolRow.symbol_name;
			}
		}

		if (!resolvedSymbolName) {
			throw new Error('findUsages requires symbol_id or symbol_name');
		}

		const refsTable = await this.getRefsTable();
		await ensureFtsIndex(refsTable, 'token_text', {
			baseTokenizer: 'whitespace',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 128,
			withPosition: false,
		});

		const oversample = Math.min(5000, Math.max(k * 12, 200));
		const candidates = await this.ftsCandidatesRefs(
			refsTable,
			resolvedSymbolName,
			'token_text',
			oversample,
			filterClause,
			'refs.token_text',
		);

		const reranked = rerankCandidates(candidates, {
			intent: 'usage',
			explain: true,
			applyExportBoost: false,
			applyTestDemotion: true,
			applyDiversity: true,
		});

		const needle = resolvedSymbolName.toLowerCase();
		const exact = reranked.filter(
			r => (r.token_text ?? '').toLowerCase() === needle,
		);
		const chosen = exact.length > 0 ? exact : reranked;
		const limited = chosen.slice(0, k);

		const byFile = new Map<string, V2UsageRef[]>();
		for (const hit of limited) {
			const key = hit.file_path;
			const list = byFile.get(key) ?? [];
			list.push({
				ref_id: hit.id,
				file_path: hit.file_path,
				start_line: hit.start_line,
				end_line: hit.end_line,
				ref_kind:
					(hit.ref_kind as V2UsageRef['ref_kind']) ??
					('identifier' as V2UsageRef['ref_kind']),
				token_text: hit.token_text ?? resolvedSymbolName,
				context_snippet: hit.snippet,
				score: Number(hit.score.toFixed(8)),
				why: {
					channels: hit.channels.map(ch => ({
						...ch,
						rawScore: Number(ch.rawScore.toFixed(8)),
					})),
					priors: hit.priors,
				},
				module_name: hit.module_name ?? null,
				imported_name: hit.imported_name ?? null,
			});
			byFile.set(key, list);
		}

		const grouped = [...byFile.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([file_path, refs]) => ({
				file_path,
				refs: refs.sort((a, b) => a.start_line - b.start_line),
			}));

		const suggested_next_actions: V2NextAction[] = [];
		const first = grouped[0]?.refs[0];
		if (first) {
			suggested_next_actions.push({
				tool: 'open_span',
				args: {
					file_path: first.file_path,
					start_line: first.start_line,
					end_line: first.end_line,
				},
			});
		}

		return {
			query: {symbol_id: options.symbol_id, symbol_name: options.symbol_name},
			resolved: {
				...(resolvedSymbolId ? {symbol_id: resolvedSymbolId} : {}),
				symbol_name: resolvedSymbolName,
			},
			filters_applied: scope,
			by_file: grouped,
			total_refs: grouped.reduce((sum, g) => sum + g.refs.length, 0),
			suggested_next_actions,
		};
	}

	async getFile(file_id: string): Promise<Record<string, unknown> | null> {
		await this.ensureInitialized();
		const table = await this.getFilesTable();
		const rows = await table
			.query()
			.where(`file_id = '${escapeForEquality(file_id)}'`)
			.select([
				'file_id',
				'repo_id',
				'revision',
				'file_path',
				'extension',
				'file_hash',
				'imports',
				'exports',
				'top_level_doc',
				'file_summary_text',
			])
			.limit(1)
			.toArray();
		if (rows.length === 0) return null;
		return rows[0] as Record<string, unknown>;
	}

	async getSymbolsInFile(file_path: string, limit: number): Promise<unknown[]> {
		const table = await this.getSymbolsTable();
		return table
			.query()
			.where(`file_path = '${escapeForEquality(file_path)}'`)
			.select([
				'symbol_id',
				'file_path',
				'start_line',
				'end_line',
				'symbol_kind',
				'symbol_name',
				'qualname',
				'is_exported',
				'signature',
				'docstring',
			])
			.limit(limit)
			.toArray();
	}

	async getChunksForSymbol(
		symbol_id: string,
		limit: number,
	): Promise<unknown[]> {
		const table = await this.getChunksTable();
		return table
			.query()
			.where(`owner_symbol_id = '${escapeForEquality(symbol_id)}'`)
			.select([
				'chunk_id',
				'file_path',
				'start_line',
				'end_line',
				'chunk_kind',
				'context_header',
				'code_text',
				'identifiers',
				'called_names',
			])
			.limit(limit)
			.toArray();
	}

	private async retrieveDefinitions(
		query: string,
		queryVector: number[],
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const table = await this.getSymbolsTable();
		await ensureFtsIndex(table, 'symbol_name', {
			baseTokenizer: 'ngram',
			ngramMinLength: 2,
			ngramMaxLength: 8,
			prefixOnly: true,
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 64,
			withPosition: false,
		});
		await ensureFtsIndex(table, 'qualname', {
			baseTokenizer: 'ngram',
			ngramMinLength: 2,
			ngramMaxLength: 12,
			prefixOnly: true,
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 128,
			withPosition: false,
		});
		await ensureFtsIndex(table, 'identifiers_text', {
			baseTokenizer: 'whitespace',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 128,
			withPosition: false,
		});
		await ensureFtsIndex(table, 'search_text', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: false,
		});

		const oversample = Math.min(200, Math.max(k * 6, 30));
		const [nameHits, qualHits, identHits, vecHits] = await Promise.all([
			this.ftsCandidatesSymbols(
				table,
				query,
				'symbol_name',
				oversample,
				filterClause,
				'symbols.name',
			),
			this.ftsCandidatesSymbols(
				table,
				query,
				'qualname',
				oversample,
				filterClause,
				'symbols.qualname',
			),
			this.ftsCandidatesSymbols(
				table,
				query,
				'identifiers_text',
				oversample,
				filterClause,
				'symbols.identifiers',
			),
			this.vectorCandidatesSymbols(
				table,
				queryVector,
				oversample,
				filterClause,
				'symbols.vec_summary',
			),
		]);

		const candidates = mergeCandidates([
			nameHits,
			qualHits,
			identHits,
			vecHits,
		]);
		const reranked = rerankCandidates(candidates, {
			intent: 'definition',
			explain,
			applyExportBoost: true,
			applyTestDemotion: true,
			applyDiversity: true,
		});

		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveFiles(
		query: string,
		queryVector: number[],
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const table = await this.getFilesTable();
		await ensureFtsIndex(table, 'file_summary_text', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: false,
		});

		const oversample = Math.min(150, Math.max(k * 5, 20));
		const [ftsHits, vecHits] = await Promise.all([
			this.ftsCandidatesFiles(
				table,
				query,
				'file_summary_text',
				oversample,
				filterClause,
				'files.fts',
			),
			this.vectorCandidatesFiles(
				table,
				queryVector,
				oversample,
				filterClause,
				'files.vec_file',
			),
		]);

		const candidates = mergeCandidates([ftsHits, vecHits]);
		const reranked = rerankCandidates(candidates, {
			intent: 'concept',
			explain,
			applyExportBoost: false,
			applyTestDemotion: true,
			applyDiversity: true,
		});

		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveBlocks(
		query: string,
		queryVector: number[],
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const table = await this.getChunksTable();
		await ensureFtsIndex(table, 'identifiers_text', {
			baseTokenizer: 'whitespace',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 128,
			withPosition: false,
		});
		await ensureFtsIndex(table, 'search_text', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: false,
		});

		const oversample = Math.min(200, Math.max(k * 6, 30));
		const [identHits, searchHits, vecHits] = await Promise.all([
			this.ftsCandidatesChunks(
				table,
				query,
				'identifiers_text',
				oversample,
				filterClause,
				'chunks.identifiers',
			),
			this.ftsCandidatesChunks(
				table,
				query,
				'search_text',
				oversample,
				filterClause,
				'chunks.search_text',
			),
			this.vectorCandidatesChunks(
				table,
				queryVector,
				oversample,
				filterClause,
				'chunks.vec_code',
			),
		]);

		const candidates = mergeCandidates([identHits, searchHits, vecHits]);
		const reranked = rerankCandidates(candidates, {
			intent: 'concept',
			explain,
			applyExportBoost: false,
			applyTestDemotion: true,
			applyDiversity: true,
		});

		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveExactText(
		query: string,
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const table = await this.getChunksTable();
		await ensureFtsIndex(table, 'code_text', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: true,
		});

		const oversample = Math.min(200, Math.max(k * 8, 40));
		const ftsHits = await this.ftsCandidatesChunks(
			table,
			query,
			'code_text',
			oversample,
			filterClause,
			'chunks.code_text',
		);

		const reranked = rerankCandidates(ftsHits, {
			intent: 'exact_text',
			explain,
			applyExportBoost: false,
			applyTestDemotion: false,
			applyDiversity: true,
		});

		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveSimilarCode(
		queryVector: number[],
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const table = await this.getChunksTable();
		const oversample = Math.min(200, Math.max(k * 6, 30));
		const vecHits = await this.vectorCandidatesChunks(
			table,
			queryVector,
			oversample,
			filterClause,
			'chunks.vec_code',
		);

		const reranked = rerankCandidates(vecHits, {
			intent: 'similar_code',
			explain,
			applyExportBoost: false,
			applyTestDemotion: true,
			applyDiversity: true,
		});
		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveUsages(
		query: string,
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const token = extractUsageToken(query);
		if (!token) return [];

		const table = await this.getRefsTable();
		await ensureFtsIndex(table, 'token_text', {
			baseTokenizer: 'whitespace',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 128,
			withPosition: false,
		});

		const oversample = Math.min(1000, Math.max(k * 12, 100));
		const ftsHits = await this.ftsCandidatesRefs(
			table,
			token,
			'token_text',
			oversample,
			filterClause,
			'refs.token_text',
		);

		const reranked = rerankCandidates(ftsHits, {
			intent: 'usage',
			explain,
			applyExportBoost: false,
			applyTestDemotion: true,
			applyDiversity: true,
		});

		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async ftsCandidatesSymbols(
		table: Table,
		query: string,
		column: string,
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.search(query, 'fts', column).limit(limit);
		if (filterClause) q = q.where(filterClause);
		const rows = await q.toArray();
		return rows.map((row, index) => {
			const r = row as Record<string, unknown> & {_score?: number};
			return {
				table: 'symbols',
				id: String(r['symbol_id']),
				file_path: String(r['file_path']),
				start_line: Number(r['start_line']),
				end_line: Number(r['end_line']),
				title: String(r['qualname'] ?? r['symbol_name'] ?? r['symbol_id']),
				snippet:
					String(r['signature'] ?? '').trim() ||
					String(r['code_text'] ?? '').slice(0, 200),
				is_exported: Boolean(r['is_exported']),
				channels: [
					{
						channel: 'fts',
						source,
						rank: index,
						rawScore: typeof r._score === 'number' ? r._score : 0,
					},
				],
			};
		});
	}

	private async ftsCandidatesChunks(
		table: Table,
		query: string,
		column: string,
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.search(query, 'fts', column).limit(limit);
		if (filterClause) q = q.where(filterClause);
		const rows = await q.toArray();
		return rows.map((row, index) => {
			const r = row as Record<string, unknown> & {_score?: number};
			return {
				table: 'chunks',
				id: String(r['chunk_id']),
				file_path: String(r['file_path']),
				start_line: Number(r['start_line']),
				end_line: Number(r['end_line']),
				title: `${r['chunk_kind'] ?? 'block'}`,
				snippet: String(r['code_text'] ?? '').slice(0, 240),
				channels: [
					{
						channel: 'fts',
						source,
						rank: index,
						rawScore: typeof r._score === 'number' ? r._score : 0,
					},
				],
			};
		});
	}

	private async ftsCandidatesFiles(
		table: Table,
		query: string,
		column: string,
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.search(query, 'fts', column).limit(limit);
		if (filterClause) q = q.where(filterClause);
		const rows = await q.toArray();
		return rows.map((row, index) => {
			const r = row as Record<string, unknown> & {_score?: number};
			const summary = String(r['file_summary_text'] ?? '');
			return {
				table: 'files',
				id: String(r['file_id']),
				file_path: String(r['file_path']),
				start_line: 1,
				end_line: 1,
				title: String(r['file_path']),
				snippet: summary.slice(0, 240),
				channels: [
					{
						channel: 'fts',
						source,
						rank: index,
						rawScore: typeof r._score === 'number' ? r._score : 0,
					},
				],
			};
		});
	}

	private async ftsCandidatesRefs(
		table: Table,
		query: string,
		column: string,
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.search(query, 'fts', column).limit(limit);
		if (filterClause) q = q.where(filterClause);
		const rows = await q.toArray();
		return rows.map((row, index) => {
			const r = row as Record<string, unknown> & {_score?: number};
			const refKind = String(r['ref_kind'] ?? 'identifier');
			const tokenText = String(r['token_text'] ?? '');
			return {
				table: 'refs',
				id: String(r['ref_id']),
				file_path: String(r['file_path']),
				start_line: Number(r['start_line']),
				end_line: Number(r['end_line']),
				title: `${refKind}: ${tokenText}`,
				snippet: String(r['context_snippet'] ?? '').slice(0, 240),
				ref_kind: refKind,
				token_text: tokenText,
				module_name: r['module_name'] != null ? String(r['module_name']) : null,
				imported_name:
					r['imported_name'] != null ? String(r['imported_name']) : null,
				channels: [
					{
						channel: 'fts',
						source,
						rank: index,
						rawScore: typeof r._score === 'number' ? r._score : 0,
					},
				],
			};
		});
	}

	private async vectorCandidatesSymbols(
		table: Table,
		queryVector: number[],
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.vectorSearch(queryVector).column('vec_summary').limit(limit);
		if (filterClause) q = q.where(filterClause);
		const rows = await q.toArray();
		return rows.map((row: unknown, index: number) => {
			const r = row as Record<string, unknown> & {_distance?: number};
			const distance = typeof r._distance === 'number' ? r._distance : 0;
			const sim = 1 / (1 + distance);
			return {
				table: 'symbols',
				id: String(r['symbol_id']),
				file_path: String(r['file_path']),
				start_line: Number(r['start_line']),
				end_line: Number(r['end_line']),
				title: String(r['qualname'] ?? r['symbol_name'] ?? r['symbol_id']),
				snippet:
					String(r['signature'] ?? '').trim() ||
					String(r['code_text'] ?? '').slice(0, 200),
				is_exported: Boolean(r['is_exported']),
				channels: [{channel: 'vector', source, rank: index, rawScore: sim}],
			};
		});
	}

	private async vectorCandidatesChunks(
		table: Table,
		queryVector: number[],
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.vectorSearch(queryVector).column('vec_code').limit(limit);
		if (filterClause) q = q.where(filterClause);
		const rows = await q.toArray();
		return rows.map((row: unknown, index: number) => {
			const r = row as Record<string, unknown> & {_distance?: number};
			const distance = typeof r._distance === 'number' ? r._distance : 0;
			const sim = 1 / (1 + distance);
			return {
				table: 'chunks',
				id: String(r['chunk_id']),
				file_path: String(r['file_path']),
				start_line: Number(r['start_line']),
				end_line: Number(r['end_line']),
				title: `${r['chunk_kind'] ?? 'block'}`,
				snippet: String(r['code_text'] ?? '').slice(0, 240),
				channels: [{channel: 'vector', source, rank: index, rawScore: sim}],
			};
		});
	}

	private async vectorCandidatesFiles(
		table: Table,
		queryVector: number[],
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.vectorSearch(queryVector).column('vec_file').limit(limit);
		if (filterClause) q = q.where(filterClause);
		const rows = await q.toArray();
		return rows.map((row: unknown, index: number) => {
			const r = row as Record<string, unknown> & {_distance?: number};
			const distance = typeof r._distance === 'number' ? r._distance : 0;
			const sim = 1 / (1 + distance);
			const summary = String(r['file_summary_text'] ?? '');
			return {
				table: 'files',
				id: String(r['file_id']),
				file_path: String(r['file_path']),
				start_line: 1,
				end_line: 1,
				title: String(r['file_path']),
				snippet: summary.slice(0, 240),
				channels: [{channel: 'vector', source, rank: index, rawScore: sim}],
			};
		});
	}

	private async ensureInitialized(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.doInitialize(signal);
		return this.initPromise;
	}

	private async doInitialize(signal?: AbortSignal): Promise<void> {
		try {
			throwIfAborted(signal, 'Warmup cancelled');
			const config = await loadConfig(this.projectRoot);

			if (!this.storage) {
				this.storage = new StorageV2(
					this.projectRoot,
					config.embeddingDimensions,
				);
				await this.storage.connect();
			}

			this.embeddings = this.createEmbeddingProvider(config);
			await this.embeddings.initialize();

			this.initialized = true;
			this.log('info', 'SearchEngineV2 initialized');
		} catch (error) {
			if (isAbortError(error)) {
				if (!this.externalStorage) {
					this.storage?.close();
				}
				this.storage = null;
				this.embeddings?.close();
				this.embeddings = null;
				this.initialized = false;
			}
			this.initPromise = null;
			throw error;
		}
	}

	private createEmbeddingProvider(config: {
		embeddingProvider: EmbeddingProviderType;
		apiKey?: string;
		openaiBaseUrl?: string;
	}): EmbeddingProvider {
		const apiKey = config.apiKey;
		switch (config.embeddingProvider) {
			case 'local':
				return new LocalEmbeddingProvider();
			case 'gemini':
				return new GeminiEmbeddingProvider(apiKey);
			case 'mistral':
				return new MistralEmbeddingProvider(apiKey);
			case 'openai':
				return new OpenAIEmbeddingProvider(apiKey, config.openaiBaseUrl);
			default:
				throw new Error(
					`Unknown embedding provider: ${config.embeddingProvider}`,
				);
		}
	}

	private async getSymbolsTable(): Promise<Table> {
		return this.storage!.getSymbolsTable();
	}

	private async getChunksTable(): Promise<Table> {
		return this.storage!.getChunksTable();
	}

	private async getFilesTable(): Promise<Table> {
		return this.storage!.getFilesTable();
	}

	private async getRefsTable(): Promise<Table> {
		return this.storage!.getRefsTable();
	}

	private async resolveSymbolNameFromId(symbol_id: string): Promise<{
		symbol_name: string;
	} | null> {
		const table = await this.getSymbolsTable();
		const rows = await table
			.query()
			.where(`symbol_id = '${escapeForEquality(symbol_id)}'`)
			.select(['symbol_name'])
			.limit(1)
			.toArray();
		if (rows.length === 0) return null;
		const row = rows[0] as Record<string, unknown>;
		const symbol_name = String(row['symbol_name'] ?? '').trim();
		if (!symbol_name) return null;
		return {symbol_name};
	}

	private log(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
	): void {
		if (!this.logger) return;
		this.logger[level]('SearchV2', message);
	}

	close(): void {
		if (!this.externalStorage) {
			this.storage?.close();
		}
		this.storage = null;
		this.embeddings?.close();
		this.embeddings = null;
		this.initialized = false;
		this.initPromise = null;
	}
}

function routeIntent(query: string): Exclude<V2SearchIntent, 'auto'> {
	const q = query.trim();
	const lower = q.toLowerCase();

	if (
		lower.startsWith('where used') ||
		lower.startsWith('find usages') ||
		(lower.startsWith('where is') && lower.includes('used'))
	) {
		return 'usage';
	}

	const hasQuote = q.includes('"') || q.includes("'") || q.includes('`');
	if (hasQuote || /error:|exception|traceback/i.test(q)) {
		return 'exact_text';
	}

	const looksLikeCode =
		q.includes('\n') ||
		/[{};]|=>|\b(class|function|def|import|export|return)\b/.test(q);
	if (looksLikeCode) {
		return 'similar_code';
	}

	const symbolish =
		/[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(q) ||
		/[A-Za-z0-9_]+\.[A-Za-z0-9_]+/.test(q) ||
		/[A-Za-z0-9_]+::[A-Za-z0-9_]+/.test(q) ||
		/[A-Z][a-z]+[A-Z][A-Za-z0-9]*/.test(q);

	if (symbolish || lower.includes('defined') || lower.includes('definition')) {
		return 'definition';
	}

	return 'concept';
}

const USAGE_TOKEN_STOP_WORDS = new Set([
	'where',
	'is',
	'are',
	'was',
	'were',
	'used',
	'use',
	'usages',
	'usage',
	'find',
	'calls',
	'call',
	'called',
	'import',
	'imports',
	'imported',
	'references',
	'refs',
	'defined',
	'definition',
	'of',
	'in',
	'on',
	'for',
	'to',
	'the',
	'a',
	'an',
]);

function extractUsageToken(query: string): string | null {
	const q = query.trim();
	if (!q) return null;

	const backtick = q.match(/`([^`]+)`/);
	if (backtick?.[1]) {
		const token = normalizeUsageToken(backtick[1]);
		if (token) return token;
	}

	const quoted = q.match(/["']([^"']+)["']/);
	if (quoted?.[1]) {
		const token = normalizeUsageToken(quoted[1]);
		if (token) return token;
	}

	const tokens =
		q.match(
			/[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|#)[A-Za-z_$][A-Za-z0-9_$]*)*/g,
		) ?? [];
	for (let i = tokens.length - 1; i >= 0; i -= 1) {
		const raw = tokens[i] ?? '';
		if (!raw) continue;
		if (USAGE_TOKEN_STOP_WORDS.has(raw.toLowerCase())) continue;
		const token = normalizeUsageToken(raw);
		if (token) return token;
	}

	return null;
}

function normalizeUsageToken(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const lastNs = trimmed.includes('::') ? trimmed.split('::').pop()! : trimmed;
	const last = lastNs.split(/[.#]/).pop()!.trim();
	if (!last) return null;
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(last)) return null;
	return last;
}

async function ensureFtsIndex(
	table: Table,
	column: string,
	options: Partial<lancedb.FtsOptions>,
): Promise<void> {
	const indices = await table.listIndices();
	const hasIndex = indices.some(
		idx => idx.indexType === 'FTS' && idx.columns.includes(column),
	);
	if (hasIndex) return;
	await table.createIndex(column, {
		config: lancedb.Index.fts({
			withPosition: options.withPosition,
			baseTokenizer: options.baseTokenizer,
			language: options.language,
			maxTokenLength: options.maxTokenLength,
			lowercase: options.lowercase,
			stem: options.stem,
			removeStopWords: options.removeStopWords,
			asciiFolding: options.asciiFolding,
			ngramMinLength: options.ngramMinLength,
			ngramMaxLength: options.ngramMaxLength,
			prefixOnly: options.prefixOnly,
		}),
	});
}

function mergeCandidates(lists: Candidate[][]): Candidate[] {
	const byKey = new Map<string, Candidate>();
	for (const list of lists) {
		for (const cand of list) {
			const key = `${cand.table}:${cand.id}`;
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, cand);
			} else {
				existing.channels.push(...cand.channels);
			}
		}
	}
	return [...byKey.values()];
}

function rerankCandidates(
	candidates: Candidate[],
	options: {
		intent: Exclude<V2SearchIntent, 'auto'>;
		explain: boolean;
		applyExportBoost: boolean;
		applyTestDemotion: boolean;
		applyDiversity: boolean;
	},
): Array<
	Candidate & {
		score: number;
		priors: Array<{name: string; value: number; note: string}>;
	}
> {
	const fileCounts = new Map<string, number>();

	const withScores = candidates.map(c => {
		// RRF across channels (source-specific rank)
		let rrf = 0;
		for (const ch of c.channels) {
			const weight = ch.channel === 'vector' ? 1.0 : 0.9;
			rrf += weight * (1 / (RRF_K + ch.rank + 1));
		}

		const priors: Array<{name: string; value: number; note: string}> = [];
		let score = rrf;

		if (options.applyExportBoost && c.table === 'symbols' && c.is_exported) {
			score *= 1.2;
			priors.push({
				name: 'export_boost',
				value: 1.2,
				note: 'Boost exported/public symbols',
			});
		}

		if (options.intent === 'usage' && c.table === 'refs') {
			const kind = c.ref_kind ?? 'identifier';
			const kindWeight =
				kind === 'call'
					? 1.15
					: kind === 'import'
						? 1.1
						: kind === 'string_literal'
							? 0.75
							: 1.0;
			if (kindWeight !== 1.0) {
				score *= kindWeight;
				priors.push({
					name: 'ref_kind_prior',
					value: kindWeight,
					note: `Soft-prioritize ${kind} refs`,
				});
			}
		}

		if (options.applyTestDemotion) {
			const lowerPath = c.file_path.toLowerCase();
			const isTestish =
				lowerPath.includes('__tests__') ||
				lowerPath.includes('/test/') ||
				lowerPath.includes('.spec.') ||
				lowerPath.includes('.test.');
			if (isTestish) {
				score *= 0.6;
				priors.push({
					name: 'test_path_demotion',
					value: 0.6,
					note: 'Soft-demote test-ish paths',
				});
			}
		}

		if (options.applyDiversity) {
			const count = fileCounts.get(c.file_path) ?? 0;
			fileCounts.set(c.file_path, count + 1);
			if (count > 0) {
				const penalty = 1 / (1 + count * 0.25);
				score *= penalty;
				priors.push({
					name: 'diversity_penalty',
					value: penalty,
					note: 'Soft-diversify by file',
				});
			}
		}

		return {...c, score, priors};
	});

	return withScores.sort((a, b) => b.score - a.score);
}

function toHit(
	candidate: Candidate & {
		score: number;
		priors: Array<{name: string; value: number; note: string}>;
	},
	explain: boolean,
): V2HitBase {
	return {
		table: candidate.table,
		id: candidate.id,
		file_path: candidate.file_path,
		start_line: candidate.start_line,
		end_line: candidate.end_line,
		title: candidate.title,
		snippet: candidate.snippet,
		score: Number(candidate.score.toFixed(8)),
		...(explain
			? {
					why: {
						channels: candidate.channels.map(ch => ({
							...ch,
							rawScore: Number(ch.rawScore.toFixed(8)),
						})),
						priors: candidate.priors,
					},
				}
			: {}),
	};
}

function buildNextActions(groups: {
	definitions: V2HitBase[];
	files: V2HitBase[];
	blocks: V2HitBase[];
	usages: V2HitBase[];
}): V2NextAction[] {
	const actions: V2NextAction[] = [];
	const firstDef = groups.definitions[0];
	if (firstDef && firstDef.table === 'symbols') {
		actions.push({tool: 'get_symbol', args: {symbol_id: firstDef.id}});
		actions.push({tool: 'find_usages', args: {symbol_id: firstDef.id}});
		actions.push({
			tool: 'open_span',
			args: {
				file_path: firstDef.file_path,
				start_line: firstDef.start_line,
				end_line: firstDef.end_line,
			},
		});
		actions.push({
			tool: 'expand_context',
			args: {table: 'symbols', id: firstDef.id},
		});
	}

	const firstUsage = groups.usages[0];
	if (firstUsage) {
		actions.push({
			tool: 'open_span',
			args: {
				file_path: firstUsage.file_path,
				start_line: firstUsage.start_line,
				end_line: firstUsage.end_line,
			},
		});
	}

	const firstBlock = groups.blocks[0];
	if (firstBlock) {
		actions.push({
			tool: 'open_span',
			args: {
				file_path: firstBlock.file_path,
				start_line: firstBlock.start_line,
				end_line: firstBlock.end_line,
			},
		});
		actions.push({
			tool: 'expand_context',
			args: {table: firstBlock.table, id: firstBlock.id},
		});
	}
	return actions.slice(0, 5);
}

function buildScopeFilter(scope: V2SearchScope): string | undefined {
	const conditions: string[] = [];

	if (scope.path_prefix && scope.path_prefix.length > 0) {
		const parts = scope.path_prefix.map(
			p => `file_path LIKE '${escapeForLike(p)}%'`,
		);
		conditions.push(`(${parts.join(' OR ')})`);
	}

	if (scope.path_contains && scope.path_contains.length > 0) {
		for (const str of scope.path_contains) {
			conditions.push(`file_path LIKE '%${escapeForLike(str)}%'`);
		}
	}

	if (scope.path_not_contains && scope.path_not_contains.length > 0) {
		for (const str of scope.path_not_contains) {
			conditions.push(`file_path NOT LIKE '%${escapeForLike(str)}%'`);
		}
	}

	if (scope.extension && scope.extension.length > 0) {
		const exts = scope.extension
			.map(e => `'${escapeForEquality(e)}'`)
			.join(', ');
		conditions.push(`extension IN (${exts})`);
	}

	if (conditions.length === 0) return undefined;
	return conditions.join(' AND ');
}

function escapeForEquality(str: string): string {
	return str.replace(/'/g, "''");
}

function escapeForLike(str: string): string {
	return str.replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_');
}
