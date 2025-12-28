import fs from 'node:fs/promises';
import {getManifestPath, getViberagDir} from '../constants.js';
import {SCHEMA_VERSION} from '../storage/schema.js';

export interface ManifestStats {
	totalFiles: number;
	totalChunks: number;
}

export interface Manifest {
	version: number;
	schemaVersion: number; // Database schema version for migration detection
	createdAt: string; // ISO timestamp
	updatedAt: string; // ISO timestamp
	tree: object | null; // Serialized MerkleTree
	stats: ManifestStats;
}

/**
 * Create an empty manifest with current schema version.
 */
export function createEmptyManifest(): Manifest {
	const now = new Date().toISOString();
	return {
		version: 1,
		schemaVersion: SCHEMA_VERSION,
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
 * Check if manifest schema version is current.
 */
export function isSchemaVersionCurrent(manifest: Manifest): boolean {
	return manifest.schemaVersion === SCHEMA_VERSION;
}

/**
 * Get schema version mismatch info for display.
 */
export function getSchemaVersionInfo(manifest: Manifest): {
	current: number;
	required: number;
	needsReindex: boolean;
} {
	return {
		current: manifest.schemaVersion ?? 1, // Default to 1 for old manifests
		required: SCHEMA_VERSION,
		needsReindex: (manifest.schemaVersion ?? 1) < SCHEMA_VERSION,
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
 * Creates the .viberag directory if it doesn't exist.
 */
export async function saveManifest(
	projectRoot: string,
	manifest: Manifest,
): Promise<void> {
	const viberagDir = getViberagDir(projectRoot);
	await fs.mkdir(viberagDir, {recursive: true});

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
