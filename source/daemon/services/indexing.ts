/**
 * Indexing Service - Orchestrates the full indexing pipeline.
 *
 * Pipeline:
 * 1. Load previous Merkle tree from manifest
 * 2. Build current Merkle tree from filesystem
 * 3. Compare trees → get new/modified/deleted files
 * 4. Delete chunks for deleted files
 * 5. For new/modified files:
 *    - Chunk with tree-sitter
 *    - Compute embeddings (with cache lookup)
 *    - Upsert to LanceDB
 * 6. Save updated manifest
 *
 * Emits events for progress instead of dispatching to Redux.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import {loadConfig, type ViberagConfig} from '../lib/config.js';
import {GeminiEmbeddingProvider} from '../providers/gemini.js';
import {LocalEmbeddingProvider} from '../providers/local.js';
import {MistralEmbeddingProvider} from '../providers/mistral.js';
import {OpenAIEmbeddingProvider} from '../providers/openai.js';
import type {EmbeddingProvider, ChunkMetadata} from '../providers/types.js';
import {createServiceLogger, type Logger} from '../lib/logger.js';
import {getAbortReason, isAbortError, throwIfAborted} from '../lib/abort.js';
import {
	loadManifest,
	saveManifest,
	manifestExists,
	createEmptyManifest,
	getSchemaVersionInfo,
	updateManifestStats,
	updateManifestTree,
} from '../lib/manifest.js';
import {MerkleTree} from '../lib/merkle/index.js';
import type {SerializedNode} from '../lib/merkle/node.js';
import {Storage} from './storage/index.js';
import type {CodeChunk} from './storage/types.js';
import {Chunker} from '../lib/chunker/index.js';
import {
	TypedEmitter,
	type IndexingEvents,
	type SlotEvents,
	type IndexingPhase,
	type IndexingUnit,
} from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Statistics from indexing operations.
 */
export interface IndexStats {
	/** Number of files scanned */
	filesScanned: number;
	/** Number of new files indexed */
	filesNew: number;
	/** Number of modified files re-indexed */
	filesModified: number;
	/** Number of deleted files removed from index */
	filesDeleted: number;
	/** Number of chunks added */
	chunksAdded: number;
	/** Number of chunks deleted */
	chunksDeleted: number;
	/** Number of embeddings computed (cache miss) */
	embeddingsComputed: number;
	/** Number of embeddings retrieved from cache */
	embeddingsCached: number;
}

/**
 * Options for the index operation.
 */
export interface IndexOptions {
	/** Force full reindex, ignoring Merkle tree diff */
	force?: boolean;
}

/**
 * Failed embedding batch info for diagnostics and retry tracking.
 */
type BatchFailureInfo = {
	batchInfo: string;
	files: string[];
	chunkCount: number;
	error: string;
	timestamp: string;
};

/**
 * Create empty index stats.
 */
function createEmptyIndexStats(): IndexStats {
	return {
		filesScanned: 0,
		filesNew: 0,
		filesModified: 0,
		filesDeleted: 0,
		chunksAdded: 0,
		chunksDeleted: 0,
		embeddingsComputed: 0,
		embeddingsCached: 0,
	};
}

// ============================================================================
// Global Mutex
// ============================================================================

/**
 * Module-level mutex to prevent concurrent indexing across all Indexer instances.
 * This is necessary because watcher and CLI create separate Indexer instances,
 * and we need to prevent them from racing on manifest/storage operations.
 */
let globalIndexPromise: Promise<IndexStats> | null = null;

// ============================================================================
// IndexingService
// ============================================================================

/**
 * Combined events for indexing and slot progress.
 */
type IndexingServiceEvents = IndexingEvents & SlotEvents;

/**
 * Options for IndexingService constructor.
 */
export interface IndexingServiceOptions {
	/** Logger for debug output */
	logger?: Logger;
	/** External Storage instance (if provided, IndexingService won't create or close it) */
	storage?: Storage;
	/** Optional embedding provider override (used for testing or custom embeddings) */
	embeddings?: EmbeddingProvider;
	/** Optional abort signal for cancellation */
	signal?: AbortSignal;
}

