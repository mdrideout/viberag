/**
 * Test helpers for E2E tests.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Path to the checked-in test fixtures */
export const FIXTURES_ROOT = path.join(process.cwd(), 'test-fixtures');

/** Temp directory prefix for test fixtures */
const TEMP_PREFIX = 'viberag-test-';

/** Test context with temp directory and cleanup */
export interface TestContext {
	projectRoot: string;
	cleanup: () => Promise<void>;
}

/**
 * Copy fixture directory to a unique temp directory.
 */
export async function copyFixtureToTemp(
	fixtureName: string = 'codebase',
): Promise<TestContext> {
	const fixtureSource = path.join(FIXTURES_ROOT, fixtureName);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-test-'));

	await copyDirectory(fixtureSource, tempDir);

	return {
		projectRoot: tempDir,
		cleanup: async () => {
			await fs.rm(tempDir, {recursive: true, force: true});
		},
	};
}

/**
 * Copy a directory recursively.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
	await fs.mkdir(dest, {recursive: true});
	const entries = await fs.readdir(src, {withFileTypes: true});

	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);

		if (entry.isDirectory()) {
			await copyDirectory(srcPath, destPath);
		} else {
			await fs.copyFile(srcPath, destPath);
		}
	}
}

/**
 * Add a new file to the temp project.
 */
export async function addFile(
	projectRoot: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const fullPath = path.join(projectRoot, relativePath);
	await fs.mkdir(path.dirname(fullPath), {recursive: true});
	await fs.writeFile(fullPath, content);
}

/**
 * Modify an existing file in the temp project.
 */
export async function modifyFile(
	projectRoot: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const fullPath = path.join(projectRoot, relativePath);
	await fs.writeFile(fullPath, content);
}

/**
 * Delete a file from the temp project.
 */
export async function deleteFile(
	projectRoot: string,
	relativePath: string,
): Promise<void> {
	const fullPath = path.join(projectRoot, relativePath);
	await fs.unlink(fullPath);
}

/**
 * Wait for filesystem changes to propagate (mtime resolution).
 */
export async function waitForFs(ms: number = 100): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get a shared temp directory for a fixture.
 * Unlike copyFixtureToTemp, this returns the same path for each call with the same fixture name.
 * Useful for tests that can share an indexed fixture.
 *
 * Note: The directory is NOT automatically cleaned up.
 */
export function getSharedTempDir(fixtureName: string = 'codebase'): string {
	return path.join(os.tmpdir(), `${TEMP_PREFIX}shared-${fixtureName}`);
}

/**
 * Copy fixture to a shared temp directory if it doesn't already exist.
 * Returns the path to the shared temp directory.
 *
 * Note: The directory is NOT automatically cleaned up.
 */
export async function copyFixtureToSharedTemp(
	fixtureName: string = 'codebase',
): Promise<string> {
	const sharedDir = getSharedTempDir(fixtureName);

	// Check if already copied
	try {
		await fs.access(sharedDir);
		return sharedDir; // Already exists
	} catch {
		// Directory doesn't exist, copy it
	}

	const fixtureSource = path.join(FIXTURES_ROOT, fixtureName);
	await copyDirectory(fixtureSource, sharedDir);
	return sharedDir;
}

/**
 * Clean up all shared temp directories.
 * Call this in globalTeardown or manually when needed.
 */
export async function cleanupSharedTempDirs(): Promise<void> {
	const tmpDir = os.tmpdir();
	const entries = await fs.readdir(tmpDir);

	for (const entry of entries) {
		if (entry.startsWith(`${TEMP_PREFIX}shared-`)) {
			const fullPath = path.join(tmpDir, entry);
			await fs.rm(fullPath, {recursive: true, force: true});
		}
	}
}
