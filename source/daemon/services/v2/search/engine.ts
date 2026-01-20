/**
 * V2 SearchEngine - intent routed retrieval over v2 tables.
 *
 * The goal is high-recall, agent-friendly results with explainability and
 * stable follow-up handles.
 */

import * as lancedb from '@lancedb/lancedb';
import type {Table} from '@lancedb/lancedb';
import {
	loadConfig,
	type EmbeddingProviderType,
	type ViberagConfig,
} from '../../../lib/config.js';
import type {Logger} from '../../../lib/logger.js';
import {isAbortError, throwIfAborted} from '../../../lib/abort.js';
import {GeminiEmbeddingProvider} from '../../../providers/gemini.js';
import {LocalEmbeddingProvider} from '../../../providers/local.js';
import {MistralEmbeddingProvider} from '../../../providers/mistral.js';
import {OpenAIEmbeddingProvider} from '../../../providers/openai.js';
import type {EmbeddingProvider} from '../../../providers/types.js';
import {StorageV2} from '../storage/index.js';
import {
	checkV2IndexCompatibility,
	V2ReindexRequiredError,
	V2_SCHEMA_VERSION,
} from '../manifest.js';
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
	V2SearchWarning,
} from './types.js';

const DEFAULT_K = 20;
const RRF_K = 60;

export type SearchEngineV2Options = {
	logger?: Logger;
	storage?: StorageV2;
	embeddings?: EmbeddingProvider;
};