/**
 * IndexingService - Orchestrates the full indexing pipeline.
 * Emits events for progress instead of dispatching Redux actions.
 */
export class IndexingService extends TypedEmitter<IndexingServiceEvents> {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private storage: Storage | null = null;
	private chunker: Chunker | null = null;
	private embeddings: EmbeddingProvider | null = null;
	private logger: Logger | null = null;
	private debugLogger: Logger;
	private readonly externalStorage: boolean;
	private suppressEvents = false;
	private lastThrottleMessage: string | null = null;
	private abortSignal: AbortSignal | undefined;

	constructor(projectRoot: string, options?: IndexingServiceOptions | Logger) {
		super();
		this.projectRoot = projectRoot;
		this.debugLogger = createServiceLogger(projectRoot, 'indexer');

		// Handle both old (logger) and new (options) signatures for backward compatibility
		if (
			options &&
			typeof options === 'object' &&
			('logger' in options ||
				'storage' in options ||
				'embeddings' in options ||
				'signal' in options)
		) {
			this.logger = options.logger ?? null;
			if (options.storage) {
				this.storage = options.storage;
				this.externalStorage = true;
			} else {
				this.externalStorage = false;
			}
			if (options.embeddings) {
				this.embeddings = options.embeddings;
			}
			if (options.signal) {
				this.abortSignal = options.signal;
			}
		} else {
			// Old signature: second param is Logger directly
			this.logger = (options as Logger | undefined) ?? null;
			this.externalStorage = false;
		}
	}

	/**
	 * Run the indexing pipeline.
	 * Uses global mutex to prevent concurrent index operations.
	 */
	async index(options: IndexOptions = {}): Promise<IndexStats> {
		// If any indexer instance is already running, wait for it and return its result
		if (globalIndexPromise) {
			this.log('info', 'Waiting for in-progress indexing to complete');
			return globalIndexPromise;
		}

		globalIndexPromise = this.doIndex(options);
		try {
			return await globalIndexPromise;
		} finally {
			globalIndexPromise = null;
		}
	}

