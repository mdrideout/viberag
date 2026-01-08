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
} from '../embeddings/index.js';
import type {Logger} from '../logger/index.js';
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
	private indexPromise: Promise<IndexStats> | null = null;

	constructor(projectRoot: string, logger?: Logger) {
		this.projectRoot = projectRoot;
		this.logger = logger ?? null;
	}

	/**
	 * Run the indexing pipeline.
	 * Uses mutex to prevent concurrent index operations.
	 */
	async index(options: IndexOptions = {}): Promise<IndexStats> {
		// If indexing is already in progress, wait for it
		if (this.indexPromise) {
			this.log('warn', 'Index already in progress, waiting for completion');
			return this.indexPromise;
		}

		this.indexPromise = this.doIndex(options);
		try {
			return await this.indexPromise;
		} finally {
			this.indexPromise = null;
		}
	}

	/**
	 * Perform the actual indexing operation.
	 */
	private async doIndex(options: IndexOptions = {}): Promise<IndexStats> {
		const stats = createEmptyIndexStats();
		const {force = false, progressCallback} = options;

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

			// 6. Process new and modified files
			const filesToProcess = [...diff.new, ...diff.modified];
			const totalFiles = filesToProcess.length;

			// Track cumulative chunks for progress display
			let totalChunksProcessed = 0;
			let lastProgress = 0;

			// Wire throttle callback for rate limit feedback (API providers only)
			if ('onThrottle' in embeddings) {
				(embeddings as {onThrottle?: (msg: string | null) => void}).onThrottle =
					message => {
						// Pass throttle message to UI - shown in yellow when set
						progressCallback?.(
							lastProgress,
							totalFiles,
							'Indexing files',
							message,
							totalChunksProcessed,
						);
					};
			}

			if (totalFiles > 0) {
				this.log('info', `Processing ${totalFiles} files`);

				// First, delete existing chunks for modified files
				if (diff.modified.length > 0 && !force) {
					const deletedCount = await storage.deleteChunksByFilepaths(
						diff.modified,
					);
					stats.chunksDeleted += deletedCount;
				}

				// Process files in batches
				const batchSize = 10;
				for (let i = 0; i < filesToProcess.length; i += batchSize) {
					const batch = filesToProcess.slice(i, i + batchSize);
					const batchChunks = await this.processFileBatch(
						batch,
						chunker,
						embeddings,
						storage,
						stats,
						{
							totalFiles,
							currentFileOffset: i,
							progressCallback,
							onChunksProcessed: (count: number) => {
								totalChunksProcessed += count;
								progressCallback?.(
									i,
									totalFiles,
									'Indexing files',
									null,
									totalChunksProcessed,
								);
							},
						},
					);

					if (batchChunks.length > 0) {
						// Use addChunks after table reset to avoid schema mismatch,
						// upsertChunks for normal incremental updates
						if (force) {
							await storage.addChunks(batchChunks);
						} else {
							await storage.upsertChunks(batchChunks);
						}
						stats.chunksAdded += batchChunks.length;
					}

					const progress = Math.round(((i + batch.length) / totalFiles) * 100);
					lastProgress = i + batch.length;
					progressCallback?.(
						i + batch.length,
						totalFiles,
						'Indexing files',
						null,
						totalChunksProcessed,
					);
					this.log(
						'debug',
						`Progress: ${progress}% (${i + batch.length}/${totalFiles})`,
					);
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
			throw error;
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
	 * Process a batch of files: read, chunk, embed, and prepare CodeChunks.
	 *
	 * Strategy: Collect all chunks from all files first, then embed them
	 * together with full concurrency for maximum throughput.
	 *
	 * Error handling strategy:
	 * - File read/parse errors: Log and continue (file-specific, recoverable)
	 * - Embedding/storage errors: Let propagate (fatal, affects all files)
	 */
	private async processFileBatch(
		filepaths: string[],
		chunker: Chunker,
		embeddings: EmbeddingProvider,
		storage: Storage,
		stats: IndexStats,
		progressContext?: {
			totalFiles: number;
			currentFileOffset: number;
			progressCallback?: ProgressCallback;
			onChunksProcessed?: (count: number) => void;
		},
	): Promise<CodeChunk[]> {
		// Phase 1: Read and chunk ALL files first (collect everything)
		type FileData = {
			filepath: string;
			fileHash: string;
			chunks: Awaited<ReturnType<typeof chunker.chunkFile>>;
		};
		const fileDataList: FileData[] = [];

		for (const filepath of filepaths) {
			try {
				const absolutePath = path.join(this.projectRoot, filepath);
				const content = await fs.readFile(absolutePath, 'utf-8');
				const fileHash = (await import('../merkle/hash.js')).computeStringHash(
					content,
				);
				const chunks = await chunker.chunkFile(
					filepath,
					content,
					this.config!.chunkMaxSize,
				);
				fileDataList.push({filepath, fileHash, chunks});
			} catch (error) {
				this.log(
					'warn',
					`Failed to read/parse file: ${filepath}`,
					error as Error,
				);
				continue;
			}
		}

		// Collect all chunks with their file context
		type ChunkWithContext = {
			chunk: Awaited<ReturnType<typeof chunker.chunkFile>>[0];
			filepath: string;
			fileHash: string;
		};
		const allChunksWithContext: ChunkWithContext[] = [];
		for (const fd of fileDataList) {
			for (const chunk of fd.chunks) {
				allChunksWithContext.push({
					chunk,
					filepath: fd.filepath,
					fileHash: fd.fileHash,
				});
			}
		}

		if (allChunksWithContext.length === 0) {
			return [];
		}

		// Phase 2: Check embedding cache for ALL chunks at once
		const contentHashes = allChunksWithContext.map(c => c.chunk.contentHash);
		const cachedEmbeddings = await storage.getCachedEmbeddings(contentHashes);

		// Find all cache misses
		const missingChunksWithContext = allChunksWithContext.filter(
			c => !cachedEmbeddings.has(c.chunk.contentHash),
		);

		stats.embeddingsCached +=
			allChunksWithContext.length - missingChunksWithContext.length;

		// Phase 3: Embed ALL missing chunks together (with full concurrency)
		if (missingChunksWithContext.length > 0) {
			// Track chunks processed for progress updates
			let lastReportedChunks = 0;

			// Wire batch progress callback to report incremental chunks
			if (
				progressContext?.onChunksProcessed &&
				'onBatchProgress' in embeddings
			) {
				(
					embeddings as {onBatchProgress?: (p: number, t: number) => void}
				).onBatchProgress = (processed, _total) => {
					// Report only the delta since last update
					const delta = processed - lastReportedChunks;
					if (delta > 0) {
						progressContext.onChunksProcessed!(delta);
						lastReportedChunks = processed;
					}
				};
			}

			// Embed all chunks together
			const texts = missingChunksWithContext.map(c =>
				c.chunk.contextHeader
					? `${c.chunk.contextHeader}\n${c.chunk.text}`
					: c.chunk.text,
			);
			const newEmbeddings = await embeddings.embed(texts);
			stats.embeddingsComputed += missingChunksWithContext.length;

			// Report any remaining chunks not yet reported
			const remainingDelta =
				missingChunksWithContext.length - lastReportedChunks;
			if (remainingDelta > 0 && progressContext?.onChunksProcessed) {
				progressContext.onChunksProcessed(remainingDelta);
			}

			// Clear batch progress callback
			if ('onBatchProgress' in embeddings) {
				(
					embeddings as {onBatchProgress?: (p: number, t: number) => void}
				).onBatchProgress = undefined;
			}

			// Cache the new embeddings
			const cacheEntries = missingChunksWithContext.map((c, i) => ({
				contentHash: c.chunk.contentHash,
				vector: newEmbeddings[i]!,
				createdAt: new Date().toISOString(),
			}));
			await storage.cacheEmbeddings(cacheEntries);

			// Add to cachedEmbeddings map
			missingChunksWithContext.forEach((c, i) => {
				cachedEmbeddings.set(c.chunk.contentHash, newEmbeddings[i]!);
			});
		}

		// Phase 4: Build CodeChunk objects
		const allChunks: CodeChunk[] = [];
		for (const {chunk, filepath, fileHash} of allChunksWithContext) {
			const vector = cachedEmbeddings.get(chunk.contentHash)!;
			allChunks.push({
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

		return allChunks;
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
		// Load config
		this.config = await loadConfig(this.projectRoot);
		const providerName = this.getProviderDisplayName(
			this.config.embeddingProvider,
		);

		// Initialize storage
		progressCallback?.(0, 0, 'Connecting to database');
		this.storage = new Storage(
			this.projectRoot,
			this.config.embeddingDimensions,
		);
		await this.storage.connect();

		// Initialize chunker (loads tree-sitter parsers)
		progressCallback?.(0, 0, 'Loading parsers');
		this.chunker = new Chunker();
		await this.chunker.initialize();

		// Initialize embeddings based on provider type
		// For local models, this may download the model on first run
		const isLocal = this.config.embeddingProvider === 'local';
		progressCallback?.(
			0,
			0,
			isLocal
				? `Loading ${providerName} model`
				: `Connecting to ${providerName}`,
		);
		this.embeddings = this.createEmbeddingProvider(this.config);

		// Pass model progress to the UI for local models
		await this.embeddings.initialize(
			isLocal && progressCallback
				? (status, progress, _message) => {
						if (status === 'downloading') {
							progressCallback(
								progress ?? 0,
								100,
								`Downloading ${providerName} (${progress}%)`,
							);
						} else if (status === 'loading') {
							progressCallback(0, 0, `Loading ${providerName} model`);
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
