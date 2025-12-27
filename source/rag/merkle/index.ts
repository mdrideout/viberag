import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import {
	createDirectoryNode,
	createFileNode,
	deserializeNode,
	serializeNode,
	type MerkleNode,
	type SerializedNode,
} from './node.js';
import {
	computeDirectoryHash,
	computeFileHash,
	hasValidExtension,
	isBinaryFile,
	shouldExclude,
} from './hash.js';
import {compareTrees, type TreeDiff} from './diff.js';

export * from './node.js';
export * from './hash.js';
export * from './diff.js';

/**
 * Statistics from building a Merkle tree.
 */
export interface BuildStats {
	/** Total files scanned (before filtering) */
	filesScanned: number;
	/** Files indexed (after filtering) */
	filesIndexed: number;
	/** Hash cache hits (mtime optimization) */
	cacheHits: number;
	/** Hash cache misses (computed hash) */
	cacheMisses: number;
	/** Files skipped (binary, symlink, errors) */
	filesSkipped: number;
}

/**
 * A Merkle tree for efficient codebase change detection.
 *
 * The tree is content-addressed: if a file's content doesn't change,
 * its hash stays the same. Directory hashes are computed from their
 * children's hashes, so unchanged subtrees have unchanged hashes.
 */
export class MerkleTree {
	/** Root node of the tree */
	readonly root: MerkleNode | null;
	/** Total number of files in the tree */
	readonly fileCount: number;
	/** Build statistics (populated after build) */
	readonly buildStats: BuildStats;

	private constructor(
		root: MerkleNode | null,
		fileCount: number,
		buildStats: BuildStats,
	) {
		this.root = root;
		this.fileCount = fileCount;
		this.buildStats = buildStats;
	}

	/**
	 * Build a Merkle tree from the filesystem.
	 *
	 * @param projectRoot - Absolute path to project root
	 * @param extensions - File extensions to include (e.g., [".py", ".ts"])
	 * @param excludePatterns - Patterns to exclude (e.g., ["node_modules", ".git"])
	 * @param previousTree - Previous tree for mtime optimization
	 */
	static async build(
		projectRoot: string,
		extensions: string[],
		excludePatterns: string[],
		previousTree?: MerkleTree,
	): Promise<MerkleTree> {
		// Build a lookup map from the previous tree for mtime optimization
		const previousNodes = previousTree
			? buildNodeLookup(previousTree.root)
			: new Map<string, MerkleNode>();

		// Initialize build stats
		const stats: BuildStats = {
			filesScanned: 0,
			filesIndexed: 0,
			cacheHits: 0,
			cacheMisses: 0,
			filesSkipped: 0,
		};

		// Find all files matching our criteria
		const pattern = '**/*';
		const files = await fg(pattern, {
			cwd: projectRoot,
			dot: true,
			onlyFiles: true,
			followSymbolicLinks: false, // Skip symlinks
			ignore: excludePatterns.map(p => `**/${p}/**`),
		});

		stats.filesScanned = files.length;

		// Filter to valid extensions and non-excluded paths
		const validFiles = files.filter(relativePath => {
			if (!hasValidExtension(relativePath, extensions)) {
				return false;
			}

			if (shouldExclude(relativePath, excludePatterns)) {
				return false;
			}

			return true;
		});

		// Build file nodes
		const fileNodes = new Map<string, MerkleNode>();

		for (const relativePath of validFiles) {
			const absolutePath = path.join(projectRoot, relativePath);

			try {
				// Get file stats (use lstat to detect symlinks)
				const fileStats = await fs.lstat(absolutePath);

				// Skip symlinks
				if (fileStats.isSymbolicLink()) {
					stats.filesSkipped++;
					continue;
				}

				// Check if it's a binary file
				const binary = await isBinaryFile(absolutePath);
				if (binary) {
					stats.filesSkipped++;
					continue;
				}

				const size = fileStats.size;
				const mtime = fileStats.mtimeMs;

				// Check if we can reuse hash from previous tree (mtime optimization)
				let hash: string;
				const prevNode = previousNodes.get(relativePath);

				if (
					prevNode &&
					prevNode.type === 'file' &&
					prevNode.size === size &&
					prevNode.mtime === mtime
				) {
					// File unchanged - reuse cached hash
					hash = prevNode.hash;
					stats.cacheHits++;
				} else {
					// File is new or changed - compute hash
					hash = await computeFileHash(absolutePath);
					stats.cacheMisses++;
				}

				const node = createFileNode(relativePath, hash, size, mtime);
				fileNodes.set(relativePath, node);
				stats.filesIndexed++;
			} catch {
				// Skip files we can't read
				stats.filesSkipped++;
				continue;
			}
		}

		// Build directory structure
		const root = buildDirectoryTree(fileNodes);

		return new MerkleTree(root, stats.filesIndexed, stats);
	}