	/**
	 * Perform the actual indexing operation.
	 */
	private async doIndex(options: IndexOptions = {}): Promise<IndexStats> {
		const stats = createEmptyIndexStats();
		const {force = false} = options;
		let forceReindex = force;
		const failedFilesThisRun = new Set<string>();
		const failedBatches: BatchFailureInfo[] = [];
		this.suppressEvents = false;
		const startTimeMs = Date.now();

		// Emit start event
		this.emit('start');
		this.emit('slots-reset');
		throwIfAborted(this.abortSignal, 'Indexing cancelled');

		try {
			// Initialize components
			await this.initialize();
			throwIfAborted(this.abortSignal, 'Indexing cancelled');

			const config = this.config!;
			const storage = this.storage!;
			const chunker = this.chunker!;
			const embeddings = this.embeddings!;

			// 1. Load previous manifest and Merkle tree
			this.log('info', 'Loading manifest');
			this.emitIndexProgress('init', 'Loading manifest', 0, 0, null);
			let manifest = (await manifestExists(this.projectRoot))
				? await loadManifest(this.projectRoot)
				: createEmptyManifest();
			throwIfAborted(this.abortSignal, 'Indexing cancelled');

			const schemaInfo = getSchemaVersionInfo(manifest);
			if (schemaInfo.needsReindex) {
				forceReindex = true;
				this.log(
					'info',
					`Schema version ${schemaInfo.current} is outdated (current: ${schemaInfo.required}). Forcing reindex.`,
				);
			}

			const previousTree = manifest.tree
				? MerkleTree.fromJSON(manifest.tree as SerializedNode)
				: MerkleTree.empty();

			// 2. Build current Merkle tree from filesystem
			this.log('info', 'Building Merkle tree');
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
			throwIfAborted(this.abortSignal, 'Indexing cancelled');

			stats.filesScanned = currentTree.buildStats.filesScanned;
			this.log(
				'info',
				`Scanned ${stats.filesScanned} files, indexed ${currentTree.fileCount}`,
			);

			// 3. Compare trees to get diff
			const diff = forceReindex
				? this.createForceDiff(currentTree)
				: previousTree.compare(currentTree);

			stats.filesNew = diff.new.length;
			stats.filesModified = diff.modified.length;
			stats.filesDeleted = diff.deleted.length;

			this.log(
				'info',
				`Changes: ${diff.new.length} new, ${diff.modified.length} modified, ${diff.deleted.length} deleted`,
			);

			// Retry any files that previously failed to embed (excluding deleted files)
			const previousFailedFiles = new Set(manifest.failedFiles ?? []);
			diff.deleted.forEach(file => previousFailedFiles.delete(file));
			const failedFilesToRetry = Array.from(previousFailedFiles);
			const hasFailuresToRetry = failedFilesToRetry.length > 0;
			const hasStaleFailures =
				(manifest.failedFiles ?? []).length !== failedFilesToRetry.length ||
				(manifest.failedBatches ?? []).length > 0;
			if (hasFailuresToRetry) {
				this.log(
					'info',
					`Retrying ${failedFilesToRetry.length} previously failed files`,
				);
			}

			// Short-circuit if no changes
			if (!diff.hasChanges && !forceReindex && !hasFailuresToRetry) {
				if (hasStaleFailures) {
					manifest.failedFiles = failedFilesToRetry;
					manifest.failedBatches = [];
					await saveManifest(this.projectRoot, manifest);
				}
				this.log('info', 'No changes detected');
				const durationMs = Date.now() - startTimeMs;
				this.emit('complete', {
					stats: {
						filesProcessed: stats.filesScanned,
						chunksAdded: 0,
						chunksDeleted: 0,
						chunksUnchanged: 0,
						durationMs,
					},
				});
				return stats;
			}

			// 4. Handle force reindex - drop and recreate table
			if (forceReindex) {
				throwIfAborted(this.abortSignal, 'Indexing cancelled');
				this.log('info', 'Force reindex: resetting chunks table');
				this.emitIndexProgress('persist', 'Resetting index table', 0, 0, null);
				await storage.resetChunksTable();
			}

			// 5. Delete chunks for deleted files
			if (diff.deleted.length > 0) {
				throwIfAborted(this.abortSignal, 'Indexing cancelled');
				this.log('info', `Deleting chunks for ${diff.deleted.length} files`);
				stats.chunksDeleted = await storage.deleteChunksByFilepaths(
					diff.deleted,
				);
			}

			// 6. Process new and modified files
			const filesToProcess = Array.from(
				new Set([...diff.new, ...diff.modified, ...failedFilesToRetry]),
			);

			if (filesToProcess.length > 0) {
				throwIfAborted(this.abortSignal, 'Indexing cancelled');
				this.log('info', `Processing ${filesToProcess.length} files`);

				// Delete existing chunks for modified + previously failed files
				const filesToDelete = Array.from(
					new Set([...diff.modified, ...failedFilesToRetry]),
				);
				if (filesToDelete.length > 0 && !forceReindex) {
					throwIfAborted(this.abortSignal, 'Indexing cancelled');
					const deletedCount =
						await storage.deleteChunksByFilepaths(filesToDelete);
					stats.chunksDeleted += deletedCount;
				}

				// Phase 1: Collect all chunks
				const totalFilesToProcess = filesToProcess.length;
				let filesChunked = 0;
				const chunkProgressEvery = 50;
				this.emitIndexProgress(
					'chunk',
					'Chunking files',
					0,
					totalFilesToProcess,
					'files',
				);

				const {computeStringHash} = await import('../lib/merkle/hash.js');

				type ChunkWithContext = {
					chunk: Awaited<ReturnType<typeof chunker.chunkFile>>[0];
					filepath: string;
					fileHash: string;
				};
				const allChunksWithContext: ChunkWithContext[] = [];

				for (const filepath of filesToProcess) {
					throwIfAborted(this.abortSignal, 'Indexing cancelled');
					const absolutePath = path.join(this.projectRoot, filepath);
					try {
						const content = await fs.readFile(absolutePath, 'utf-8');
						throwIfAborted(this.abortSignal, 'Indexing cancelled');
						const fileHash = computeStringHash(content);
						const chunks = await chunker.chunkFile(
							filepath,
							content,
							config.chunkMaxSize,
						);

						for (const chunk of chunks) {
							allChunksWithContext.push({chunk, filepath, fileHash});
						}
					} catch (error) {
						this.log(
							'warn',
							`Failed to process file: ${filepath}`,
							error as Error,
						);
						failedFilesThisRun.add(filepath);
					} finally {
						filesChunked += 1;
						if (
							filesChunked % chunkProgressEvery === 0 ||
							filesChunked === totalFilesToProcess
						) {
							this.emitIndexProgress(
								'chunk',
								'Chunking files',
								filesChunked,
								totalFilesToProcess,
								'files',
							);
						}
					}
				}

				const totalChunks = allChunksWithContext.length;
				this.log(
					'info',
					`Collected ${totalChunks} chunks from ${filesToProcess.length} files`,
				);

				// Phase 2: Embed chunks
				if (totalChunks > 0) {
					throwIfAborted(this.abortSignal, 'Indexing cancelled');
					let chunksProcessed = 0;

					// Emit progress helper
					const emitEmbedProgress = () => {
						this.emitIndexProgress(
							'embed',
							'Embedding chunks',
							chunksProcessed,
							totalChunks,
							'chunks',
						);
						this.emit('chunk-progress', {chunksProcessed});
					};

					// Wire throttle callback for rate limit feedback
					if ('onThrottle' in embeddings) {
						(
							embeddings as {onThrottle?: (msg: string | null) => void}
						).onThrottle = message => {
							if (this.suppressEvents) {
								return;
							}
							if (message && message !== this.lastThrottleMessage) {
								this.debugLogger.info('Indexer', 'Embedding retry', {
									message,
								});
								this.lastThrottleMessage = message;
							} else if (!message) {
								this.lastThrottleMessage = null;
							}
							this.emit('throttle', {message});
						};
					}

					// Wire slot progress callbacks for API providers
					this.wireSlotCallbacks(embeddings, failure => {
						failedBatches.push(failure);
					});

					// Initialize progress display
					emitEmbedProgress();

					// Check embedding cache
					this.emitIndexProgress(
						'embed',
						'Checking embedding cache',
						0,
						0,
						null,
					);
					const contentHashes = allChunksWithContext.map(
						c => c.chunk.contentHash,
					);
					const cachedEmbeddings =
						await storage.getCachedEmbeddings(contentHashes);
					throwIfAborted(this.abortSignal, 'Indexing cancelled');

					// Find cache hits and misses
					const cacheHits = allChunksWithContext.filter(c =>
						cachedEmbeddings.has(c.chunk.contentHash),
					);
					const cacheMisses = allChunksWithContext.filter(
						c => !cachedEmbeddings.has(c.chunk.contentHash),
					);

					stats.embeddingsCached += cacheHits.length;
					chunksProcessed += cacheHits.length;
					emitEmbedProgress();

					// Process cache misses in batches
					if (cacheMisses.length > 0) {
						const CHUNK_BATCH_SIZE = 20;
						const isLocalProvider =
							embeddings instanceof LocalEmbeddingProvider;
						const BATCH_CONCURRENCY =
							isLocalProvider || config.embeddingProvider === 'mistral' ? 1 : 3;
						const batchLimit = pLimit(BATCH_CONCURRENCY);

						const batchTasks: Array<() => Promise<void>> = [];
						for (let i = 0; i < cacheMisses.length; i += CHUNK_BATCH_SIZE) {
							throwIfAborted(this.abortSignal, 'Indexing cancelled');
							const batchChunks = cacheMisses.slice(i, i + CHUNK_BATCH_SIZE);
							const batchStartProgress = chunksProcessed;

							batchTasks.push(async () => {
								let lastReportedWithinBatch = 0;

								const texts = batchChunks.map(c =>
									c.chunk.contextHeader
										? `${c.chunk.contextHeader}\n${c.chunk.text}`
										: c.chunk.text,
								);

								const chunkMetadata: ChunkMetadata[] = batchChunks.map(c => ({
									filepath: c.filepath,
									startLine: c.chunk.startLine,
									endLine: c.chunk.endLine,
									size: c.chunk.text.length,
								}));

								// Wire up per-chunk progress callback
								if ('onBatchProgress' in embeddings) {
									(
										embeddings as {
											onBatchProgress?: (p: number, t: number) => void;
										}
									).onBatchProgress = (processed, _total) => {
										if (this.suppressEvents) {
											return;
										}
										const delta = processed - lastReportedWithinBatch;
										if (delta > 0) {
											chunksProcessed += delta;
											lastReportedWithinBatch = processed;
											emitEmbedProgress();
										}
									};
								}

								const newEmbeddings = await embeddings.embed(texts, {
									chunkMetadata,
									logger: this.debugLogger,
									chunkOffset: batchStartProgress,
									signal: this.abortSignal ?? undefined,
								});
								const successfulEmbeddings = newEmbeddings.filter(
									(vector): vector is number[] => vector !== null,
								);
								stats.embeddingsComputed += successfulEmbeddings.length;

								// Clear callback
								if ('onBatchProgress' in embeddings) {
									(
										embeddings as {
											onBatchProgress?: (p: number, t: number) => void;
										}
									).onBatchProgress = undefined;
								}

								// Ensure progress is updated
								const remaining = batchChunks.length - lastReportedWithinBatch;
								if (remaining > 0) {
									chunksProcessed += remaining;
								}

								// Cache the new embeddings
								const cacheEntries: Array<{
									contentHash: string;
									vector: number[];
									createdAt: string;
								}> = [];
								batchChunks.forEach((c, idx) => {
									const vector = newEmbeddings[idx];
									if (!vector) {
										failedFilesThisRun.add(c.filepath);
										return;
									}
									cacheEntries.push({
										contentHash: c.chunk.contentHash,
										vector,
										createdAt: new Date().toISOString(),
									});
									cachedEmbeddings.set(c.chunk.contentHash, vector);
								});
								if (cacheEntries.length > 0) {
									await storage.cacheEmbeddings(cacheEntries);
								}

								emitEmbedProgress();
							});
						}

						await Promise.all(batchTasks.map(task => batchLimit(task)));
					}

					this.emitIndexProgress('persist', 'Writing index', 0, 0, null);
					throwIfAborted(this.abortSignal, 'Indexing cancelled');

					// Build CodeChunk objects and write to storage
					const allCodeChunks: CodeChunk[] = [];
					const idCounts = new Map<string, number>();
					for (const {chunk, filepath, fileHash} of allChunksWithContext) {
						const vector = cachedEmbeddings.get(chunk.contentHash);
						if (!vector) {
							failedFilesThisRun.add(filepath);
							continue;
						}
						const idBase = `${filepath}:${chunk.startLine}-${chunk.endLine}:${chunk.contentHash}`;
						const idCount = idCounts.get(idBase) ?? 0;
						idCounts.set(idBase, idCount + 1);
						const id = idCount === 0 ? idBase : `${idBase}:${idCount}`;
						allCodeChunks.push({
							id,
							vector,
							text: chunk.text,
							contentHash: chunk.contentHash,
							filepath,
							filename: path.basename(filepath),
							extension: path.extname(filepath),
							type: chunk.type,
							name: chunk.name,
							startLine: chunk.startLine,
							endLine: chunk.endLine,
							fileHash,
							signature: chunk.signature,
							docstring: chunk.docstring,
							isExported: chunk.isExported,
							decoratorNames: chunk.decoratorNames,
						});
					}

					if (forceReindex) {
						await storage.addChunks(allCodeChunks);
					} else {
						await storage.upsertChunks(allCodeChunks);
					}
					stats.chunksAdded += allCodeChunks.length;
				}
			}

			this.emitIndexProgress('finalize', 'Finalizing manifest', 0, 0, null);
			throwIfAborted(this.abortSignal, 'Indexing cancelled');

			// 7. Update manifest
			const chunkCount = await storage.countChunks();
			manifest = updateManifestTree(manifest, currentTree.toJSON());
			manifest = updateManifestStats(manifest, {
				totalFiles: currentTree.fileCount,
				totalChunks: chunkCount,
			});
			manifest.failedFiles = Array.from(failedFilesThisRun);
			manifest.failedBatches = failedBatches;

			await saveManifest(this.projectRoot, manifest);
			this.log(
				'info',
				`Index complete: ${stats.chunksAdded} chunks added, ${stats.chunksDeleted} deleted`,
			);

			// Emit complete event
			this.emit('complete', {
				stats: {
					filesProcessed: stats.filesScanned,
					chunksAdded: stats.chunksAdded,
					chunksDeleted: stats.chunksDeleted,
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
			this.log('error', 'Indexing failed', error as Error);
			this.emit('error', {
				error: error instanceof Error ? error : new Error(String(error)),
			});
			throw error;
		}
	}

	/**
	 * Wire slot progress callbacks from embedding provider to events.
	 */
	private wireSlotCallbacks(
		embeddings: EmbeddingProvider,
		onFailure?: (failure: BatchFailureInfo) => void,
	): void {
		const provider = embeddings as {
			onSlotProcessing?: (index: number, batchInfo: string) => void;
			onSlotRateLimited?: (
				index: number,
				batchInfo: string,
				retryInfo: string,
			) => void;
			onSlotIdle?: (index: number) => void;
			onSlotFailure?: (data: {
				batchInfo: string;
				files: string[];
				chunkCount: number;
				error: string;
				timestamp: string;
			}) => void;
			onResetSlots?: () => void;
		};

		if ('onSlotProcessing' in provider) {
			provider.onSlotProcessing = (slot, batchInfo) => {
				if (this.suppressEvents) {
					return;
				}
				this.emit('slot-processing', {slot, batchInfo});
			};
		}

		if ('onSlotRateLimited' in provider) {
			provider.onSlotRateLimited = (slot, batchInfo, retryInfo) => {
				if (this.suppressEvents) {
					return;
				}
				this.debugLogger.info('Indexer', 'Slot rate limited', {
					slot,
					batchInfo,
					retryInfo,
				});
				this.emit('slot-rate-limited', {slot, retryInfo});
			};
		}

		if ('onSlotIdle' in provider) {
			provider.onSlotIdle = slot => {
				if (this.suppressEvents) {
					return;
				}
				this.emit('slot-idle', {slot});
			};
		}

		if ('onSlotFailure' in provider) {
			provider.onSlotFailure = data => {
				if (this.suppressEvents) {
					return;
				}
				const failure: BatchFailureInfo = {
					batchInfo: data.batchInfo,
					files: data.files,
					chunkCount: data.chunkCount,
					error: data.error,
					timestamp: data.timestamp,
				};
				this.emit('slot-failure', {
					slot: 0, // Failure doesn't specify slot in current impl
					error: failure.error,
					batchInfo: failure.batchInfo,
					files: failure.files,
					chunkCount: failure.chunkCount,
				});
				onFailure?.(failure);
			};
		}

		if ('onResetSlots' in provider) {
			provider.onResetSlots = () => {
				if (this.suppressEvents) {
					return;
				}
				this.emit('slots-reset');
			};
		}
	}

	/**
	 * Create a diff that treats all files as new (for force reindex).
	 */
	private createForceDiff(tree: MerkleTree) {
		const allFiles: string[] = [];
		const serialized = tree.toJSON();
		this.collectAllFilesFromSerialized(serialized, allFiles);
		return {
			new: allFiles,
			modified: [],
			deleted: [],
			hasChanges: allFiles.length > 0,
		};
	}

	/**
	 * Recursively collect all file paths from a serialized Merkle tree node.
	 */
	private collectAllFilesFromSerialized(
		node: SerializedNode | null,
		files: string[],
	): void {
		if (!node) return;
		if (node.type === 'file') {
			files.push(node.path);
		} else if (node.children) {
			for (const child of Object.values(node.children)) {
				this.collectAllFilesFromSerialized(child, files);
			}
		}
	}

	/**
	 * Get a friendly name for the embedding provider.
	 */
	private getProviderDisplayName(provider: string): string {
		switch (provider) {
			case 'local':
				return 'Qwen3-0.6B';
			case 'gemini':
				return 'Gemini';
			case 'mistral':
				return 'Mistral';
			case 'openai':
				return 'OpenAI';
			default:
				return provider;
		}
	}

	/**
	 * Initialize all components.
	 */
	private async initialize(): Promise<void> {
		throwIfAborted(this.abortSignal, 'Indexing cancelled');
		// Load config
		this.config = await loadConfig(this.projectRoot);
		const providerName = this.getProviderDisplayName(
			this.config.embeddingProvider,
		);

		// Initialize storage (skip if provided externally)
		if (!this.storage) {
			this.emitIndexProgress('init', 'Connecting to database', 0, 0, null);
			this.storage = new Storage(
				this.projectRoot,
				this.config.embeddingDimensions,
			);
			await this.storage.connect();
		}
		throwIfAborted(this.abortSignal, 'Indexing cancelled');

		// Initialize chunker
		this.emitIndexProgress('init', 'Loading parsers', 0, 0, null);
		this.chunker = new Chunker();
		await this.chunker.initialize();
		throwIfAborted(this.abortSignal, 'Indexing cancelled');

		// Initialize embeddings
		const isLocal = this.config.embeddingProvider === 'local';
		this.emitIndexProgress(
			'init',
			isLocal
				? `Loading ${providerName} model`
				: `Connecting to ${providerName}`,
			0,
			0,
			null,
		);
		if (!this.embeddings) {
			this.embeddings = this.createEmbeddingProvider(this.config);
		}

		// Pass model progress to events for local models
		await this.embeddings.initialize(
			isLocal
				? (status, progress, _message) => {
						if (status === 'downloading') {
							this.emitIndexProgress(
								'init',
								`Downloading ${providerName}`,
								progress ?? 0,
								100,
								'percent',
							);
						} else if (status === 'loading') {
							this.emitIndexProgress(
								'init',
								`Loading ${providerName} model`,
								0,
								0,
								null,
							);
						}
					}
				: undefined,
		);
		throwIfAborted(this.abortSignal, 'Indexing cancelled');

		this.log('info', 'Indexer initialized');
	}

	/**
	 * Create the appropriate embedding provider based on config.
	 */
	private createEmbeddingProvider(config: ViberagConfig): EmbeddingProvider {
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

	/**
	 * Emit structured progress updates.
	 */
	private emitIndexProgress(
		phase: IndexingPhase,
		stage: string,
		current: number,
		total: number,
		unit: IndexingUnit | null,
	): void {
		if (this.suppressEvents) {
			return;
		}
		this.emit('progress', {phase, current, total, unit, stage});
	}

	/**
	 * Log a message.
	 */
	private log(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
		error?: Error,
	): void {
		if (!this.logger) return;
		if (level === 'error') {
			this.logger.error('Indexer', message, error);
		} else {
			this.logger[level]('Indexer', message);
		}
	}

	/**
	 * Close all resources.
	 */
	close(): void {
		this.suppressEvents = true;
		// Only close storage if we created it (not external)
		if (!this.externalStorage) {
			this.storage?.close();
		}
		this.chunker?.close();
		this.embeddings?.close();
		this.log('info', 'Indexer closed');
	}
}
