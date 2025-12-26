import fs from 'node:fs/promises';
import {getManifestPath, getLcrDir} from '../constants.js';

export interface ManifestStats {
	totalFiles: number;
	totalChunks: number;
}

export interface Manifest {
	version: number;
	createdAt: string; // ISO timestamp
	updatedAt: string; // ISO timestamp
	tree: object | null; // Serialized MerkleTree
	stats: ManifestStats;
}

/**
 * Create an empty manifest.
 */
export function createEmptyManifest(): Manifest {
	const now = new Date().toISOString();
	return {
		version: 1,
		createdAt: now,
		updatedAt: now,
		tree: null,
		stats: {
			totalFiles: 0,
			totalChunks: 0,
		},
	};
}

/**
 * Load manifest from disk.
 * Returns an empty manifest if no file exists.
 */
export async function loadManifest(projectRoot: string): Promise<Manifest> {
	const manifestPath = getManifestPath(projectRoot);

	try {
		const content = await fs.readFile(manifestPath, 'utf-8');
		return JSON.parse(content) as Manifest;
	} catch {
		return createEmptyManifest();
	}
}

/**
 * Save manifest to disk.
 * Creates the .lance-code-rag directory if it doesn't exist.
 */
export async function saveManifest(
	projectRoot: string,
	manifest: Manifest,
): Promise<void> {
	const lcrDir = getLcrDir(projectRoot);
	await fs.mkdir(lcrDir, {recursive: true});

	const manifestPath = getManifestPath(projectRoot);
	const updated: Manifest = {
		...manifest,
		updatedAt: new Date().toISOString(),
	};
	await fs.writeFile(manifestPath, JSON.stringify(updated, null, '\t') + '\n');
}

/**
 * Check if a manifest file exists.
 */
export async function manifestExists(projectRoot: string): Promise<boolean> {
	const manifestPath = getManifestPath(projectRoot);
	try {
		await fs.access(manifestPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Update manifest stats.
 */
export function updateManifestStats(
	manifest: Manifest,
	stats: ManifestStats,
): Manifest {
	return {
		...manifest,
		stats,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Update manifest tree.
 */
export function updateManifestTree(
	manifest: Manifest,
	tree: object | null,
): Manifest {
	return {
		...manifest,
		tree,
		updatedAt: new Date().toISOString(),
	};
}
