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

/**
 * Convert gitignore patterns to fast-glob ignore patterns.
 * This allows fast-glob to skip directories upfront instead of
 * scanning them and filtering later.
 *
 * @param projectRoot - Project root directory
 * @returns Array of fast-glob compatible ignore patterns
 */
export async function getGlobIgnorePatterns(
	projectRoot: string,
): Promise<string[]> {
	const patterns: string[] = [];

	// Always exclude these (same as ALWAYS_IGNORED)
	patterns.push('**/.git/**', '**/.viberag/**', '**/node_modules/**');

	// Try to load .gitignore
	const gitignorePath = path.join(projectRoot, '.gitignore');
	try {
		const content = await fs.readFile(gitignorePath, 'utf-8');
		const lines = content.split('\n');

		for (const line of lines) {
			const trimmed = line.trim();

			// Skip empty lines and comments
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}

			// Skip negation patterns (fast-glob handles these differently)
			if (trimmed.startsWith('!')) {
				continue;
			}

			// Convert gitignore pattern to fast-glob pattern
			const globPattern = gitignoreToGlob(trimmed);
			if (globPattern) {
				patterns.push(globPattern);
			}
		}
	} catch {
		// .gitignore doesn't exist, that's fine
	}

	return patterns;
}

/**
 * Convert a single gitignore pattern to a fast-glob pattern.
 *
 * Gitignore patterns:
 * - `foo` matches `foo` anywhere
 * - `foo/` matches directory `foo` anywhere
 * - `/foo` matches `foo` only at root
 * - `*.log` matches `*.log` anywhere
 *
 * Fast-glob patterns:
 * - Need `**/` prefix to match anywhere
 * - Need `/**` suffix to match directory contents
 */
function gitignoreToGlob(pattern: string): string | null {
	let result = pattern;

	// Handle rooted patterns (start with /)
	const isRooted = result.startsWith('/');
	if (isRooted) {
		result = result.slice(1);
	}

	// Handle directory patterns (end with /)
	const isDirectory = result.endsWith('/');
	if (isDirectory) {
		result = result.slice(0, -1);
	}

	// Skip patterns that are already glob-like with **
	const hasDoublestar = result.includes('**');

	// Build the glob pattern
	if (isRooted) {
		// Rooted: match only at project root
		result = isDirectory ? `${result}/**` : result;
	} else if (!hasDoublestar) {
		// Non-rooted: match anywhere in tree
		result = isDirectory ? `**/${result}/**` : `**/${result}`;

		// If it doesn't look like a directory name (has extension or glob),
		// don't add trailing /**
		if (
			!isDirectory &&
			(result.includes('.') || result.includes('*') || result.includes('?'))
		) {
			// Keep as-is, it's likely a file pattern
		} else if (!isDirectory) {
			// Bare name like "node_modules" - treat as directory
			result = `**/${pattern}/**`;
		}
	}

	return result;
}
