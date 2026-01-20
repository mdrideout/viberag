/**
 * V2 Indexing Service - multi-entity indexing pipeline (symbols/chunks/files).
 *
 * Pipeline:
 * 1) Build Merkle tree + diff
 * 2) For deleted/changed files, delete previous v2 rows
 * 3) Parse + extract deterministic facts (symbols/chunks/files)
 * 4) Embed surfaces (cached by embed_hash)
 * 5) Upsert rows into v2 tables
 * 6) Persist v2 manifest with tree + stats
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import {loadConfig, type ViberagConfig} from '../../lib/config.js';
import {createServiceLogger, type Logger} from '../../lib/logger.js';
import {getAbortReason, isAbortError, throwIfAborted} from '../../lib/abort.js';
import {MerkleTree} from '../../lib/merkle/index.js';
import type {SerializedNode} from '../../lib/merkle/node.js';
import {computeStringHash} from '../../lib/merkle/hash.js';
import {Chunker} from '../../lib/chunker/index.js';
import {GeminiEmbeddingProvider} from '../../providers/gemini.js';
import {LocalEmbeddingProvider} from '../../providers/local.js';
import {MistralEmbeddingProvider} from '../../providers/mistral.js';
import {OpenAIEmbeddingProvider} from '../../providers/openai.js';
import type {EmbeddingProvider, ChunkMetadata} from '../../providers/types.js';
import {
	extractV2FromFile,
	type V2ExtractedArtifacts,
} from './extract/extract.js';
import {StorageV2} from './storage/index.js';
import {
	checkV2IndexCompatibility,
	loadV2Manifest,
	saveV2Manifest,
	V2ReindexRequiredError,
	V2_SCHEMA_VERSION,
} from './manifest.js';
import {
	TypedEmitter,
	type IndexingEvents,
	type SlotEvents,
	type IndexingPhase,
	type IndexingUnit,
} from '../types.js';

export type V2IndexStats = {
	filesScanned: number;
	filesIndexed: number;
	filesNew: number;
	filesModified: number;
	filesDeleted: number;

	fileRowsUpserted: number;
	symbolRowsUpserted: number;
	chunkRowsUpserted: number;
	refRowsUpserted: number;

	fileRowsDeleted: number;
	symbolRowsDeleted: number;
	chunkRowsDeleted: number;
	refRowsDeleted: number;

	embeddingsComputed: number;
	embeddingsCached: number;
};

export type V2IndexOptions = {
	force?: boolean;
};

type V2IndexingServiceEvents = IndexingEvents & SlotEvents;

export type IndexingServiceV2Options = {
	logger?: Logger;
	storage?: StorageV2;
	embeddings?: EmbeddingProvider;
	chunker?: Chunker;
	signal?: AbortSignal;
};

let globalV2IndexPromise: Promise<V2IndexStats> | null = null;

export class IndexingServiceV2 extends TypedEmitter<V2IndexingServiceEvents> {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private storage: StorageV2 | null = null;
	private chunker: Chunker | null = null;
	private embeddings: EmbeddingProvider | null = null;
	private logger: Logger | null = null;
	private debugLogger: Logger;
	private readonly externalStorage: boolean;
	private readonly externalChunker: boolean;
	private suppressEvents = false;
	private abortSignal: AbortSignal | undefined;

	constructor(
		projectRoot: string,
		options?: IndexingServiceV2Options | Logger,
	) {
		super();
		this.projectRoot = projectRoot;
		this.debugLogger = createServiceLogger(projectRoot, 'indexer');

		if (
			options &&
			typeof options === 'object' &&
			('logger' in options ||
				'storage' in options ||
				'embeddings' in options ||
				'chunker' in options ||
				'signal' in options)
		) {
			this.logger = options.logger ?? null;
			if (options.storage) {
				this.storage = options.storage;
				this.externalStorage = true;
			} else {
				this.externalStorage = false;
			}
			if (options.chunker) {
				this.chunker = options.chunker;
				this.externalChunker = true;
			} else {
				this.externalChunker = false;
			}
			if (options.embeddings) {
				this.embeddings = options.embeddings;
			}
			if (options.signal) {
				this.abortSignal = options.signal;
			}
		} else {
			this.logger = (options as Logger | undefined) ?? null;
			this.externalStorage = false;
			this.externalChunker = false;
		}
	}

	async index(options: V2IndexOptions = {}): Promise<V2IndexStats> {
		if (globalV2IndexPromise) {
			this.log('info', 'Waiting for in-progress indexing to complete');
			return globalV2IndexPromise;
		}

		globalV2IndexPromise = this.doIndex(options);
		try {
			return await globalV2IndexPromise;
		} finally {
			globalV2IndexPromise = null;
		}
	}

	private async doIndex(options: V2IndexOptions): Promise<V2IndexStats> {
		const {force = false} = options;
		this.suppressEvents = false;
		const startTimeMs = Date.now();

		const stats: V2IndexStats = {
			filesScanned: 0,
			filesIndexed: 0,
			filesNew: 0,
			filesModified: 0,
			filesDeleted: 0,

			fileRowsUpserted: 0,
			symbolRowsUpserted: 0,
			chunkRowsUpserted: 0,
			refRowsUpserted: 0,

			fileRowsDeleted: 0,
			symbolRowsDeleted: 0,
			chunkRowsDeleted: 0,
			refRowsDeleted: 0,

			embeddingsComputed: 0,
			embeddingsCached: 0,
		};

		this.emit('start');
		this.emit('slots-reset');
		throwIfAborted(this.abortSignal, 'Indexing cancelled');

		try {
			const compatibility = await checkV2IndexCompatibility(this.projectRoot);
			if (
				(compatibility.status === 'needs_reindex' ||
					compatibility.status === 'corrupt_manifest') &&
				!force
			) {
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

			await this.initialize();
			throwIfAborted(this.abortSignal, 'Indexing cancelled');

			const config = this.config!;
			const storage = this.storage!;
			const chunker = this.chunker!;
			const embeddings = this.embeddings!;

			// Repo identity + revision derived from content tree hash
			const repoId = computeStringHash(this.projectRoot);
			// For working tree indexing, keep a stable "revision" value so incremental
			// updates don't create mixed-revision rows. The per-file `file_hash` tracks
			// actual content changes.
			const revision = 'working';

			this.emitIndexProgress('init', 'Loading manifest', 0, 0, null);
			let manifest = await loadV2Manifest(this.projectRoot, {
				repoId,
				revision,
			});

			const previousTree =
				compatibility.status === 'compatible' && manifest.tree
					? MerkleTree.fromJSON(manifest.tree as SerializedNode)
					: MerkleTree.empty();

			this.emitIndexProgress('scan', 'Scanning filesystem', 0, 0, null);
			const currentTree = await MerkleTree.build(
				this.projectRoot,
				config.extensions,
				config.excludePatterns,
				previousTree,
				progress => {
					const unit = progress.total > 0 ? ('files' as const) : null;
					this.emitIndexProgress(
						'scan',
						progress.stage,
						progress.current,
						progress.total,
						unit,
					);
				},
				this.abortSignal ?? undefined,
			);

			stats.filesScanned = currentTree.buildStats.filesScanned;
			stats.filesIndexed = currentTree.fileCount;

			// Diff
			const diff = force
				? this.createForceDiff(currentTree)
				: previousTree.compare(currentTree);

			stats.filesNew = diff.new.length;
			stats.filesModified = diff.modified.length;
			stats.filesDeleted = diff.deleted.length;

			if (force) {
				this.emitIndexProgress('persist', 'Resetting tables', 0, 0, null);
				await storage.resetEntityTables();
			}

			// Delete removed file rows
			if (diff.deleted.length > 0) {
				this.emitIndexProgress(
					'persist',
					'Deleting rows for deleted files',
					0,
					diff.deleted.length,
					'files',
				);
				let deletedProcessed = 0;
				for (const filePath of diff.deleted) {
					throwIfAborted(this.abortSignal, 'Indexing cancelled');
					const deleted = await storage.deleteAllRowsForFile(filePath);
					stats.symbolRowsDeleted += deleted.symbolsDeleted;
					stats.chunkRowsDeleted += deleted.chunksDeleted;
					stats.fileRowsDeleted += deleted.filesDeleted;
					stats.refRowsDeleted += deleted.refsDeleted;
					deletedProcessed += 1;
					this.emitIndexProgress(
						'persist',
						'Deleting rows for deleted files',
						deletedProcessed,
						diff.deleted.length,
						'files',
					);
				}
			}

			const filesToProcess = Array.from(
				new Set([...diff.new, ...diff.modified]),
			);
			if (filesToProcess.length === 0 && !force) {
				// Still update manifest revision/tree/stats.
				const totalSymbols = await storage.getSymbolsTable().countRows();
				const totalChunks = await storage.getChunksTable().countRows();
				const totalRefs = await storage.getRefsTable().countRows();
				manifest = {
					...manifest,
					repoId,
					revision,
					tree: currentTree.toJSON(),
					stats: {
						totalFiles: currentTree.fileCount,
						totalSymbols,
						totalChunks,
						totalRefs,
					},
				};
				await saveV2Manifest(this.projectRoot, manifest);
				this.emit('complete', {
					stats: {
						filesProcessed: stats.filesScanned,
						chunksAdded: 0,
						chunksDeleted: 0,
						chunksUnchanged: 0,
						durationMs: Date.now() - startTimeMs,
					},
				});
				return stats;
			}

			// Delete rows for changed files before reinsert
			if (!force && filesToProcess.length > 0) {
				this.emitIndexProgress(
					'persist',
					'Clearing rows for changed files',
					0,
					filesToProcess.length,
					'files',
				);
				let cleared = 0;
				for (const filePath of filesToProcess) {
					throwIfAborted(this.abortSignal, 'Indexing cancelled');
					const deleted = await storage.deleteAllRowsForFile(filePath);
					stats.symbolRowsDeleted += deleted.symbolsDeleted;
					stats.chunkRowsDeleted += deleted.chunksDeleted;
					stats.fileRowsDeleted += deleted.filesDeleted;
					stats.refRowsDeleted += deleted.refsDeleted;
					cleared += 1;
					this.emitIndexProgress(
						'persist',
						'Clearing rows for changed files',
						cleared,
						filesToProcess.length,
						'files',
					);
				}
			}

			// Extract deterministic facts
			this.emitIndexProgress(
				'chunk',
				'Extracting symbols/chunks/files',
				0,
				filesToProcess.length,
				'files',
			);
			const extracted: V2ExtractedArtifacts[] = [];
			let extractedFiles = 0;

			for (const filePath of filesToProcess) {
				throwIfAborted(this.abortSignal, 'Indexing cancelled');
				const absolutePath = path.join(this.projectRoot, filePath);
				try {
					const content = await fs.readFile(absolutePath, 'utf-8');
					const artifacts = await extractV2FromFile(
						chunker,
						filePath,
						content,
						{
							repoId,
							revision,
							chunkMaxSize: config.chunkMaxSize,
						},
					);
					extracted.push(artifacts);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					this.log('warn', `Failed to extract ${filePath}: ${message}`);
				} finally {
					extractedFiles += 1;
					this.emitIndexProgress(
						'chunk',
						'Extracting symbols/chunks/files',
						extractedFiles,
						filesToProcess.length,
						'files',
					);
				}
			}

			throwIfAborted(this.abortSignal, 'Indexing cancelled');

			// Embed all surfaces (cached by embed_hash)
			const embedItems: Array<{
				hash: string;
				text: string;
				meta: ChunkMetadata;
			}> = [];
			for (const item of extracted) {
				embedItems.push({
					hash: item.file.embed_hash,
					text: item.file.embed_input,
					meta: {
						filepath: item.file.file_path,
						startLine: 1,
						endLine: 1,
						size: item.file.embed_input.length,
					},
				});
				for (const s of item.symbols) {
					embedItems.push({
						hash: s.embed_hash,
						text: s.embed_input,
						meta: {
							filepath: s.file_path,
							startLine: s.start_line,
							endLine: s.end_line,
							size: s.embed_input.length,
						},
					});
				}
				for (const c of item.chunks) {
					embedItems.push({
						hash: c.embed_hash,
						text: c.embed_input,
						meta: {
							filepath: c.file_path,
							startLine: c.start_line,
							endLine: c.end_line,
							size: c.embed_input.length,
						},
					});
				}
			}

			// Dedupe by hash (cache key)
			const uniqueByHash = new Map<
				string,
				{text: string; meta: ChunkMetadata}
			>();
			for (const item of embedItems) {
				if (!uniqueByHash.has(item.hash)) {
					uniqueByHash.set(item.hash, {text: item.text, meta: item.meta});
				}
			}

			const uniqueHashes = [...uniqueByHash.keys()];

			this.emitIndexProgress(
				'embed',
				'Checking embedding cache',
				0,
				uniqueHashes.length,
				'chunks',
			);

			const cached = await storage.getCachedEmbeddings(uniqueHashes);
			const cacheHits = uniqueHashes.filter(h => cached.has(h));
			stats.embeddingsCached += cacheHits.length;

			const misses = uniqueHashes.filter(h => !cached.has(h));

			let embeddedSoFar = cacheHits.length;
			this.emit('chunk-progress', {chunksProcessed: embeddedSoFar});

			if (misses.length > 0) {
				const BATCH_SIZE = 20;
				const isLocalProvider = embeddings instanceof LocalEmbeddingProvider;
				const BATCH_CONCURRENCY = isLocalProvider ? 1 : 3;
				const batchLimit = pLimit(BATCH_CONCURRENCY);

				const batchTasks: Array<() => Promise<void>> = [];
				for (let i = 0; i < misses.length; i += BATCH_SIZE) {
					const batchHashes = misses.slice(i, i + BATCH_SIZE);
					batchTasks.push(async () => {
						const batch = batchHashes.map(h => uniqueByHash.get(h)!);
						const texts = batch.map(b => b.text);
						const metadata = batch.map(b => b.meta);

						const vectors = await embeddings.embed(texts, {
							chunkMetadata: metadata,
							logger: this.debugLogger,
							signal: this.abortSignal ?? undefined,
						});

						const cacheRows = [];
						for (let j = 0; j < batchHashes.length; j++) {
							const hash = batchHashes[j]!;
							const vector = vectors[j];
							if (!vector) {
								continue;
							}
							cached.set(hash, vector);
							cacheRows.push({
								input_hash: hash,
								vector,
								created_at: new Date().toISOString(),
							});
						}

						stats.embeddingsComputed += cacheRows.length;

						if (cacheRows.length > 0) {
							await storage.cacheEmbeddings(cacheRows);
						}

						embeddedSoFar += batchHashes.length;
						this.emit('chunk-progress', {chunksProcessed: embeddedSoFar});
						this.emitIndexProgress(
							'embed',
							'Embedding surfaces',
							embeddedSoFar,
							uniqueHashes.length,
							'chunks',
						);
					});
				}

				this.emitIndexProgress(
					'embed',
					'Embedding surfaces',
					embeddedSoFar,
					uniqueHashes.length,
					'chunks',
				);

				await Promise.all(batchTasks.map(task => batchLimit(task)));
			}

			throwIfAborted(this.abortSignal, 'Indexing cancelled');

			// Persist (upsert) rows
			this.emitIndexProgress('persist', 'Writing tables', 0, 0, null);

			const fileRows: Record<string, unknown>[] = [];
			const symbolRows: Record<string, unknown>[] = [];
			const chunkRows: Record<string, unknown>[] = [];
			const refRows: Record<string, unknown>[] = [];

			for (const item of extracted) {
				const vecFile = cached.get(item.file.embed_hash);
				if (!vecFile) {
					continue;
				}
				fileRows.push({
					file_id: item.file.file_id,
					repo_id: item.file.repo_id,
					revision: item.file.revision,
					file_path: item.file.file_path,
					extension: item.file.extension,
					file_hash: item.file.file_hash,
					imports: item.file.imports,
					exports: item.file.exports,
					top_level_doc: item.file.top_level_doc,
					file_summary_text: item.file.file_summary_text,
					vec_file: vecFile,
				});

				for (const s of item.symbols) {
					const vec = cached.get(s.embed_hash);
					if (!vec) continue;
					symbolRows.push({
						symbol_id: s.symbol_id,
						repo_id: s.repo_id,
						revision: s.revision,
						file_path: s.file_path,
						extension: s.extension,
						language_hint: s.language_hint,
						start_line: s.start_line,
						end_line: s.end_line,
						start_byte: s.start_byte,
						end_byte: s.end_byte,
						symbol_kind: s.symbol_kind,
						symbol_name: s.symbol_name,
						qualname: s.qualname,
						symbol_name_fuzzy: s.symbol_name_fuzzy,
						qualname_fuzzy: s.qualname_fuzzy,
						parent_symbol_id: s.parent_symbol_id,
						signature: s.signature,
						docstring: s.docstring,
						is_exported: s.is_exported,
						decorator_names: s.decorator_names,
						context_header: s.context_header,
						code_text: s.code_text,
						search_text: s.search_text,
						identifiers_text: s.identifiers_text,
						identifiers: s.identifiers,
						identifier_parts: s.identifier_parts,
						called_names: s.called_names,
						string_literals: s.string_literals,
						content_hash: s.content_hash,
						file_hash: s.file_hash,
						vec_summary: vec,
					});
				}

				for (const c of item.chunks) {
					const vec = cached.get(c.embed_hash);
					if (!vec) continue;
					chunkRows.push({
						chunk_id: c.chunk_id,
						repo_id: c.repo_id,
						revision: c.revision,
						file_path: c.file_path,
						extension: c.extension,
						start_line: c.start_line,
						end_line: c.end_line,
						start_byte: c.start_byte,
						end_byte: c.end_byte,
						owner_symbol_id: c.owner_symbol_id,
						chunk_kind: c.chunk_kind,
						context_header: c.context_header,
						code_text: c.code_text,
						search_text: c.search_text,
						identifiers_text: c.identifiers_text,
						identifiers: c.identifiers,
						identifier_parts: c.identifier_parts,
						called_names: c.called_names,
						string_literals: c.string_literals,
						content_hash: c.content_hash,
						file_hash: c.file_hash,
						vec_code: vec,
					});
				}

				for (const r of item.refs) {
					refRows.push({
						ref_id: r.ref_id,
						repo_id: r.repo_id,
						revision: r.revision,
						file_path: r.file_path,
						extension: r.extension,
						start_line: r.start_line,
						end_line: r.end_line,
						start_byte: r.start_byte,
						end_byte: r.end_byte,
						ref_kind: r.ref_kind,
						token_texts: r.token_texts,
						context_snippet: r.context_snippet,
						module_name: r.module_name,
						imported_name: r.imported_name,
					});
				}
			}

			await storage.upsertFiles(fileRows);
			await storage.upsertSymbols(symbolRows);
			await storage.upsertChunks(chunkRows);
			await storage.upsertRefs(refRows);

			stats.fileRowsUpserted += fileRows.length;
			stats.symbolRowsUpserted += symbolRows.length;
			stats.chunkRowsUpserted += chunkRows.length;
			stats.refRowsUpserted += refRows.length;

			const totalSymbols = await storage.getSymbolsTable().countRows();
			const totalChunks = await storage.getChunksTable().countRows();
			const totalRefs = await storage.getRefsTable().countRows();

			manifest = {
				...manifest,
				repoId,
				revision,
				tree: currentTree.toJSON(),
				stats: {
					totalFiles: currentTree.fileCount,
					totalSymbols,
					totalChunks,
					totalRefs,
				},
			};

			this.emitIndexProgress('finalize', 'Saving manifest', 0, 0, null);
			await saveV2Manifest(this.projectRoot, manifest);

			this.emit('complete', {
				stats: {
					filesProcessed: stats.filesScanned,
					chunksAdded: stats.chunkRowsUpserted,
					chunksDeleted: stats.chunkRowsDeleted,
					chunksUnchanged: 0,
					durationMs: Date.now() - startTimeMs,
				},
			});

			return stats;
		} catch (error) {
			if (isAbortError(error) || this.abortSignal?.aborted) {
				this.suppressEvents = true;
				const reason = getAbortReason(this.abortSignal ?? undefined);
				this.log('info', `Indexing cancelled: ${reason}`);
				this.emit('cancelled', {reason});
				throw error;
			}
			this.suppressEvents = true;
			this.log(
				'error',
				'Indexing failed',
				error instanceof Error ? error : new Error(String(error)),
			);
			this.emit('error', {
				error: error instanceof Error ? error : new Error(String(error)),
			});
			throw error;
		}
	}

	private async initialize(): Promise<void> {
		if (this.config) return;

		this.config = await loadConfig(this.projectRoot);

		if (!this.storage) {
			this.storage = new StorageV2(
				this.projectRoot,
				this.config.embeddingDimensions,
			);
			await this.storage.connect();
		}

		if (!this.chunker) {
			this.chunker = new Chunker();
			await this.chunker.initialize();
		}

		if (!this.embeddings) {
			this.embeddings = this.createEmbeddingProvider(this.config);
			await this.embeddings.initialize();
		}
	}

	close(): void {
		if (!this.externalChunker) {
			this.chunker?.close();
			this.chunker = null;
		}
		if (!this.externalStorage) {
			this.storage?.close();
			this.storage = null;
		}
		this.embeddings?.close();
		this.embeddings = null;
		this.config = null;
	}

	private createEmbeddingProvider(config: {
		embeddingProvider: ViberagConfig['embeddingProvider'];
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

	private emitIndexProgress(
		phase: IndexingPhase,
		stage: string,
		current: number,
		total: number,
		unit: IndexingUnit | null,
	): void {
		if (this.suppressEvents) return;
		this.emit('progress', {phase, stage, current, total, unit});
	}

	private log(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
		error?: Error,
	): void {
		if (this.logger) {
			if (level === 'error') {
				this.logger.error('Indexer', message, error);
			} else if (error) {
				this.logger[level]('Indexer', message, error);
			} else {
				this.logger[level]('Indexer', message);
			}
		}
		if (level === 'error') {
			console.error(`[Indexer] ${message}`);
			if (error) {
				console.error(error);
			}
		}
	}

	private createForceDiff(tree: MerkleTree) {
		const filePaths: string[] = [];
		const serialized = tree.toJSON();
		this.collectAllFilesFromSerialized(serialized, filePaths);
		return {
			new: filePaths,
			modified: [],
			deleted: [],
			hasChanges: filePaths.length > 0,
		};
	}

	private collectAllFilesFromSerialized(
		node: SerializedNode | null,
		paths: string[],
	): void {
		if (!node) return;
		if (node.type === 'file') {
			paths.push(node.path);
		} else if (node.children) {
			for (const child of Object.values(node.children)) {
				this.collectAllFilesFromSerialized(child, paths);
			}
		}
	}
}
