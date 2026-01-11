/**
 * Indexer - Orchestrates the full indexing pipeline.
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
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig, type ViberagConfig} from '../config/index.js';
import {
	GeminiEmbeddingProvider,
	Local4BEmbeddingProvider,
	LocalEmbeddingProvider,
	MistralEmbeddingProvider,
	OpenAIEmbeddingProvider,
	type EmbeddingProvider,
	type ChunkMetadata,
} from '../embeddings/index.js';
import {createDebugLogger, type Logger} from '../logger/index.js';
import {
	loadManifest,
	saveManifest,
	manifestExists,
	createEmptyManifest,
	updateManifestStats,
	updateManifestTree,
} from '../manifest/index.js';
import {MerkleTree, type SerializedNode} from '../merkle/index.js';
import {Storage, type CodeChunk} from '../storage/index.js';
import {Chunker} from './chunker.js';
import {
	createEmptyIndexStats,
	type IndexStats,
	type ProgressCallback,
} from './types.js';
import {
	store,
	IndexingActions,
	SlotProgressActions,
} from '../../store/index.js';
import pLimit from 'p-limit';

/**
 * Module-level mutex to prevent concurrent indexing across all Indexer instances.
 * This is necessary because watcher and CLI create separate Indexer instances,
 * and we need to prevent them from racing on manifest/storage operations.
 */
let globalIndexPromise: Promise<IndexStats> | null = null;

/**
 * Options for the index operation.
 */
export interface IndexOptions {
	/** Force full reindex, ignoring Merkle tree diff */
	force?: boolean;
	/** Progress callback for UI updates */
	progressCallback?: ProgressCallback;
}

/**
 * Indexer class for orchestrating the full indexing pipeline.
 */
export class Indexer {
	private readonly projectRoot: string;
	private config: ViberagConfig | null = null;
	private storage: Storage | null = null;
	private chunker: Chunker | null = null;
	private embeddings: EmbeddingProvider | null = null;
	private logger: Logger | null = null;
	/** Debug logger for detailed failure logging to .viberag/debug.log */
	private debugLogger: Logger;

	constructor(projectRoot: string, logger?: Logger) {
		this.projectRoot = projectRoot;
		this.logger = logger ?? null;
		this.debugLogger = createDebugLogger(projectRoot);
	}

