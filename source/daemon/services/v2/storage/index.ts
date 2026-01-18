/**
 * V2 Storage service wrapping LanceDB.
 *
 * Owns v2 tables (symbols, chunks, files) and a v2 embedding cache.
 */

import * as lancedb from '@lancedb/lancedb';
import {makeArrowTable} from '@lancedb/lancedb';
import type {Connection, Table} from '@lancedb/lancedb';
import {getLanceDbPath} from '../../../lib/constants.js';
import {
	createV2ChunksSchema,
	createV2EmbeddingCacheSchema,
	createV2FilesSchema,
	createV2RefsSchema,
	createV2SymbolsSchema,
} from './schema.js';
import type {V2EmbeddingCacheRow} from './types.js';

export const V2_TABLE_NAMES = {
	SYMBOLS: 'v2_symbols',
	CHUNKS: 'v2_chunks',
	FILES: 'v2_files',
	REFS: 'v2_refs',
	EMBEDDING_CACHE: 'v2_embedding_cache',
} as const;

export class StorageV2 {
	private readonly projectRoot: string;
	private readonly dimensions: number;
	private db: Connection | null = null;
	private symbolsTable: Table | null = null;
	private chunksTable: Table | null = null;
	private filesTable: Table | null = null;
	private refsTable: Table | null = null;
	private cacheTable: Table | null = null;

	constructor(projectRoot: string, dimensions: number) {
		this.projectRoot = projectRoot;
		this.dimensions = dimensions;
	}

	async connect(): Promise<void> {
		const dbPath = getLanceDbPath(this.projectRoot);
		this.db = await lancedb.connect(dbPath);

		const tableNames = await this.db.tableNames();

		this.symbolsTable = await this.openOrCreateVectorTable(
			tableNames,
			V2_TABLE_NAMES.SYMBOLS,
			createV2SymbolsSchema(this.dimensions),
			'vec_summary',
		);
		this.chunksTable = await this.openOrCreateVectorTable(
			tableNames,
			V2_TABLE_NAMES.CHUNKS,
			createV2ChunksSchema(this.dimensions),
			'vec_code',
		);
		this.filesTable = await this.openOrCreateVectorTable(
			tableNames,
			V2_TABLE_NAMES.FILES,
			createV2FilesSchema(this.dimensions),
			'vec_file',
		);
		this.refsTable = await this.openOrCreateTable(
			tableNames,
			V2_TABLE_NAMES.REFS,
			createV2RefsSchema(),
		);
		this.cacheTable = await this.openOrCreateVectorTable(
			tableNames,
			V2_TABLE_NAMES.EMBEDDING_CACHE,
			createV2EmbeddingCacheSchema(this.dimensions),
			'vector',
		);
	}

	private async openOrCreateTable(
		existing: string[],
		name: string,
		schema: ReturnType<typeof createV2SymbolsSchema>,
	): Promise<Table> {
		const db = this.getDb();
		if (existing.includes(name)) {
			return db.openTable(name);
		}
		return db.createEmptyTable(name, schema);
	}

	private async openOrCreateVectorTable(
		existing: string[],
		name: string,
		schema: ReturnType<typeof createV2SymbolsSchema>,
		vectorColumn: string,
	): Promise<Table> {
		const db = this.getDb();
		if (existing.includes(name)) {
			const table = await db.openTable(name);
			const tableDimensions = await this.getTableVectorDimensions(
				table,
				vectorColumn,
			);
			if (tableDimensions !== null && tableDimensions !== this.dimensions) {
				console.warn(
					`[StorageV2] Dimension mismatch for ${name}.${vectorColumn}: ` +
						`existing=${tableDimensions}, required=${this.dimensions}. ` +
						`Dropping table - re-indexing will be required.`,
				);
				await db.dropTable(name);
				return db.createEmptyTable(name, schema);
			}
			return table;
		}
		return db.createEmptyTable(name, schema);
	}

	private async getTableVectorDimensions(
		table: Table,
		vectorColumn: string,
	): Promise<number | null> {
		try {
			const schema = await table.schema();
			const vectorField = schema.fields.find(
				(f: {name: string}) => f.name === vectorColumn,
			);
			if (vectorField && 'listSize' in vectorField.type) {
				return (vectorField.type as {listSize: number}).listSize;
			}
			return null;
		} catch {
			return null;
		}
	}

	close(): void {
		this.db = null;
		this.symbolsTable = null;
		this.chunksTable = null;
		this.filesTable = null;
		this.refsTable = null;
		this.cacheTable = null;
	}

	private getDb(): Connection {
		if (!this.db) {
			throw new Error('Database not connected. Call connect() first.');
		}
		return this.db;
	}

	getSymbolsTable(): Table {
		if (!this.symbolsTable) {
			throw new Error('Symbols table not available. Call connect() first.');
		}
		return this.symbolsTable;
	}

	getChunksTable(): Table {
		if (!this.chunksTable) {
			throw new Error('Chunks table not available. Call connect() first.');
		}
		return this.chunksTable;
	}

	getFilesTable(): Table {
		if (!this.filesTable) {
			throw new Error('Files table not available. Call connect() first.');
		}
		return this.filesTable;
	}

	getRefsTable(): Table {
		if (!this.refsTable) {
			throw new Error('Refs table not available. Call connect() first.');
		}
		return this.refsTable;
	}

