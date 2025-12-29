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

	constructor(projectRoot: string, logger?: Logger) {
		this.projectRoot = projectRoot;
		this.logger = logger ?? null;
	}

	/**
	 * Run the indexing pipeline.
	 */
	async index(options: IndexOptions = {}): Promise<IndexStats> {
		const stats = createEmptyIndexStats();
		const {force = false, progressCallback} = options;

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
					progressCallback?.(i + batch.length, totalFiles, 'Indexing files');
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
	 */
	private async processFileBatch(
		filepaths: string[],
		chunker: Chunker,
		embeddings: EmbeddingProvider,
		storage: Storage,
		stats: IndexStats,
	): Promise<CodeChunk[]> {
		const allChunks: CodeChunk[] = [];

		for (const filepath of filepaths) {
			try {
				const absolutePath = path.join(this.projectRoot, filepath);
				const content = await fs.readFile(absolutePath, 'utf-8');
				const fileHash = (await import('../merkle/hash.js')).computeStringHash(
					content,
				);

				// Chunk the file (with size limits from config)
				const chunks = await chunker.chunkFile(
					filepath,
					content,
					this.config!.chunkMaxSize,
				);

				// Check embedding cache for each chunk
				const contentHashes = chunks.map(c => c.contentHash);
				const cachedEmbeddings = await storage.getCachedEmbeddings(
					contentHashes,
				);

				// Compute embeddings for cache misses
				const missingChunks = chunks.filter(
					c => !cachedEmbeddings.has(c.contentHash),
				);

				if (missingChunks.length > 0) {
					// Embed contextHeader + text for semantic relevance
					const texts = missingChunks.map(c =>
						c.contextHeader ? `${c.contextHeader}\n${c.text}` : c.text,
					);
					const newEmbeddings = await embeddings.embed(texts);
					stats.embeddingsComputed += missingChunks.length;

					// Cache the new embeddings
					const cacheEntries = missingChunks.map((chunk, i) => ({
						contentHash: chunk.contentHash,
						vector: newEmbeddings[i]!,
						createdAt: new Date().toISOString(),
					}));
					await storage.cacheEmbeddings(cacheEntries);

					// Add to cachedEmbeddings map
					missingChunks.forEach((chunk, i) => {
						cachedEmbeddings.set(chunk.contentHash, newEmbeddings[i]!);
					});
				}

				stats.embeddingsCached += chunks.length - missingChunks.length;

				// Build CodeChunk objects
				const filename = path.basename(filepath);
				const extension = path.extname(filepath);

				for (const chunk of chunks) {
					const vector = cachedEmbeddings.get(chunk.contentHash)!;
					allChunks.push({
						id: `${filepath}:${chunk.startLine}`,
						vector,
						text: chunk.text,
						contentHash: chunk.contentHash,
						filepath,
						filename,
						extension,
						type: chunk.type,
						name: chunk.name,
						startLine: chunk.startLine,
						endLine: chunk.endLine,
						fileHash,
						// New metadata fields from schema v2
						signature: chunk.signature,
						docstring: chunk.docstring,
						isExported: chunk.isExported,
						decoratorNames: chunk.decoratorNames,
					});
				}
			} catch (error) {
				this.log('warn', `Failed to process file: ${filepath}`, error as Error);
				// Continue with other files
			}
		}

		return allChunks;
	}

	/**
	 * Initialize all components.
	 */
	private async initialize(): Promise<void> {
		// Load config
		this.config = await loadConfig(this.projectRoot);

		// Initialize storage
		this.storage = new Storage(
			this.projectRoot,
			this.config.embeddingDimensions,
		);
		await this.storage.connect();

		// Initialize chunker
		this.chunker = new Chunker();
		await this.chunker.initialize();

		// Initialize embeddings based on provider type
		this.embeddings = this.createEmbeddingProvider(this.config);
		await this.embeddings.initialize();

		this.log('info', 'Indexer initialized');
	}

	/**
	 * Create the appropriate embedding provider based on config.
	 */
	private createEmbeddingProvider(config: ViberagConfig): EmbeddingProvider {
		switch (config.embeddingProvider) {
			case 'gemini':
				return new GeminiEmbeddingProvider();
			case 'mistral':
				return new MistralEmbeddingProvider();
			case 'openai':
				return new OpenAIEmbeddingProvider();
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