	/**
	 * Run the indexing pipeline.
	 * Uses global mutex to prevent concurrent index operations across all instances.
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
		const {force = false, progressCallback} = options;

		// Dispatch to Redux: start indexing
		store.dispatch(IndexingActions.start());
		store.dispatch(SlotProgressActions.clearFailures());

		try {
			// Initialize components
			await this.initialize(progressCallback);

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
			store.dispatch(
				IndexingActions.setProgress({
					current: 0,
					total: 100,
					stage: 'Scanning files',
				}),
			);
			progressCallback?.(0, 100, 'Scanning files');

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

			// Short-circuit if no changes
			if (!diff.hasChanges && !force) {
				this.log('info', 'No changes detected');
				return stats;
			}

			// 4. Handle force reindex - drop and recreate table to avoid schema issues
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

			// 6. Process new and modified files in two phases:
			// Phase 1: Scan + Chunk all files upfront (spinner only)
			// Phase 2: Embed chunks with fixed denominator (chunk-based progress)
			const filesToProcess = [...diff.new, ...diff.modified];

			if (filesToProcess.length > 0) {
				this.log('info', `Processing ${filesToProcess.length} files`);

				// First, delete existing chunks for modified files
				if (diff.modified.length > 0 && !force) {
					const deletedCount = await storage.deleteChunksByFilepaths(
						diff.modified,
					);
					stats.chunksDeleted += deletedCount;
				}

				// ================================================================
				// PHASE 1: Collect all chunks (spinner only - no progress bar)
				// ================================================================
				store.dispatch(
					IndexingActions.setProgress({
						current: 0,
						total: 0, // 0/0 = spinner only
						stage: 'Scanning files',
					}),
				);
				progressCallback?.(0, 0, 'Scanning files');

				// Import hash function once
				const {computeStringHash} = await import('../merkle/hash.js');

				// Chunk type with context for Phase 2
				type ChunkWithContext = {
					chunk: Awaited<ReturnType<typeof chunker.chunkFile>>[0];
					filepath: string;
					fileHash: string;
				};
				const allChunksWithContext: ChunkWithContext[] = [];

				// Read and chunk all files sequentially (tree-sitter has global state)
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
						continue;
					}
				}

				const totalChunks = allChunksWithContext.length;
				this.log(
					'info',
					`Collected ${totalChunks} chunks from ${filesToProcess.length} files`,
				);

				// ================================================================
				// PHASE 2: Embed chunks with fixed denominator (chunk-based progress)
				// ================================================================
				if (totalChunks > 0) {
					// Progress state for embedding phase
					const progressState = {
						current: 0,
						total: totalChunks,
						stage: 'Indexing files',
						throttleMessage: null as string | null,
						chunksProcessed: 0,
					};

					// Emit progress to both Redux and callback
					const emitProgress = () => {
						store.dispatch(
							IndexingActions.setProgress({
								current: progressState.chunksProcessed,
								total: progressState.total,
								stage: progressState.stage,
								chunksProcessed: progressState.chunksProcessed,
							}),
						);
						progressCallback?.(
							progressState.chunksProcessed,
							progressState.total,
							progressState.stage,
							progressState.throttleMessage,
							progressState.chunksProcessed,
						);
					};

					// Wire throttle callback for rate limit feedback (API providers only)
					if ('onThrottle' in embeddings) {
						(
							embeddings as {onThrottle?: (msg: string | null) => void}
						).onThrottle = message => {
							progressState.throttleMessage = message;
							store.dispatch(IndexingActions.setThrottle(message));
							emitProgress();
						};
					}

					// Initialize progress display
					emitProgress();

					// Check embedding cache for ALL chunks at once
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

					// Update progress for cached chunks (they're "done")
					progressState.chunksProcessed += cacheHits.length;
					emitProgress();

					// Process cache misses in batches
					if (cacheMisses.length > 0) {
						// Smaller batches for more frequent progress updates
						const CHUNK_BATCH_SIZE = 20;
						// Local providers run serially to avoid race conditions with shared
						// progress callback. They have internal parallelism anyway.
						const isLocalProvider =
							embeddings instanceof LocalEmbeddingProvider ||
							embeddings instanceof Local4BEmbeddingProvider;
						const BATCH_CONCURRENCY = isLocalProvider ? 1 : 3;
						const batchLimit = pLimit(BATCH_CONCURRENCY);
						const totalBatches = Math.ceil(
							cacheMisses.length / CHUNK_BATCH_SIZE,
						);

						const batchTasks: Array<() => Promise<void>> = [];
						for (let i = 0; i < cacheMisses.length; i += CHUNK_BATCH_SIZE) {
							const batchIndex = Math.floor(i / CHUNK_BATCH_SIZE);
							const batchChunks = cacheMisses.slice(i, i + CHUNK_BATCH_SIZE);
							const batchStartProgress = progressState.chunksProcessed;

							batchTasks.push(async () => {
								// Track progress within this batch for fine-grained updates
								// Each batch has its own tracker to avoid race conditions
								let lastReportedWithinBatch = 0;

								// Build texts for embedding
								const texts = batchChunks.map(c =>
									c.chunk.contextHeader
										? `${c.chunk.contextHeader}\n${c.chunk.text}`
										: c.chunk.text,
								);

								// Build metadata for failure logging
								const chunkMetadata: ChunkMetadata[] = batchChunks.map(c => ({
									filepath: c.filepath,
									startLine: c.chunk.startLine,
									endLine: c.chunk.endLine,
									size: c.chunk.text.length,
								}));

								// Wire up per-chunk progress callback for local/API providers
								if ('onBatchProgress' in embeddings) {
									(
										embeddings as {
											onBatchProgress?: (p: number, t: number) => void;
										}
									).onBatchProgress = (processed, _total) => {
										const delta = processed - lastReportedWithinBatch;
										if (delta > 0) {
											progressState.chunksProcessed += delta;
											lastReportedWithinBatch = processed;
											emitProgress();
										}
									};
								}

								// Embed the batch
								const newEmbeddings = await embeddings.embed(texts, {
									chunkMetadata,
									logger: this.debugLogger,
									chunkOffset: batchStartProgress,
								});
								stats.embeddingsComputed += batchChunks.length;

								// Clear callback
								if ('onBatchProgress' in embeddings) {
									(
										embeddings as {
											onBatchProgress?: (p: number, t: number) => void;
										}
									).onBatchProgress = undefined;
								}

								// Ensure progress is updated for any chunks not reported via callback
								const remaining = batchChunks.length - lastReportedWithinBatch;
								if (remaining > 0) {
									progressState.chunksProcessed += remaining;
								}

								// Cache the new embeddings
								const cacheEntries = batchChunks.map((c, idx) => ({
									contentHash: c.chunk.contentHash,
									vector: newEmbeddings[idx]!,
									createdAt: new Date().toISOString(),
								}));
								await storage.cacheEmbeddings(cacheEntries);

								// Add to cachedEmbeddings map for later use
								batchChunks.forEach((c, idx) => {
									cachedEmbeddings.set(
										c.chunk.contentHash,
										newEmbeddings[idx]!,
									);
								});

								// Update batch progress display
								store.dispatch(
									IndexingActions.setBatchProgress({
										currentBatch: batchIndex + 1,
										totalBatches,
										chunkStart: i + 1,
										chunkEnd: i + batchChunks.length,
									}),
								);
								emitProgress();

								this.log(
									'debug',
									`Batch ${batchIndex + 1}/${totalBatches}: embedded ${batchChunks.length} chunks`,
								);
							});
						}

						// Execute batches with limited concurrency
						await Promise.all(batchTasks.map(task => batchLimit(task)));
					}

					// Build CodeChunk objects and write to storage
					const allCodeChunks: CodeChunk[] = [];
					for (const {chunk, filepath, fileHash} of allChunksWithContext) {
						const vector = cachedEmbeddings.get(chunk.contentHash)!;
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

					// Write all chunks to storage
					if (force) {
						await storage.addChunks(allCodeChunks);
					} else {
						await storage.upsertChunks(allCodeChunks);
					}
					stats.chunksAdded += allCodeChunks.length;
				}
			}

			// 7. Update manifest with new tree and stats
			const chunkCount = await storage.countChunks();
			manifest = updateManifestTree(manifest, currentTree.toJSON());
			manifest = updateManifestStats(manifest, {
				totalFiles: currentTree.fileCount,
				totalChunks: chunkCount,
			});

			await saveManifest(this.projectRoot, manifest);
			this.log(
				'info',
				`Index complete: ${stats.chunksAdded} chunks added, ${stats.chunksDeleted} deleted`,
			);

			return stats;
		} catch (error) {
			this.log('error', 'Indexing failed', error as Error);
			// Dispatch to Redux: indexing failed
			store.dispatch(
				IndexingActions.fail(
					error instanceof Error ? error.message : String(error),
				),
			);
			throw error;
		} finally {
			// Guarantee completion dispatch on all non-error exits.
			// This handles both normal completion and early returns (e.g., no changes detected).
			const currentStatus = store.getState().indexing.status;
			if (currentStatus !== 'error') {
				store.dispatch(IndexingActions.complete());
			}
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
	private async initialize(progressCallback?: ProgressCallback): Promise<void> {
		// Helper to dispatch stage update to both Redux and callback
		const setStage = (stage: string) => {
			store.dispatch(
				IndexingActions.setProgress({current: 0, total: 0, stage}),
			);
			progressCallback?.(0, 0, stage);
		};

		// Load config
		this.config = await loadConfig(this.projectRoot);
		const providerName = this.getProviderDisplayName(
			this.config.embeddingProvider,
		);

		// Initialize storage
		setStage('Connecting to database');
		this.storage = new Storage(
			this.projectRoot,
			this.config.embeddingDimensions,
		);
		await this.storage.connect();

		// Initialize chunker (loads tree-sitter parsers)
		setStage('Loading parsers');
		this.chunker = new Chunker();
		await this.chunker.initialize();

		// Initialize embeddings based on provider type
		// For local models, this may download the model on first run
		const isLocal = this.config.embeddingProvider === 'local';
		setStage(
			isLocal
				? `Loading ${providerName} model`
				: `Connecting to ${providerName}`,
		);
		this.embeddings = this.createEmbeddingProvider(this.config);

		// Pass model progress to the UI for local models
		await this.embeddings.initialize(
			isLocal
				? (status, progress, _message) => {
						if (status === 'downloading') {
							const stage = `Downloading ${providerName} (${progress}%)`;
							store.dispatch(
								IndexingActions.setProgress({
									current: progress ?? 0,
									total: 100,
									stage,
								}),
							);
							progressCallback?.(progress ?? 0, 100, stage);
						} else if (status === 'loading') {
							setStage(`Loading ${providerName} model`);
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
			case 'local-4b':
				return new Local4BEmbeddingProvider();
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
		this.storage?.close();
		this.chunker?.close();
		this.embeddings?.close();
		this.log('info', 'Indexer closed');
	}
}