	private getCacheTable(): Table {
		if (!this.cacheTable) {
			throw new Error(
				'Embedding cache table not available. Call connect() first.',
			);
		}
		return this.cacheTable;
	}

	// ============================================================
	// Table resets / deletes
	// ============================================================

	async resetEntityTables(options: {dropCache?: boolean} = {}): Promise<void> {
		const db = this.getDb();
		const tableNames = await db.tableNames();
		const toDrop = [
			V2_TABLE_NAMES.SYMBOLS,
			V2_TABLE_NAMES.CHUNKS,
			V2_TABLE_NAMES.FILES,
			V2_TABLE_NAMES.REFS,
			...(options.dropCache ? [V2_TABLE_NAMES.EMBEDDING_CACHE] : []),
		];
		for (const name of toDrop) {
			if (!tableNames.includes(name)) continue;
			await db.dropTable(name);
		}
		this.symbolsTable = await db.createEmptyTable(
			V2_TABLE_NAMES.SYMBOLS,
			createV2SymbolsSchema(this.dimensions),
		);
		this.chunksTable = await db.createEmptyTable(
			V2_TABLE_NAMES.CHUNKS,
			createV2ChunksSchema(this.dimensions),
		);
		this.filesTable = await db.createEmptyTable(
			V2_TABLE_NAMES.FILES,
			createV2FilesSchema(this.dimensions),
		);
		this.refsTable = await db.createEmptyTable(
			V2_TABLE_NAMES.REFS,
			createV2RefsSchema(),
		);
		if (options.dropCache) {
			this.cacheTable = await db.createEmptyTable(
				V2_TABLE_NAMES.EMBEDDING_CACHE,
				createV2EmbeddingCacheSchema(this.dimensions),
			);
		}
	}

	async deleteAllRowsForFile(filePath: string): Promise<{
		symbolsDeleted: number;
		chunksDeleted: number;
		filesDeleted: number;
		refsDeleted: number;
	}> {
		const symbolsDeleted = await this.deleteByFilePath(
			this.getSymbolsTable(),
			filePath,
		);
		const chunksDeleted = await this.deleteByFilePath(
			this.getChunksTable(),
			filePath,
		);
		const filesDeleted = await this.deleteByFilePath(
			this.getFilesTable(),
			filePath,
		);
		const refsDeleted = await this.deleteByFilePath(
			this.getRefsTable(),
			filePath,
		);
		return {symbolsDeleted, chunksDeleted, filesDeleted, refsDeleted};
	}

	private async deleteByFilePath(
		table: Table,
		filePath: string,
	): Promise<number> {
		const countBefore = await table.countRows();
		await table.delete(`file_path = '${escapeString(filePath)}'`);
		const countAfter = await table.countRows();
		return countBefore - countAfter;
	}

	// ============================================================
	// Upserts
	// ============================================================

	async upsertSymbols(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		await this.getSymbolsTable()
			.mergeInsert('symbol_id')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows);
	}

	async upsertChunks(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		await this.getChunksTable()
			.mergeInsert('chunk_id')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows);
	}

	async upsertFiles(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		await this.getFilesTable()
			.mergeInsert('file_id')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows);
	}

	async upsertRefs(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		await this.getRefsTable()
			.mergeInsert('ref_id')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows);
	}

	/**
	 * Add rows using Arrow conversion (useful after a full reset).
	 */
	async addSymbols(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		const schema = createV2SymbolsSchema(this.dimensions);
		const arrowTable = makeArrowTable(rows, {schema});
		await this.getSymbolsTable().add(arrowTable);
	}

	async addChunks(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		const schema = createV2ChunksSchema(this.dimensions);
		const arrowTable = makeArrowTable(rows, {schema});
		await this.getChunksTable().add(arrowTable);
	}

	async addFiles(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		const schema = createV2FilesSchema(this.dimensions);
		const arrowTable = makeArrowTable(rows, {schema});
		await this.getFilesTable().add(arrowTable);
	}

	async addRefs(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		const schema = createV2RefsSchema();
		const arrowTable = makeArrowTable(rows, {schema});
		await this.getRefsTable().add(arrowTable);
	}

	// ============================================================
	// Embedding cache
	// ============================================================

	async getCachedEmbeddings(
		inputHashes: string[],
	): Promise<Map<string, number[]>> {
		if (inputHashes.length === 0) {
			return new Map();
		}
		const cache = new Map<string, number[]>();
		const escaped = inputHashes.map(h => `'${escapeString(h)}'`).join(', ');
		const rows = await this.getCacheTable()
			.query()
			.where(`input_hash IN (${escaped})`)
			.toArray();
		for (const row of rows as unknown as V2EmbeddingCacheRow[]) {
			const normalized = normalizeVector(row.vector);
			if (!normalized) continue;
			cache.set(row.input_hash, normalized);
		}
		return cache;
	}

	async cacheEmbeddings(rows: V2EmbeddingCacheRow[]): Promise<void> {
		if (rows.length === 0) return;
		await this.getCacheTable()
			.mergeInsert('input_hash')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows as unknown as Record<string, unknown>[]);
	}
}

function escapeString(value: string): string {
	return value.replace(/'/g, "''");
}

function normalizeVector(value: unknown): number[] | null {
	if (!value) return null;
	if (Array.isArray(value)) {
		return value.map(v => Number(v));
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
		const v = value as {toArray?: () => unknown};
		if (typeof v.toArray === 'function') {
			return normalizeVector(v.toArray());
		}
	}
	return null;
}
