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
import {
	loadManifest,
	saveManifest,
	manifestExists,
	createEmptyManifest,
	updateManifestStats,
	updateManifestTree,
} from '../lib/manifest.js';
import {MerkleTree} from '../lib/merkle/index.js';
import type {SerializedNode} from '../lib/merkle/node.js';
import {Storage} from './storage/index.js';
import type {CodeChunk} from './storage/types.js';
import {Chunker} from '../lib/chunker/index.js';
import {TypedEmitter, type IndexingEvents, type SlotEvents} from './types.js';

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

	constructor(projectRoot: string, options?: IndexingServiceOptions | Logger) {
		super();
		this.projectRoot = projectRoot;
		this.debugLogger = createServiceLogger(projectRoot, 'indexer');

		// Handle both old (logger) and new (options) signatures for backward compatibility
		if (
			options &&
			typeof options === 'object' &&
			('logger' in options || 'storage' in options || 'embeddings' in options)
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
		const failedFilesThisRun = new Set<string>();
		const failedBatches: BatchFailureInfo[] = [];

		// Emit start event
		this.emit('start');
		this.emit('slots-reset');

		try {
			// Initialize components
			await this.initialize();

			const config = this.config!;
			const storage = this.storage!;
			const chunker = this.chunker!;
			const embeddings = this.embeddings!;

			// 1. Load previous manifest and Merkle tree
			this.log('info', 'Loading manifest');
			let manifest = (await manifestExists(this.projectRoot))
				? await loadManifest(this.projectRoot)
				: createEmptyManifest();

			const previousTree = manifest.tree
				? MerkleTree.fromJSON(manifest.tree as SerializedNode)
				: MerkleTree.empty();

			// 2. Build current Merkle tree from filesystem
			this.log('info', 'Building Merkle tree');
			this.emit('progress', {current: 0, total: 100, stage: 'Scanning files'});

			const currentTree = await MerkleTree.build(
				this.projectRoot,
				config.extensions,
				config.excludePatterns,
				previousTree,
			);

			stats.filesScanned = currentTree.buildStats.filesScanned;
			this.log(
				'info',
				`Scanned ${stats.filesScanned} files, indexed ${currentTree.fileCount}`,
			);

			// 3. Compare trees to get diff
			const diff = force
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
			if (!diff.hasChanges && !force && !hasFailuresToRetry) {
				if (hasStaleFailures) {
					manifest.failedFiles = failedFilesToRetry;
					manifest.failedBatches = [];
					await saveManifest(this.projectRoot, manifest);
				}
				this.log('info', 'No changes detected');
				this.emit('complete', {
					stats: {
						filesProcessed: stats.filesScanned,
						chunksAdded: 0,
						chunksDeleted: 0,
						chunksUnchanged: 0,
						durationMs: 0,
					},
				});
				return stats;
			}

			// 4. Handle force reindex - drop and recreate table
			if (force) {
				this.log('info', 'Force reindex: resetting chunks table');
				await storage.resetChunksTable();
			}

			// 5. Delete chunks for deleted files
			if (diff.deleted.length > 0) {
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
				this.log('info', `Processing ${filesToProcess.length} files`);

				// Delete existing chunks for modified + previously failed files
				const filesToDelete = Array.from(
					new Set([...diff.modified, ...failedFilesToRetry]),
				);
				if (filesToDelete.length > 0 && !force) {
					const deletedCount =
						await storage.deleteChunksByFilepaths(filesToDelete);
					stats.chunksDeleted += deletedCount;
				}

				// Phase 1: Collect all chunks
				this.emit('progress', {current: 0, total: 0, stage: 'Scanning files'});

				const {computeStringHash} = await import('../lib/merkle/hash.js');

				type ChunkWithContext = {
					chunk: Awaited<ReturnType<typeof chunker.chunkFile>>[0];
					filepath: string;
					fileHash: string;
				};
				const allChunksWithContext: ChunkWithContext[] = [];

				for (const filepath of filesToProcess) {
					const absolutePath = path.join(this.projectRoot, filepath);
					try {
						const content = await fs.readFile(absolutePath, 'utf-8');
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
						continue;
					}
				}

				const totalChunks = allChunksWithContext.length;
				this.log(
					'info',
					`Collected ${totalChunks} chunks from ${filesToProcess.length} files`,
				);

				// Phase 2: Embed chunks
				if (totalChunks > 0) {
					let chunksProcessed = 0;

					// Emit progress helper
					const emitProgress = () => {
						this.emit('progress', {
							current: chunksProcessed,
							total: totalChunks,
							stage: 'Indexing files',
						});
						this.emit('chunk-progress', {chunksProcessed});
					};

					// Wire throttle callback for rate limit feedback
					if ('onThrottle' in embeddings) {
						(
							embeddings as {onThrottle?: (msg: string | null) => void}
						).onThrottle = message => {
							if (message) {
								this.emit('throttle', {message});
							}
						};
					}

					// Wire slot progress callbacks for API providers
					this.wireSlotCallbacks(embeddings, failure => {
						failedBatches.push(failure);
					});

					// Initialize progress display
					emitProgress();

					// Check embedding cache
					const contentHashes = allChunksWithContext.map(
						c => c.chunk.contentHash,
					);
					const cachedEmbeddings =
						await storage.getCachedEmbeddings(contentHashes);

					// Find cache hits and misses
					const cacheHits = allChunksWithContext.filter(c =>
						cachedEmbeddings.has(c.chunk.contentHash),
					);
					const cacheMisses = allChunksWithContext.filter(
						c => !cachedEmbeddings.has(c.chunk.contentHash),
					);

					stats.embeddingsCached += cacheHits.length;
					chunksProcessed += cacheHits.length;
					emitProgress();

					// Process cache misses in batches
					if (cacheMisses.length > 0) {
						const CHUNK_BATCH_SIZE = 20;
						const isLocalProvider =
							embeddings instanceof LocalEmbeddingProvider;
						const BATCH_CONCURRENCY = isLocalProvider ? 1 : 3;
						const batchLimit = pLimit(BATCH_CONCURRENCY);

						const batchTasks: Array<() => Promise<void>> = [];
						for (let i = 0; i < cacheMisses.length; i += CHUNK_BATCH_SIZE) {
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
										const delta = processed - lastReportedWithinBatch;
										if (delta > 0) {
											chunksProcessed += delta;
											lastReportedWithinBatch = processed;
											emitProgress();
										}
									};
								}

								const newEmbeddings = await embeddings.embed(texts, {
									chunkMetadata,
									logger: this.debugLogger,
									chunkOffset: batchStartProgress,
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

								emitProgress();
							});
						}

						await Promise.all(batchTasks.map(task => batchLimit(task)));
					}

					// Build CodeChunk objects and write to storage
					const allCodeChunks: CodeChunk[] = [];
					for (const {chunk, filepath, fileHash} of allChunksWithContext) {
						const vector = cachedEmbeddings.get(chunk.contentHash);
						if (!vector) {
							failedFilesThisRun.add(filepath);
							continue;
						}
						allCodeChunks.push({
							id: `${filepath}:${chunk.startLine}`,
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

					if (force) {
						await storage.addChunks(allCodeChunks);
					} else {
						await storage.upsertChunks(allCodeChunks);
					}
					stats.chunksAdded += allCodeChunks.length;
				}
			}

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
					durationMs: 0,
				},
			});

			return stats;
		} catch (error) {
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
				this.emit('slot-processing', {slot, batchInfo});
			};
		}

		if ('onSlotRateLimited' in provider) {
			provider.onSlotRateLimited = (slot, _batchInfo, retryInfo) => {
				this.emit('slot-rate-limited', {slot, retryInfo});
			};
		}

		if ('onSlotIdle' in provider) {
			provider.onSlotIdle = slot => {
				this.emit('slot-idle', {slot});
			};
		}

		if ('onSlotFailure' in provider) {
			provider.onSlotFailure = data => {
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
		// Load config
		this.config = await loadConfig(this.projectRoot);
		const providerName = this.getProviderDisplayName(
			this.config.embeddingProvider,
		);

		// Initialize storage (skip if provided externally)
		if (!this.storage) {
			this.emit('progress', {
				current: 0,
				total: 0,
				stage: 'Connecting to database',
			});
			this.storage = new Storage(
				this.projectRoot,
				this.config.embeddingDimensions,
			);
			await this.storage.connect();
		}

		// Initialize chunker
		this.emit('progress', {current: 0, total: 0, stage: 'Loading parsers'});
		this.chunker = new Chunker();
		await this.chunker.initialize();

		// Initialize embeddings
		const isLocal = this.config.embeddingProvider === 'local';
		this.emit('progress', {
			current: 0,
			total: 0,
			stage: isLocal
				? `Loading ${providerName} model`
				: `Connecting to ${providerName}`,
		});
		if (!this.embeddings) {
			this.embeddings = this.createEmbeddingProvider(this.config);
		}

		// Pass model progress to events for local models
		await this.embeddings.initialize(
			isLocal
				? (status, progress, _message) => {
						if (status === 'downloading') {
							const stage = `Downloading ${providerName} (${progress}%)`;
							this.emit('progress', {
								current: progress ?? 0,
								total: 100,
								stage,
							});
						} else if (status === 'loading') {
							this.emit('progress', {
								current: 0,
								total: 0,
								stage: `Loading ${providerName} model`,
							});
						}
					}
				: undefined,
		);

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
		// Only close storage if we created it (not external)
		if (!this.externalStorage) {
			this.storage?.close();
		}
		this.chunker?.close();
		this.embeddings?.close();
		this.log('info', 'Indexer closed');
	}
}
