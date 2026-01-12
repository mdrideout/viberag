/**
 * Storage service wrapping LanceDB for code chunks and embedding cache.
 *
 * Provides a clean API for storing and retrieving code chunks with their
 * embeddings, plus a content-addressed embedding cache.
 */

import * as lancedb from '@lancedb/lancedb';
import {makeArrowTable} from '@lancedb/lancedb';
import type {Connection, Table} from '@lancedb/lancedb';
import {getLanceDbPath, TABLE_NAMES} from '../../lib/constants.js';
import {createCodeChunksSchema, createEmbeddingCacheSchema} from './schema.js';
import {
	chunkToRow,
	embeddingToRow,
	rowToChunk,
	type CachedEmbedding,
	type CachedEmbeddingRow,
	type CodeChunk,
	type CodeChunkRow,
} from './types.js';

export * from './types.js';
export * from './schema.js';

/**
 * Storage layer wrapping LanceDB for code chunks and embedding cache.
 */
export class Storage {
	private readonly projectRoot: string;
	private readonly dimensions: number;
	private db: Connection | null = null;
	private chunksTable: Table | null = null;
	private cacheTable: Table | null = null;

	constructor(projectRoot: string, dimensions: number = 768) {
		this.projectRoot = projectRoot;
		this.dimensions = dimensions;
	}

	/**
	 * Connect to the LanceDB database.
	 * Creates tables if they don't exist.
	 * Validates that existing tables have matching dimensions.
	 */
	async connect(): Promise<void> {
		const dbPath = getLanceDbPath(this.projectRoot);
		this.db = await lancedb.connect(dbPath);

		// Get existing table names
		const tableNames = await this.db.tableNames();

		// Open or create code_chunks table
		if (tableNames.includes(TABLE_NAMES.CODE_CHUNKS)) {
			this.chunksTable = await this.db.openTable(TABLE_NAMES.CODE_CHUNKS);

			// Validate dimensions match - if mismatched, drop and recreate
			// This handles provider changes (e.g., different dimension providers)
			const tableDimensions = await this.getTableVectorDimensions(
				this.chunksTable,
			);
			if (tableDimensions !== null && tableDimensions !== this.dimensions) {
				// Dimension mismatch - drop and recreate with new schema
				console.warn(
					`[Storage] Dimension mismatch for ${TABLE_NAMES.CODE_CHUNKS}: ` +
						`existing=${tableDimensions}, required=${this.dimensions}. ` +
						`Dropping table - re-indexing will be required.`,
				);
				await this.db.dropTable(TABLE_NAMES.CODE_CHUNKS);
				const schema = createCodeChunksSchema(this.dimensions);
				this.chunksTable = await this.db.createEmptyTable(
					TABLE_NAMES.CODE_CHUNKS,
					schema,
				);
			}
		} else {
			const schema = createCodeChunksSchema(this.dimensions);
			this.chunksTable = await this.db.createEmptyTable(
				TABLE_NAMES.CODE_CHUNKS,
				schema,
			);
		}

		// Open or create embedding_cache table
		if (tableNames.includes(TABLE_NAMES.EMBEDDING_CACHE)) {
			this.cacheTable = await this.db.openTable(TABLE_NAMES.EMBEDDING_CACHE);

			// Validate dimensions match - if mismatched, drop and recreate
			const cacheDimensions = await this.getTableVectorDimensions(
				this.cacheTable,
			);
			if (cacheDimensions !== null && cacheDimensions !== this.dimensions) {
				// Cache dimension mismatch - drop and recreate
				console.warn(
					`[Storage] Dimension mismatch for ${TABLE_NAMES.EMBEDDING_CACHE}: ` +
						`existing=${cacheDimensions}, required=${this.dimensions}. ` +
						`Dropping cache table.`,
				);
				await this.db.dropTable(TABLE_NAMES.EMBEDDING_CACHE);
				const schema = createEmbeddingCacheSchema(this.dimensions);
				this.cacheTable = await this.db.createEmptyTable(
					TABLE_NAMES.EMBEDDING_CACHE,
					schema,
				);
			}
		} else {
			const schema = createEmbeddingCacheSchema(this.dimensions);
			this.cacheTable = await this.db.createEmptyTable(
				TABLE_NAMES.EMBEDDING_CACHE,
				schema,
			);
		}
	}