type Candidate = {
	table: 'symbols' | 'chunks' | 'files' | 'refs';
	id: string;
	file_path: string;
	start_line: number;
	end_line: number;
	start_byte?: number | null;
	end_byte?: number | null;
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
	private config: ViberagConfig | null = null;
	private storage: StorageV2 | null = null;
	private embeddings: EmbeddingProvider | null = null;
	private embeddingsInitPromise: Promise<void> | null = null;
	private logger: Logger | null = null;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private readonly externalStorage: boolean;
	private readonly externalEmbeddings: boolean;

	constructor(projectRoot: string, options?: SearchEngineV2Options | Logger) {
		this.projectRoot = projectRoot;

		if (
			options &&
			typeof options === 'object' &&
			('logger' in options || 'storage' in options || 'embeddings' in options)
		) {
			const typed = options as SearchEngineV2Options;
			this.logger = typed.logger ?? null;
			if (typed.storage) {
				this.storage = typed.storage;
				this.externalStorage = true;
			} else {
				this.externalStorage = false;
			}
			if (typed.embeddings) {
				this.embeddings = typed.embeddings;
				this.externalEmbeddings = true;
			} else {
				this.externalEmbeddings = false;
			}
		} else {
			this.logger = (options as Logger | undefined) ?? null;
			this.externalStorage = false;
			this.externalEmbeddings = false;
		}
	}

	async warmup(signal?: AbortSignal): Promise<void> {
		await this.ensureInitialized(signal);
		try {
			await this.ensureEmbeddingsInitialized(signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log('warn', `Embeddings warmup failed: ${message}`);
		}
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
		await this.ensureIndexCompatible();
		const filterClause = buildScopeFilter(scope);

		const warnings: V2SearchWarning[] = [];
		const needsVector =
			intent_used === 'definition' ||
			intent_used === 'concept' ||
			intent_used === 'similar_code';
		const {vector: queryVector, warning} = needsVector
			? await this.tryEmbedQuery(query)
			: {vector: null, warning: null};
		if (warning) {
			warnings.push(warning);
		}

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
					query,
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
			...(warnings.length > 0 ? {warnings} : {}),
			groups,
			suggested_next_actions,
		};
	}

	async getSymbol(symbol_id: string): Promise<Record<string, unknown> | null> {
		await this.ensureInitialized();
		await this.ensureIndexCompatible();
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
		return normalizeJsonRecord(row);
	}

	async expandContext(args: {
		table: 'symbols' | 'chunks' | 'files';
		id: string;
		limit?: number;
	}): Promise<Record<string, unknown>> {
		await this.ensureInitialized();
		await this.ensureIndexCompatible();
		const limit = args.limit ?? 25;

		if (args.table === 'symbols') {
			const symbol = await this.getSymbol(args.id);
			if (!symbol) {
				return {found: false, table: 'symbols', id: args.id};
			}
			const file_path = String(symbol['file_path'] ?? '');
			const [file, neighbors, chunks] = await Promise.all([
				this.getFileByPath(file_path),
				this.getSymbolsInFile(file_path, limit),
				this.getChunksForSymbol(args.id, limit),
			]);
			return {
				found: true,
				table: 'symbols',
				symbol,
				file,
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
			const chunk = normalizeJsonRecord(rows[0] as Record<string, unknown>);
			const owner = chunk['owner_symbol_id']
				? String(chunk['owner_symbol_id'])
				: null;
			const file_path = String(chunk['file_path'] ?? '');
			const [file, neighbors, ownerSymbol, siblingChunks] = await Promise.all([
				this.getFileByPath(file_path),
				this.getSymbolsInFile(file_path, limit),
				owner ? this.getSymbol(owner) : Promise.resolve(null),
				owner ? this.getChunksForSymbol(owner, limit) : Promise.resolve([]),
			]);
			return {
				found: true,
				table: 'chunks',
				chunk,
				owner_symbol: ownerSymbol,
				file,
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
		await this.ensureIndexCompatible();
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
		await ensureFtsIndex(refsTable, 'token_texts', {
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
			'token_texts',
			oversample,
			filterClause,
			'refs.token_texts',
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
				tool: 'read_file_lines',
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
		return normalizeJsonRecord(rows[0] as Record<string, unknown>);
	}

	private async getFileByPath(
		file_path: string,
	): Promise<Record<string, unknown> | null> {
		if (!file_path) return null;
		const table = await this.getFilesTable();
		const rows = await table
			.query()
			.where(`file_path = '${escapeForEquality(file_path)}'`)
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
		return normalizeJsonRecord(rows[0] as Record<string, unknown>);
	}

	async getSymbolsInFile(file_path: string, limit: number): Promise<unknown[]> {
		const table = await this.getSymbolsTable();
		const rows = await table
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
		return rows
			.map(r => normalizeJsonRecord(r as Record<string, unknown>))
			.sort(
				(a, b) => Number(a['start_line'] ?? 0) - Number(b['start_line'] ?? 0),
			);
	}

	async getChunksForSymbol(
		symbol_id: string,
		limit: number,
	): Promise<unknown[]> {
		const table = await this.getChunksTable();
		const rows = await table
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
		return rows
			.map(r => normalizeJsonRecord(r as Record<string, unknown>))
			.sort(
				(a, b) => Number(a['start_line'] ?? 0) - Number(b['start_line'] ?? 0),
			);
	}

	private async retrieveDefinitions(
		query: string,
		queryVector: number[] | null,
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const table = await this.getSymbolsTable();
		const fuzzyPlan = buildDefinitionFuzzyPlan(query);
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
		if (fuzzyPlan) {
			await ensureFtsIndex(table, 'symbol_name_fuzzy', {
				baseTokenizer: 'whitespace',
				lowercase: true,
				stem: false,
				removeStopWords: false,
				maxTokenLength: 128,
				withPosition: false,
			});
			await ensureFtsIndex(table, 'qualname_fuzzy', {
				baseTokenizer: 'whitespace',
				lowercase: true,
				stem: false,
				removeStopWords: false,
				maxTokenLength: 256,
				withPosition: false,
			});
		}

		const oversample = Math.min(200, Math.max(k * 6, 30));
		const fuzzySymbolToken = fuzzyPlan
			? fuzzyPlan.symbolToken.toLowerCase()
			: '';
		const fuzzyQualToken = fuzzyPlan?.qualToken
			? fuzzyPlan.qualToken.toLowerCase()
			: null;
		const [
			nameHits,
			qualHits,
			nameFuzzyHits,
			qualFuzzyHits,
			identHits,
			vecHits,
		] = await Promise.all([
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
			fuzzyPlan
				? this.ftsCandidatesSymbolsFullTextQuery(
						table,
						new lancedb.MatchQuery(fuzzySymbolToken, 'symbol_name_fuzzy', {
							fuzziness: fuzzyPlan.fuzziness,
							maxExpansions: fuzzyPlan.maxExpansions,
							prefixLength: fuzzyPlan.prefixLength,
						}),
						oversample,
						filterClause,
						'symbols.name_fuzzy',
					)
				: Promise.resolve([]),
			fuzzyPlan && fuzzyQualToken
				? this.ftsCandidatesSymbolsFullTextQuery(
						table,
						new lancedb.MatchQuery(fuzzyQualToken, 'qualname_fuzzy', {
							fuzziness: fuzzyPlan.fuzziness,
							maxExpansions: fuzzyPlan.maxExpansions,
							prefixLength: fuzzyPlan.prefixLength,
						}),
						oversample,
						filterClause,
						'symbols.qualname_fuzzy',
					)
				: Promise.resolve([]),
			this.ftsCandidatesSymbols(
				table,
				query,
				'identifiers_text',
				oversample,
				filterClause,
				'symbols.identifiers',
			),
			queryVector
				? this.vectorCandidatesSymbols(
						table,
						queryVector,
						oversample,
						filterClause,
						'symbols.vec_summary',
					)
				: Promise.resolve([]),
		]);

		const candidates = mergeCandidates([
			nameHits,
			qualHits,
			nameFuzzyHits,
			qualFuzzyHits,
			identHits,
			vecHits,
		]);
		const reranked = rerankCandidates(candidates, {
			intent: 'definition',
			explain,
			applyExportBoost: true,
			applyTestDemotion: true,
			applyDiversity: true,
			query,
			applyLexicalOverlap: true,
		});

		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveFiles(
		query: string,
		queryVector: number[] | null,
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
			queryVector
				? this.vectorCandidatesFiles(
						table,
						queryVector,
						oversample,
						filterClause,
						'files.vec_file',
					)
				: Promise.resolve([]),
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
		queryVector: number[] | null,
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
			queryVector
				? this.vectorCandidatesChunks(
						table,
						queryVector,
						oversample,
						filterClause,
						'chunks.vec_code',
					)
				: Promise.resolve([]),
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
		const [chunksTable, symbolsTable] = await Promise.all([
			this.getChunksTable(),
			this.getSymbolsTable(),
		]);
		await ensureFtsIndex(chunksTable, 'string_literals', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: true,
		});
		await ensureFtsIndex(symbolsTable, 'string_literals', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: true,
		});
		await ensureFtsIndex(chunksTable, 'code_text', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: true,
		});
		await ensureFtsIndex(symbolsTable, 'code_text', {
			baseTokenizer: 'simple',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 256,
			withPosition: true,
		});

		const oversample = Math.min(200, Math.max(k * 8, 40));
		const [chunkStringHits, symbolStringHits, chunkHits, symbolHits] =
			await Promise.all([
				this.ftsCandidatesChunks(
					chunksTable,
					query,
					'string_literals',
					oversample,
					filterClause,
					'chunks.string_literals',
				),
				this.ftsCandidatesSymbols(
					symbolsTable,
					query,
					'string_literals',
					oversample,
					filterClause,
					'symbols.string_literals',
				),
				this.ftsCandidatesChunks(
					chunksTable,
					query,
					'code_text',
					oversample,
					filterClause,
					'chunks.code_text',
				),
				this.ftsCandidatesSymbols(
					symbolsTable,
					query,
					'code_text',
					oversample,
					filterClause,
					'symbols.code_text',
				),
			]);

		const candidates = mergeCandidates([
			chunkStringHits,
			symbolStringHits,
			chunkHits,
			symbolHits,
		]);
		const reranked = rerankCandidates(candidates, {
			intent: 'exact_text',
			explain,
			applyExportBoost: false,
			applyTestDemotion: false,
			applyDiversity: true,
		});

		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveSimilarCode(
		query: string,
		queryVector: number[] | null,
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const oversample = Math.min(200, Math.max(k * 6, 30));

		let candidates: Candidate[] = [];

		if (queryVector) {
			const [chunkHits, symbolHits] = await Promise.all([
				this.vectorCandidatesChunks(
					await this.getChunksTable(),
					queryVector,
					oversample,
					filterClause,
					'chunks.vec_code',
				),
				this.vectorCandidatesSymbols(
					await this.getSymbolsTable(),
					queryVector,
					oversample,
					filterClause,
					'symbols.vec_summary',
				),
			]);
			candidates = mergeCandidates([chunkHits, symbolHits]);
		} else {
			// Vector unavailable: fall back to lexical recall over search_text.
			const fallbackQuery = buildFtsQueryFromCode(query);
			if (!fallbackQuery) return [];

			const [chunksTable, symbolsTable] = await Promise.all([
				this.getChunksTable(),
				this.getSymbolsTable(),
			]);
			await ensureFtsIndex(chunksTable, 'search_text', {
				baseTokenizer: 'simple',
				lowercase: true,
				stem: false,
				removeStopWords: false,
				maxTokenLength: 256,
				withPosition: false,
			});
			await ensureFtsIndex(symbolsTable, 'search_text', {
				baseTokenizer: 'simple',
				lowercase: true,
				stem: false,
				removeStopWords: false,
				maxTokenLength: 256,
				withPosition: false,
			});

			const [chunkHits, symbolHits] = await Promise.all([
				this.ftsCandidatesChunks(
					chunksTable,
					fallbackQuery,
					'search_text',
					oversample,
					filterClause,
					'chunks.search_text',
				),
				this.ftsCandidatesSymbols(
					symbolsTable,
					fallbackQuery,
					'search_text',
					oversample,
					filterClause,
					'symbols.search_text',
				),
			]);

			candidates = mergeCandidates([chunkHits, symbolHits]);
		}

		const reranked = rerankCandidates(candidates, {
			intent: 'similar_code',
			explain,
			applyExportBoost: false,
			applyTestDemotion: true,
			applyDiversity: true,
			query,
			applyLexicalOverlap: true,
		});
		return reranked.slice(0, k).map(c => toHit(c, explain));
	}

	private async retrieveUsages(
		query: string,
		k: number,
		filterClause: string | undefined,
		explain: boolean,
	): Promise<V2HitBase[]> {
		const tokens = extractUsageTokens(query);
		if (!tokens) return [];

		const table = await this.getRefsTable();
		await ensureFtsIndex(table, 'token_texts', {
			baseTokenizer: 'whitespace',
			lowercase: true,
			stem: false,
			removeStopWords: false,
			maxTokenLength: 128,
			withPosition: false,
		});

		const oversample = Math.min(1000, Math.max(k * 12, 100));
		const qualifiedHits = tokens.qualified
			? await this.ftsCandidatesRefs(
					table,
					tokens.qualified,
					'token_texts',
					oversample,
					filterClause,
					'refs.token_texts_qualified',
				)
			: [];

		const needsBaseFallback = qualifiedHits.length < k;
		const baseHits = needsBaseFallback
			? await this.ftsCandidatesRefs(
					table,
					tokens.base,
					'token_texts',
					oversample,
					filterClause,
					'refs.token_texts',
				)
			: [];

		const ftsHits = dedupeUsageCandidates([...qualifiedHits, ...baseHits]);

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

	private async ftsCandidatesSymbolsFullTextQuery(
		table: Table,
		query: lancedb.FullTextQuery,
		limit: number,
		filterClause: string | undefined,
		source: string,
	): Promise<Candidate[]> {
		let q = table.search(query, 'fts').limit(limit);
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
			const tokenTextsRaw = normalizeJsonValue(r['token_texts']);
			const tokenTexts = Array.isArray(tokenTextsRaw)
				? tokenTextsRaw.map(v => String(v)).filter(Boolean)
				: [];
			const tokenQuery = query.trim().toLowerCase();
			const tokenText =
				tokenTexts.find(t => t.toLowerCase() === tokenQuery) ??
				tokenTexts.find(t => t.toLowerCase().includes(tokenQuery)) ??
				tokenTexts[0] ??
				'';
			return {
				table: 'refs',
				id: String(r['ref_id']),
				file_path: String(r['file_path']),
				start_line: Number(r['start_line']),
				end_line: Number(r['end_line']),
				start_byte: r['start_byte'] != null ? Number(r['start_byte']) : null,
				end_byte: r['end_byte'] != null ? Number(r['end_byte']) : null,
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

	private async ensureIndexCompatible(): Promise<void> {
		const compatibility = await checkV2IndexCompatibility(this.projectRoot);
		if (
			compatibility.status !== 'needs_reindex' &&
			compatibility.status !== 'corrupt_manifest'
		) {
			return;
		}

		throw new V2ReindexRequiredError({
			requiredSchemaVersion: V2_SCHEMA_VERSION,
			manifestSchemaVersion: compatibility.manifestSchemaVersion,
			manifestPath: compatibility.manifestPath,
			reason:
				compatibility.status === 'needs_reindex'
					? 'schema_mismatch'
					: 'corrupt_manifest',
			message:
				compatibility.message ??
				'Index is incompatible. Run a full reindex (CLI: /reindex, MCP: build_index {force:true}).',
		});
	}

	private async doInitialize(signal?: AbortSignal): Promise<void> {
		try {
			throwIfAborted(signal, 'Warmup cancelled');
			this.config = await loadConfig(this.projectRoot);
			const config = this.config;

			if (!this.storage) {
				this.storage = new StorageV2(
					this.projectRoot,
					config.embeddingDimensions,
				);
				await this.storage.connect();
			}

			this.initialized = true;
			this.log('info', 'SearchEngineV2 initialized');
		} catch (error) {
			if (isAbortError(error)) {
				if (!this.externalStorage) {
					this.storage?.close();
				}
				this.storage = null;
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

	private async ensureEmbeddingsInitialized(
		signal?: AbortSignal,
	): Promise<void> {
		if (this.embeddings) return;
		if (this.embeddingsInitPromise) {
			return this.embeddingsInitPromise;
		}

		this.embeddingsInitPromise = (async () => {
			throwIfAborted(signal, 'Warmup cancelled');
			if (!this.config) {
				this.config = await loadConfig(this.projectRoot);
			}
			const provider = this.createEmbeddingProvider(this.config);
			await provider.initialize();
			this.embeddings = provider;
		})().catch(error => {
			this.embeddingsInitPromise = null;
			throw error;
		});

		return this.embeddingsInitPromise;
	}

	private async tryEmbedQuery(query: string): Promise<{
		vector: number[] | null;
		warning: V2SearchWarning | null;
	}> {
		try {
			await this.ensureEmbeddingsInitialized();
			if (!this.embeddings) {
				return {
					vector: null,
					warning: {
						code: 'embeddings_unavailable',
						message:
							'Embeddings provider is unavailable; vector channels were skipped.',
					},
				};
			}
			const vector = await this.embeddings.embedSingle(query);
			return {vector, warning: null};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				vector: null,
				warning: {
					code: 'embeddings_error',
					message: `Failed to embed query; vector channels were skipped: ${message}`,
				},
			};
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
		if (!this.externalEmbeddings) {
			this.embeddings?.close();
		}
		this.embeddings = null;
		this.embeddingsInitPromise = null;
		this.config = null;
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

type DefinitionFuzzyPlan = {
	symbolToken: string;
	qualToken: string | null;
	fuzziness: number;
	maxExpansions: number;
	prefixLength: number;
};

function buildDefinitionFuzzyPlan(query: string): DefinitionFuzzyPlan | null {
	const normalized = normalizeDefinitionFuzzyQuery(query);
	if (!normalized) return null;

	const {rawToken, symbolToken, hasQualifier} = normalized;
	if (symbolToken.length < 4) return null;

	const fuzziness = autoFuzziness(symbolToken);
	if (fuzziness <= 0) return null;

	const prefixLength =
		symbolToken.length >= 10 ? 2 : symbolToken.length >= 6 ? 1 : 0;
	const maxExpansions = 50;

	return {
		symbolToken,
		qualToken: hasQualifier ? rawToken : null,
		fuzziness,
		maxExpansions,
		prefixLength,
	};
}

function normalizeDefinitionFuzzyQuery(query: string): {
	rawToken: string;
	symbolToken: string;
	hasQualifier: boolean;
} | null {
	let q = query.trim();
	if (!q) return null;

	q = stripWrappingQuotes(q);
	q = q.replace(/^@+/, '');

	// Strip common callsite punctuation.
	q = q.replace(/\(\)\s*$/, '');
	q = q.replace(/\(\s*$/, '');
	q = q.replace(/\)\s*$/, '');
	q = q.replace(/[;,:]+$/, '');

	if (!q || /\s/.test(q)) return null;

	// identifier or qualified identifier chain (Foo.Bar::Baz)
	if (
		!/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|#)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(
			q,
		)
	) {
		return null;
	}

	const rawToken = q;
	const hasQualifier =
		rawToken.includes('.') || rawToken.includes('::') || rawToken.includes('#');

	// Extract the last segment for symbol_name matching.
	const lastNs = rawToken.includes('::')
		? rawToken.split('::').pop()!
		: rawToken;
	const symbolToken = lastNs.split(/[.#]/).pop()!.trim();
	if (!symbolToken || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbolToken))
		return null;

	return {rawToken, symbolToken, hasQualifier};
}

function stripWrappingQuotes(value: string): string {
	const v = value.trim();
	if (v.length >= 2) {
		const first = v[0];
		const last = v[v.length - 1];
		if (
			(first === '"' && last === '"') ||
			(first === "'" && last === "'") ||
			(first === '`' && last === '`')
		) {
			return v.slice(1, -1).trim();
		}
	}
	return v;
}

function autoFuzziness(token: string): number {
	if (token.length <= 2) return 0;
	if (token.length <= 5) return 1;
	return 2;
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

type UsageTokens = {base: string; qualified: string | null};

function extractUsageTokens(query: string): UsageTokens | null {
	const q = query.trim();
	if (!q) return null;

	const backtick = q.match(/`([^`]+)`/);
	if (backtick?.[1]) {
		const token = normalizeUsageTokens(backtick[1]);
		if (token) return token;
	}

	const quoted = q.match(/["']([^"']+)["']/);
	if (quoted?.[1]) {
		const token = normalizeUsageTokens(quoted[1]);
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
		const token = normalizeUsageTokens(raw);
		if (token) return token;
	}

	return null;
}

function normalizeUsageTokens(raw: string): UsageTokens | null {
	let token = raw.trim();
	if (!token) return null;

	token = stripWrappingQuotes(token);
	token = token.replace(/\(\)\s*$/, '');
	token = token.replace(/\(\s*$/, '');
	token = token.replace(/\)\s*$/, '');
	token = token.replace(/[;,:]+$/, '');
	if (!token) return null;

	const normalized = token.replace(/::/g, '.').replace(/#/g, '.');
	const parts = normalized
		.split('.')
		.map(p => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;

	const base = parts[parts.length - 1] ?? '';
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base)) return null;

	const receiver = parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';
	const receiverIsIgnored =
		receiver === 'this' ||
		receiver === 'self' ||
		receiver === 'super' ||
		receiver === 'cls';
	const qualified =
		receiver &&
		!receiverIsIgnored &&
		/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(receiver)
			? `${receiver}.${base}`
			: null;

	return {base, qualified};
}

function buildFtsQueryFromCode(query: string): string | null {
	const rawTokens = query.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
	const filtered = rawTokens
		.map(t => t.trim())
		.filter(Boolean)
		.filter(t => t.length >= 2);
	const parts = uniqueStable(filtered.flatMap(splitIdentifierParts)).filter(
		p => p.length >= 2 && !QUERY_STOP_WORDS.has(p),
	);
	if (parts.length === 0) return null;
	return parts.slice(0, 32).join(' ');
}

async function ensureFtsIndex(
	table: Table,
	column: string,
	options: Partial<lancedb.FtsOptions>,
): Promise<void> {
	const state = getFtsIndexState(table);
	if (state.ensured.has(column)) return;

	const inflight = state.inFlight.get(column);
	if (inflight) return inflight;

	const promise = (async () => {
		// Refresh from LanceDB the first time we see a table.
		if (!state.loaded) {
			try {
				const indices = await table.listIndices();
				for (const idx of indices as Array<{
					indexType: string;
					columns: string[];
				}>) {
					if (idx.indexType !== 'FTS') continue;
					for (const col of idx.columns) {
						state.ensured.add(col);
					}
				}
			} catch {
				// Ignore - we'll attempt index creation on demand.
			} finally {
				state.loaded = true;
			}
		}

		if (state.ensured.has(column)) return;

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
		state.ensured.add(column);
	})().finally(() => {
		state.inFlight.delete(column);
	});

	state.inFlight.set(column, promise);
	return promise;
}

type FtsIndexState = {
	loaded: boolean;
	ensured: Set<string>;
	inFlight: Map<string, Promise<void>>;
};

const FTS_INDEX_STATE = new WeakMap<Table, FtsIndexState>();

function getFtsIndexState(table: Table): FtsIndexState {
	const existing = FTS_INDEX_STATE.get(table);
	if (existing) return existing;
	const state: FtsIndexState = {
		loaded: false,
		ensured: new Set<string>(),
		inFlight: new Map<string, Promise<void>>(),
	};
	FTS_INDEX_STATE.set(table, state);
	return state;
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

function dedupeUsageCandidates(candidates: Candidate[]): Candidate[] {
	const byKey = new Map<string, Candidate>();

	const hasQualifiedChannel = (c: Candidate) =>
		c.channels.some(ch => ch.source === 'refs.token_texts_qualified');

	for (const candidate of candidates) {
		if (candidate.table !== 'refs') continue;

		const key = `${candidate.file_path}:${candidate.start_byte ?? candidate.start_line}:${candidate.end_byte ?? candidate.end_line}:${candidate.ref_kind ?? ''}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, candidate);
			continue;
		}

		const mergedChannels = [...existing.channels, ...candidate.channels];

		const existingPreferred =
			hasQualifiedChannel(existing) ||
			(typeof existing.token_text === 'string' &&
				existing.token_text.includes('.'));
		const candidatePreferred =
			hasQualifiedChannel(candidate) ||
			(typeof candidate.token_text === 'string' &&
				candidate.token_text.includes('.'));

		byKey.set(key, {
			...(candidatePreferred && !existingPreferred ? candidate : existing),
			channels: mergedChannels,
		});
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
		query?: string;
		applyLexicalOverlap?: boolean;
	},
): Array<
	Candidate & {
		score: number;
		priors: Array<{name: string; value: number; note: string}>;
	}
> {
	const demoteVectorOnlyIfNoOverlap =
		options.intent === 'definition' || options.intent === 'similar_code';
	const queryParts =
		options.applyLexicalOverlap && options.query
			? extractQueryParts(options.query)
			: [];
	const queryPartSet = new Set(queryParts);

	const withScores = candidates.map(c => {
		// RRF across channels (source-specific rank)
		let rrf = 0;
		for (const ch of c.channels) {
			const weight = channelRrfWeight(options.intent, ch);
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

		if (queryPartSet.size > 0) {
			const overlap = lexicalOverlapCount(queryPartSet, c);
			const hasVector = c.channels.some(ch => ch.channel === 'vector');
			const hasFts = c.channels.some(ch => ch.channel === 'fts');

			if (hasVector && overlap > 0) {
				const boost = 1 + Math.min(0.25, overlap * 0.05);
				score *= boost;
				priors.push({
					name: 'lexical_overlap_boost',
					value: boost,
					note: `Boost vector hits with ${overlap} overlapping tokens`,
				});
			}

			if (
				hasVector &&
				!hasFts &&
				overlap === 0 &&
				demoteVectorOnlyIfNoOverlap
			) {
				score *= 0.9;
				priors.push({
					name: 'vector_no_overlap_demotion',
					value: 0.9,
					note: 'Soft-demote vector-only hits with zero lexical overlap',
				});
			}
		}

		return {...c, score, priors};
	});

	if (!options.applyDiversity) {
		return withScores.sort((a, b) => b.score - a.score);
	}

	const byScore = [...withScores].sort((a, b) => b.score - a.score);
	const fileCounts = new Map<string, number>();
	for (const c of byScore) {
		const count = fileCounts.get(c.file_path) ?? 0;
		fileCounts.set(c.file_path, count + 1);
		if (count > 0) {
			const penalty = 1 / (1 + count * 0.25);
			c.score *= penalty;
			c.priors.push({
				name: 'diversity_penalty',
				value: penalty,
				note: 'Soft-diversify by file',
			});
		}
	}
	return byScore.sort((a, b) => b.score - a.score);
}

function channelRrfWeight(
	intent: Exclude<V2SearchIntent, 'auto'>,
	channel: V2ExplainChannel,
): number {
	const base = channel.channel === 'vector' ? 1.0 : 0.9;
	const s = channel.source;

	switch (intent) {
		case 'definition': {
			if (s === 'symbols.name') return 1.35;
			if (s === 'symbols.qualname') return 1.25;
			if (s === 'symbols.name_fuzzy') return 1.2;
			if (s === 'symbols.qualname_fuzzy') return 1.15;
			if (s === 'symbols.identifiers') return 1.05;
			if (s === 'symbols.vec_summary') return 1.0;
			if (s === 'symbols.search_text') return 0.95;
			return base;
		}
		case 'concept': {
			if (s === 'files.vec_file') return 1.15;
			if (s === 'files.fts') return 1.0;
			if (s === 'symbols.vec_summary') return 1.1;
			if (s === 'symbols.search_text') return 1.0;
			if (s === 'symbols.identifiers') return 0.95;
			if (s === 'chunks.vec_code') return 1.1;
			if (s === 'chunks.search_text') return 1.0;
			if (s === 'chunks.identifiers') return 0.95;
			return base;
		}
		case 'exact_text': {
			if (s === 'chunks.code_text' || s === 'symbols.code_text') return 1.2;
			return base;
		}
		case 'similar_code': {
			if (s === 'chunks.vec_code') return 1.25;
			if (s === 'symbols.vec_summary') return 1.05;
			if (s === 'chunks.search_text' || s === 'symbols.search_text') return 0.9;
			return base;
		}
		case 'usage': {
			if (s === 'refs.token_texts_qualified') return 1.15;
			if (s === 'refs.token_texts') return 1.0;
			return base;
		}
		default: {
			return base;
		}
	}
}

const QUERY_STOP_WORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'to',
	'of',
	'in',
	'on',
	'for',
	'with',
	'without',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'being',
	'does',
	'do',
	'did',
	'how',
	'what',
	'where',
	'when',
	'why',
	'which',
	'who',
	'whom',
	'this',
	'that',
	'these',
	'those',
	'it',
	'they',
	'them',
	'we',
	'you',
	'i',
]);

function extractQueryParts(query: string): string[] {
	const tokens = query.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
	const parts = tokens.flatMap(splitIdentifierParts);
	const filtered = parts.filter(p => p.length >= 2 && !QUERY_STOP_WORDS.has(p));
	return uniqueStable(filtered).slice(0, 32);
}

function lexicalOverlapCount(
	queryParts: Set<string>,
	candidate: Candidate,
): number {
	const surface = `${candidate.title}\n${candidate.snippet}\n${candidate.file_path}`;
	const tokens = surface.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
	const candidateParts = new Set(
		uniqueStable(tokens.flatMap(splitIdentifierParts)).filter(
			p => p.length >= 2,
		),
	);

	let overlap = 0;
	for (const part of queryParts) {
		if (candidateParts.has(part)) overlap += 1;
	}
	return overlap;
}

function splitIdentifierParts(identifier: string): string[] {
	const normalized = identifier.replace(/[-_]+/g, ' ');
	const spaced = normalized
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
	return spaced
		.split(/\s+/g)
		.map(p => p.trim().toLowerCase())
		.filter(Boolean);
}

function uniqueStable(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
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
	const seen = new Set<string>();

	const push = (action: V2NextAction) => {
		const key = `${action.tool}:${JSON.stringify(action.args)}`;
		if (seen.has(key)) return;
		seen.add(key);
		actions.push(action);
	};

	const firstDef = groups.definitions[0];
	if (firstDef && firstDef.table === 'symbols') {
		push({tool: 'get_symbol_details', args: {symbol_id: firstDef.id}});
		push({tool: 'find_references', args: {symbol_id: firstDef.id}});
		push({
			tool: 'read_file_lines',
			args: {
				file_path: firstDef.file_path,
				start_line: firstDef.start_line,
				end_line: firstDef.end_line,
			},
		});
	}

	const firstFile = groups.files[0];
	if (firstFile && firstFile.table === 'files') {
		push({
			tool: 'read_file_lines',
			args: {file_path: firstFile.file_path, start_line: 1, end_line: 200},
		});
		push({
			tool: 'get_surrounding_code',
			args: {table: 'files', id: firstFile.id},
		});
	}

	if (firstDef && firstDef.table === 'symbols') {
		push({
			tool: 'get_surrounding_code',
			args: {table: 'symbols', id: firstDef.id},
		});
	}

	const firstUsage = groups.usages[0];
	if (firstUsage) {
		push({
			tool: 'read_file_lines',
			args: {
				file_path: firstUsage.file_path,
				start_line: firstUsage.start_line,
				end_line: firstUsage.end_line,
			},
		});
	}

	const firstBlock = groups.blocks[0];
	if (firstBlock) {
		push({
			tool: 'read_file_lines',
			args: {
				file_path: firstBlock.file_path,
				start_line: firstBlock.start_line,
				end_line: firstBlock.end_line,
			},
		});
		push({
			tool: 'get_surrounding_code',
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

function normalizeJsonRecord(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) {
		out[k] = normalizeJsonValue(v);
	}
	return out;
}

function normalizeJsonValue(value: unknown): unknown {
	if (value == null) return value;

	if (Array.isArray(value)) {
		return value.map(v => normalizeJsonValue(v));
	}

	if (ArrayBuffer.isView(value)) {
		const iterable = value as unknown as {
			[Symbol.iterator]?: () => Iterator<unknown>;
		};
		if (typeof iterable[Symbol.iterator] === 'function') {
			return Array.from(iterable as Iterable<unknown>, v => Number(v));
		}
		return null;
	}

	if (typeof value === 'object') {
		const maybe = value as {toArray?: () => unknown; toJSON?: () => unknown};
		if (typeof maybe.toArray === 'function') {
			return normalizeJsonValue(maybe.toArray());
		}
		if (typeof maybe.toJSON === 'function') {
			try {
				return maybe.toJSON();
			} catch {
				// fall through
			}
		}

		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = normalizeJsonValue(v);
		}
		return out;
	}

	return value;
}
