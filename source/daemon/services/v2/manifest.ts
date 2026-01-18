/**
 * V2 Manifest - Index manifest for V2 tables.
 *
 * Stored separately from the legacy manifest to allow greenfield evolution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {getViberagDir} from '../../lib/constants.js';

export const V2_SCHEMA_VERSION = 2;

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