	/**
	 * Get the vector column dimensions from a table schema.
	 * Returns null if vector column not found.
	 */
	private async getTableVectorDimensions(table: Table): Promise<number | null> {
		try {
			const schema = await table.schema();
			const vectorField = schema.fields.find(
				(f: {name: string}) => f.name === 'vector',
			);
			if (vectorField && 'listSize' in vectorField.type) {
				return (vectorField.type as {listSize: number}).listSize;
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		// LanceDB connections don't need explicit closing in the JS SDK
		this.db = null;
		this.chunksTable = null;
		this.cacheTable = null;
	}

	/**
	 * Ensure we're connected.
	 * Note: chunksTable may be null after resetChunksTable().
	 */
	private ensureConnected(): void {
		if (!this.db || !this.cacheTable) {
			throw new Error('Storage not connected. Call connect() first.');
		}
	}

	/**
	 * Get the database connection with a clear error if not connected.
	 */
	private getDb(): Connection {
		if (!this.db) {
			throw new Error('Database not connected. Call connect() first.');
		}
		return this.db;
	}

	/**
	 * Get the cache table with a clear error if not connected.
	 */
	private getCacheTable(): Table {
		if (!this.cacheTable) {
			throw new Error('Cache table not available. Call connect() first.');
		}
		return this.cacheTable;
	}

	// ============================================================
	// Chunk Operations
	// ============================================================

	/**
	 * Upsert chunks into the database.
	 * Uses merge insert to update existing chunks or add new ones.
	 */
	async upsertChunks(chunks: CodeChunk[]): Promise<void> {
		this.ensureConnected();
		if (chunks.length === 0) return;

		if (!this.chunksTable) {
			throw new Error('Chunks table not available. Call connect() first.');
		}

		const rows = chunks.map(chunkToRow) as unknown as Record<string, unknown>[];

		// Use merge insert for upsert behavior
		await this.chunksTable
			.mergeInsert('id')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows);
	}

	/**
	 * Add chunks to the database (no merge, just insert).
	 * Use this after resetChunksTable() to avoid schema mismatch issues.
	 */
	async addChunks(chunks: CodeChunk[]): Promise<void> {
		this.ensureConnected();
		if (chunks.length === 0) return;

		if (!this.chunksTable) {
			throw new Error('Chunks table not available. Call connect() first.');
		}

		const rows = chunks.map(chunkToRow) as unknown as Record<string, unknown>[];
		const schema = createCodeChunksSchema(this.dimensions);

		// Use makeArrowTable to properly convert data with schema
		const arrowTable = makeArrowTable(rows, {schema});
		await this.chunksTable.add(arrowTable);
	}

	/**
	 * Delete all chunks for a specific file.
	 * @returns Number of chunks deleted
	 */
	async deleteChunksByFilepath(filepath: string): Promise<number> {
		this.ensureConnected();
		if (!this.chunksTable) return 0;

		const countBefore = await this.chunksTable.countRows();
		await this.chunksTable.delete(`filepath = '${escapeString(filepath)}'`);
		const countAfter = await this.chunksTable.countRows();

		return countBefore - countAfter;
	}

	/**
	 * Delete all chunks for multiple files.
	 * @returns Number of chunks deleted
	 */
	async deleteChunksByFilepaths(filepaths: string[]): Promise<number> {
		this.ensureConnected();
		if (filepaths.length === 0) return 0;
		if (!this.chunksTable) return 0;

		const countBefore = await this.chunksTable.countRows();

		// Build IN clause with escaped strings
		const escaped = filepaths.map(fp => `'${escapeString(fp)}'`).join(', ');
		await this.chunksTable.delete(`filepath IN (${escaped})`);

		const countAfter = await this.chunksTable.countRows();
		return countBefore - countAfter;
	}

	/**
	 * Get all chunks for a specific file.
	 */
	async getChunksByFilepath(filepath: string): Promise<CodeChunk[]> {
		this.ensureConnected();
		if (!this.chunksTable) return [];

		const results = await this.chunksTable
			.query()
			.where(`filepath = '${escapeString(filepath)}'`)
			.toArray();

		return results.map(row => rowToChunk(row as unknown as CodeChunkRow));
	}

	/**
	 * Get all unique filepaths in the database.
	 */
	async getAllFilepaths(): Promise<Set<string>> {
		this.ensureConnected();
		if (!this.chunksTable) return new Set();

		// Query all rows but only need filepath column
		const results = await this.chunksTable
			.query()
			.select(['filepath'])
			.toArray();

		const filepaths = new Set<string>();
		for (const row of results) {
			filepaths.add((row as {filepath: string}).filepath);
		}

		return filepaths;
	}

	/**
	 * Count total number of chunks.
	 */
	async countChunks(): Promise<number> {
		this.ensureConnected();
		// Table may be null after resetChunksTable() if no chunks added yet
		if (!this.chunksTable) {
			return 0;
		}
		return this.chunksTable.countRows();
	}

	// ============================================================
	// Cache Operations
	// ============================================================

	/**
	 * Get cached embeddings for a list of content hashes.
	 * @returns Map from content hash to vector
	 */
	async getCachedEmbeddings(hashes: string[]): Promise<Map<string, number[]>> {
		this.ensureConnected();
		if (hashes.length === 0) return new Map();

		// Build IN clause
		const escaped = hashes.map(h => `'${escapeString(h)}'`).join(', ');
		const results = await this.getCacheTable()
			.query()
			.where(`content_hash IN (${escaped})`)
			.toArray();

		const cache = new Map<string, number[]>();
		for (const row of results) {
			const typed = row as unknown as CachedEmbeddingRow;
			// Ensure vector is a plain array (LanceDB may return typed arrays)
			const vector = Array.isArray(typed.vector)
				? typed.vector
				: Array.from(typed.vector as unknown as ArrayLike<number>);
			cache.set(typed.content_hash, vector);
		}

		return cache;
	}

	/**
	 * Cache embeddings for future use.
	 */
	async cacheEmbeddings(entries: CachedEmbedding[]): Promise<void> {
		this.ensureConnected();
		if (entries.length === 0) return;

		const rows = entries.map(embeddingToRow) as unknown as Record<
			string,
			unknown
		>[];

		// Use merge insert for upsert behavior
		await this.getCacheTable()
			.mergeInsert('content_hash')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows);
	}

