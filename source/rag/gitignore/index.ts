/**
 * Gitignore-based file filtering.
 *
 * Uses the `ignore` package to parse .gitignore files and filter paths.
 * This replaces the hardcoded excludePatterns approach.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

// ignore is a CJS module, use createRequire to import it
const require = createRequire(import.meta.url);
const ignore = require('ignore') as () => Ignore;

interface Ignore {
	add(patterns: string | string[]): this;
	ignores(pathname: string): boolean;
	filter(pathnames: string[]): string[];
	createFilter(): (pathname: string) => boolean;
}

/**
 * Patterns that should always be ignored, regardless of .gitignore.
 * These are internal/system directories that should never be indexed.
 */
const ALWAYS_IGNORED = [
	'.git',
	'.viberag',
	'node_modules', // Fallback in case not in .gitignore
];

/**
 * Cache of Ignore instances per project root.
 */
const ignoreCache = new Map<string, Ignore>();

/**
 * Load and parse .gitignore file from project root.
 * Returns an Ignore instance that can filter paths.
 *
 * @param projectRoot - Project root directory
 * @returns Ignore instance for filtering
 */
export async function loadGitignore(projectRoot: string): Promise<Ignore> {
	// Check cache first
	const cached = ignoreCache.get(projectRoot);
	if (cached) {
		return cached;
	}

	const ig = ignore();

	// Add always-ignored patterns
	ig.add(ALWAYS_IGNORED);

	// Try to load .gitignore
	const gitignorePath = path.join(projectRoot, '.gitignore');
	try {
		const content = await fs.readFile(gitignorePath, 'utf-8');
		ig.add(content);
	} catch {
		// .gitignore doesn't exist, that's fine
	}

	// Cache the instance
	ignoreCache.set(projectRoot, ig);

	return ig;
}

/**
 * Check if a path should be ignored based on .gitignore rules.
 *
 * @param projectRoot - Project root directory
 * @param relativePath - Path relative to project root
 * @returns true if the path should be ignored
 */
export async function shouldIgnore(
	projectRoot: string,
	relativePath: string,
): Promise<boolean> {
	const ig = await loadGitignore(projectRoot);
	return ig.ignores(relativePath);
}

/**
 * Create a filter function for use with file listing.
 * The filter returns true for files that should be INCLUDED (not ignored).
 *
 * @param projectRoot - Project root directory
 * @returns Filter function that returns true for non-ignored files
 */
export async function createGitignoreFilter(
	projectRoot: string,
): Promise<(relativePath: string) => boolean> {
	const ig = await loadGitignore(projectRoot);
	return (relativePath: string) => !ig.ignores(relativePath);
}

/**
 * Clear the cache for a specific project root.
 * Call this if .gitignore has been modified.
 *
 * @param projectRoot - Project root directory
 */
export function clearGitignoreCache(projectRoot: string): void {
	ignoreCache.delete(projectRoot);
}

/**
 * Clear all cached Ignore instances.
 */
export function clearAllGitignoreCache(): void {
	ignoreCache.clear();
}