	/**
	 * Compare this tree with another tree.
	 *
	 * @param other - The other tree (usually the new/current tree)
	 * @returns TreeDiff with new, modified, and deleted files
	 */
	compare(other: MerkleTree): TreeDiff {
		return compareTrees(this.root, other.root);
	}

	/**
	 * Serialize the tree to a plain object for JSON storage.
	 */
	toJSON(): SerializedNode | null {
		if (!this.root) {
			return null;
		}

		return serializeNode(this.root);
	}

	/**
	 * Deserialize a tree from a plain object.
	 */
	static fromJSON(data: SerializedNode | null): MerkleTree {
		const emptyStats: BuildStats = {
			filesScanned: 0,
			filesIndexed: 0,
			cacheHits: 0,
			cacheMisses: 0,
			filesSkipped: 0,
		};

		if (!data) {
			return new MerkleTree(null, 0, emptyStats);
		}

		const root = deserializeNode(data);
		const fileCount = countFiles(root);
		return new MerkleTree(root, fileCount, emptyStats);
	}

	/**
	 * Create an empty tree.
	 */
	static empty(): MerkleTree {
		return new MerkleTree(null, 0, {
			filesScanned: 0,
			filesIndexed: 0,
			cacheHits: 0,
			cacheMisses: 0,
			filesSkipped: 0,
		});
	}
}

/**
 * Build a lookup map from path to node for quick access.
 */
function buildNodeLookup(root: MerkleNode | null): Map<string, MerkleNode> {
	const lookup = new Map<string, MerkleNode>();

	if (!root) {
		return lookup;
	}

	function traverse(node: MerkleNode): void {
		lookup.set(node.path, node);
		if (node.children) {
			for (const child of node.children.values()) {
				traverse(child);
			}
		}
	}

	traverse(root);
	return lookup;
}

/**
 * Build a directory tree from a flat map of file nodes.
 */
function buildDirectoryTree(
	fileNodes: Map<string, MerkleNode>,
): MerkleNode | null {
	if (fileNodes.size === 0) {
		return null;
	}

	// Build intermediate directory nodes
	const allNodes = new Map<string, MerkleNode>(fileNodes);
	const dirChildren = new Map<string, Map<string, MerkleNode>>();

	// Collect children for each directory
	for (const [filePath] of fileNodes) {
		const parts = filePath.split('/');

		// Build path to each ancestor directory
		for (let i = 1; i <= parts.length; i++) {
			// Parent directory path (empty string for root)
			const dirPath = parts.slice(0, i - 1).join('/');
			const childName = parts[i - 1]!;
			const childPath =
				i === parts.length ? filePath : parts.slice(0, i).join('/');

			if (!dirChildren.has(dirPath)) {
				dirChildren.set(dirPath, new Map());
			}

			// Add the immediate child to its parent directory
			const childNode = allNodes.get(childPath);
			if (childNode) {
				dirChildren.get(dirPath)!.set(childName, childNode);
			}
		}
	}

	// Build directory nodes bottom-up (deepest first)
	const dirPaths = [...dirChildren.keys()].sort(
		(a, b) => b.split('/').length - a.split('/').length,
	);

	for (const dirPath of dirPaths) {
		if (dirPath === '') continue; // Skip root for now

		const children = dirChildren.get(dirPath)!;

		// Collect actual child nodes (may include already-built directories)
		const childNodes = new Map<string, MerkleNode>();
		for (const [name, child] of children) {
			// Check if there's a directory node we built
			const builtDir = allNodes.get(child.path);
			if (builtDir) {
				childNodes.set(name, builtDir);
			}
		}

		// Compute directory hash and create node
		const hash = computeDirectoryHash(childNodes);
		const dirNode = createDirectoryNode(dirPath, hash, childNodes);
		allNodes.set(dirPath, dirNode);

		// Update parent's reference to this directory
		const parentPath = dirPath.includes('/')
			? dirPath.slice(0, dirPath.lastIndexOf('/'))
			: '';
		const dirName = dirPath.includes('/')
			? dirPath.slice(dirPath.lastIndexOf('/') + 1)
			: dirPath;

		if (dirChildren.has(parentPath)) {
			dirChildren.get(parentPath)!.set(dirName, dirNode);
		}
	}

	// Build root node
	const rootChildren = dirChildren.get('');
	if (!rootChildren || rootChildren.size === 0) {
		return null;
	}

	const hash = computeDirectoryHash(rootChildren);
	return createDirectoryNode('', hash, rootChildren);
}

/**
 * Count the number of files in a tree.
 */
function countFiles(node: MerkleNode): number {
	if (node.type === 'file') {
		return 1;
	}

	let count = 0;
	if (node.children) {
		for (const child of node.children.values()) {
			count += countFiles(child);
		}
	}

	return count;
}