	/**
	 * Count total number of cached embeddings.
	 */
	async countCachedEmbeddings(): Promise<number> {
		this.ensureConnected();
		return this.getCacheTable().countRows();
	}

	// ============================================================
	// Maintenance Operations
	// ============================================================

	/**
	 * Clear all chunks but keep the embedding cache.
	 */
	async clearAll(): Promise<void> {
		this.ensureConnected();
		if (!this.chunksTable) return;

		// Delete all rows from chunks table
		// LanceDB doesn't have a truncate, so we delete all
		const count = await this.chunksTable.countRows();
		if (count > 0) {
			// Delete with a condition that matches all rows
			await this.chunksTable.delete('id IS NOT NULL');
		}
	}

	/**
	 * Drop and recreate the chunks table.
	 * Use this for force reindex to avoid schema mismatch issues.
	 */
	async resetChunksTable(): Promise<void> {
		this.ensureConnected();
		const db = this.getDb();

		// Drop existing table if it exists
		const tableNames = await db.tableNames();
		if (tableNames.includes(TABLE_NAMES.CODE_CHUNKS)) {
			await db.dropTable(TABLE_NAMES.CODE_CHUNKS);
		}

		// Create empty table with correct schema
		// This ensures chunksTable is never null after reset
		const schema = createCodeChunksSchema(this.dimensions);
		this.chunksTable = await db.createEmptyTable(
			TABLE_NAMES.CODE_CHUNKS,
			schema,
		);
	}

	/**
	 * Clear the embedding cache.
	 */
	async clearCache(): Promise<void> {
		this.ensureConnected();
		const cacheTable = this.getCacheTable();

		const count = await cacheTable.countRows();
		if (count > 0) {
			await cacheTable.delete('content_hash IS NOT NULL');
		}
	}

	/**
	 * Get the chunks table for direct querying (e.g., search).
	 * @throws Error if table doesn't exist (not indexed yet)
	 */
	getChunksTable(): Table {
		this.ensureConnected();
		if (!this.chunksTable) {
			throw new Error(
				'Chunks table not available. Run indexing first or the index may be empty.',
			);
		}
		return this.chunksTable;
	}
}

/**
 * Escape a string for use in SQL-like LanceDB filter expressions.
 * Escapes single quotes by doubling them.
 */
function escapeString(s: string): string {
	return s.replace(/'/g, "''");
}
