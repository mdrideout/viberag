/**
 * V2 Manifest - Index manifest for V2 tables.
 *
 * Stored separately from the legacy manifest to allow greenfield evolution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {getViberagDir} from '../../lib/constants.js';

export const V2_SCHEMA_VERSION = 3;

export type V2IndexCompatibilityStatus =
	| 'not_indexed'
	| 'compatible'
	| 'needs_reindex'
	| 'corrupt_manifest';

export type V2IndexCompatibility = {
	status: V2IndexCompatibilityStatus;
	requiredSchemaVersion: number;
	manifestSchemaVersion: number | null;
	manifestPath: string;
	checkedAt: string;
	message: string | null;
};

export class V2ReindexRequiredError extends Error {
	readonly requiredSchemaVersion: number;
	readonly manifestSchemaVersion: number | null;
	readonly manifestPath: string;
	readonly reason: 'schema_mismatch' | 'corrupt_manifest';

	constructor(args: {
		requiredSchemaVersion: number;
		manifestSchemaVersion: number | null;
		manifestPath: string;
		reason: 'schema_mismatch' | 'corrupt_manifest';
		message: string;
	}) {
		super(args.message);
		this.name = 'V2ReindexRequiredError';
		this.requiredSchemaVersion = args.requiredSchemaVersion;
		this.manifestSchemaVersion = args.manifestSchemaVersion;
		this.manifestPath = args.manifestPath;
		this.reason = args.reason;
	}
}

export type V2ManifestStats = {
	totalFiles: number;
	totalSymbols: number;
	totalChunks: number;
	totalRefs: number;
};

export type V2Manifest = {
	version: number;
	schemaVersion: number;
	createdAt: string;
	updatedAt: string;
	repoId: string;
	revision: string;
	tree: object | null;
	stats: V2ManifestStats;
};

export function getV2ManifestPath(projectRoot: string): string {
	return path.join(getViberagDir(projectRoot), 'manifest-v2.json');
}

export async function checkV2IndexCompatibility(
	projectRoot: string,
): Promise<V2IndexCompatibility> {
	const manifestPath = getV2ManifestPath(projectRoot);
	const checkedAt = new Date().toISOString();

	try {
		await fs.access(manifestPath);
	} catch {
		return {
			status: 'not_indexed',
			requiredSchemaVersion: V2_SCHEMA_VERSION,
			manifestSchemaVersion: null,
			manifestPath,
			checkedAt,
			message: null,
		};
	}

	try {
		const raw = await fs.readFile(manifestPath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<V2Manifest>;
		const manifestSchemaVersion =
			typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null;

		if (manifestSchemaVersion === null) {
			return {
				status: 'corrupt_manifest',
				requiredSchemaVersion: V2_SCHEMA_VERSION,
				manifestSchemaVersion: null,
				manifestPath,
				checkedAt,
				message:
					'Index manifest is missing schemaVersion. Run a full reindex (CLI: /reindex, MCP: build_index {force:true}).',
			};
		}

		if (manifestSchemaVersion !== V2_SCHEMA_VERSION) {
			return {
				status: 'needs_reindex',
				requiredSchemaVersion: V2_SCHEMA_VERSION,
				manifestSchemaVersion,
				manifestPath,
				checkedAt,
				message:
					`Index schemaVersion ${manifestSchemaVersion} is incompatible with this ` +
					`VibeRAG version (requires ${V2_SCHEMA_VERSION}). ` +
					'Run a full reindex (CLI: /reindex, MCP: build_index {force:true}).',
			};
		}

		return {
			status: 'compatible',
			requiredSchemaVersion: V2_SCHEMA_VERSION,
			manifestSchemaVersion,
			manifestPath,
			checkedAt,
			message: null,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: 'corrupt_manifest',
			requiredSchemaVersion: V2_SCHEMA_VERSION,
			manifestSchemaVersion: null,
			manifestPath,
			checkedAt,
			message: `Index manifest is unreadable (${message}). Run a full reindex (CLI: /reindex, MCP: build_index {force:true}).`,
		};
	}
}

export function createEmptyV2Manifest(args: {
	repoId: string;
	revision: string;
}): V2Manifest {
	const now = new Date().toISOString();
	return {
		version: 1,
		schemaVersion: V2_SCHEMA_VERSION,
		createdAt: now,
		updatedAt: now,
		repoId: args.repoId,
		revision: args.revision,
		tree: null,
		stats: {totalFiles: 0, totalSymbols: 0, totalChunks: 0, totalRefs: 0},
	};
}

export async function loadV2Manifest(
	projectRoot: string,
	args: {repoId: string; revision: string},
): Promise<V2Manifest> {
	const manifestPath = getV2ManifestPath(projectRoot);
	try {
		const content = await fs.readFile(manifestPath, 'utf-8');
		const parsed = JSON.parse(content) as Partial<V2Manifest>;
		return {
			...createEmptyV2Manifest(args),
			...parsed,
			stats: {
				...createEmptyV2Manifest(args).stats,
				...(parsed.stats ?? {}),
			},
		};
	} catch {
		return createEmptyV2Manifest(args);
	}
}

export async function saveV2Manifest(
	projectRoot: string,
	manifest: V2Manifest,
): Promise<void> {
	const viberagDir = getViberagDir(projectRoot);
	await fs.mkdir(viberagDir, {recursive: true});

	const manifestPath = getV2ManifestPath(projectRoot);
	const updated: V2Manifest = {
		...manifest,
		schemaVersion: V2_SCHEMA_VERSION,
		updatedAt: new Date().toISOString(),
	};
	await fs.writeFile(manifestPath, JSON.stringify(updated, null, '\t') + '\n');
}

export async function v2ManifestExists(projectRoot: string): Promise<boolean> {
	const manifestPath = getV2ManifestPath(projectRoot);
	try {
		await fs.access(manifestPath);
		return true;
	} catch {
		return false;
	}
}
