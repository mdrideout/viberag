/**
 * Merkle Hash - Hashing utilities for Merkle tree construction.
 *
 * Provides functions for computing SHA256 hashes of files,
 * directories, and strings.
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import type {MerkleNode} from './node.js';

// ============================================================================
// Hash Functions
// ============================================================================

/**
 * Compute SHA256 hash of a file's content.
 */
export async function computeFileHash(filepath: string): Promise<string> {
	const content = await fs.readFile(filepath);
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA256 hash of a string.
 */
export function computeStringHash(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA256 hash of a directory based on its children.
 *
 * Hash = SHA256(sorted child name+hash pairs)
 * Format: "name1:hash1\nname2:hash2\n..."
 */
export function computeDirectoryHash(
	children: Map<string, MerkleNode>,
): string {
	// Sort children by name for deterministic hashing
	const sortedNames = [...children.keys()].sort();

	// Build content string from name:hash pairs
	const content = sortedNames
		.map(name => {
			const child = children.get(name)!;
			return `${name}:${child.hash}`;
		})
		.join('\n');

	return createHash('sha256').update(content).digest('hex');
}

// ============================================================================
// Binary Detection
// ============================================================================

/**
 * Known binary file extensions.
 */
const BINARY_EXTENSIONS = new Set([
	// Images
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.bmp',
	'.ico',
	'.webp',
	'.svg',
	'.tiff',
	'.tif',
	// Audio/Video
	'.mp3',
	'.mp4',
	'.wav',
	'.avi',
	'.mov',
	'.webm',
	'.flac',
	'.ogg',
	// Archives
	'.zip',
	'.tar',
	'.gz',
	'.bz2',
	'.7z',
	'.rar',
	// Documents
	'.pdf',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.ppt',
	'.pptx',
	// Executables
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.bin',
	// Fonts
	'.ttf',
	'.otf',
	'.woff',
	'.woff2',
	'.eot',
	// Other
	'.wasm',
	'.node',
	'.pyc',
	'.pyo',
	'.class',
	'.o',
	'.a',
]);

/**
 * Check if a file is likely binary based on extension.
 * Falls back to checking for null bytes in the first chunk.
 */
export async function isBinaryFile(filepath: string): Promise<boolean> {
	// Check extension first (fast path)
	const ext = filepath.slice(filepath.lastIndexOf('.')).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) {
		return true;
	}

	// Check for null bytes in first 8KB
	try {
		const handle = await fs.open(filepath, 'r');
		try {
			const buffer = Buffer.alloc(8192);
			const {bytesRead} = await handle.read(buffer, 0, 8192, 0);

			// Check for null bytes (common in binary files)
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] === 0) {
					return true;
				}
			}

			return false;
		} finally {
			await handle.close();
		}
	} catch {
		// If we can't read the file, assume it's not binary
		return false;
	}
}

// ============================================================================
// Path Filtering
// ============================================================================

/**
 * Check if a path should be excluded based on patterns.
 *
 * Supported pattern types:
 * - "node_modules" - matches any path containing a "node_modules" segment
 * - "*.pyc" - matches any file ending with .pyc
 * - ".git" - matches any path containing a ".git" segment
 */
export function shouldExclude(
	relativePath: string,
	excludePatterns: string[],
): boolean {
	// Split path into segments
	const segments = relativePath.split('/');
	const filename = segments[segments.length - 1] ?? '';

	for (const pattern of excludePatterns) {
		// Glob pattern: *.ext matches files with that extension
		if (pattern.startsWith('*.')) {
			const ext = pattern.slice(1); // ".pyc"
			if (filename.endsWith(ext)) {
				return true;
			}

			continue;
		}

		// Check if any segment matches the pattern exactly
		if (segments.includes(pattern)) {
			return true;
		}

		// Also check if the path starts with the pattern (for top-level exclusions)
		if (relativePath.startsWith(pattern + '/') || relativePath === pattern) {
			return true;
		}
	}

	return false;
}

/**
 * Check if a file has a supported extension.
 */
export function hasValidExtension(
	filepath: string,
	extensions: string[],
): boolean {
	const ext = filepath.slice(filepath.lastIndexOf('.'));
	return extensions.includes(ext);
}
