/**
 * Test helpers for E2E tests.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Path to the checked-in test fixtures */
export const FIXTURES_ROOT = path.join(process.cwd(), 'test-fixtures');

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
