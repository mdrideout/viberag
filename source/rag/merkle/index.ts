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

	private constructor(root: MerkleNode | null, fileCount: number) {
		this.root = root;
		this.fileCount = fileCount;
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

		// Find all files matching our criteria
		const pattern = '**/*';
		const files = await fg(pattern, {
			cwd: projectRoot,
			dot: true,
			onlyFiles: true,
			ignore: excludePatterns.map((p) => `**/${p}/**`),
		});

		// Filter to valid extensions and non-excluded paths
		const validFiles = files.filter((relativePath) => {
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
		let fileCount = 0;

		for (const relativePath of validFiles) {
			const absolutePath = path.join(projectRoot, relativePath);

			try {
				// Check if it's a binary file
				const binary = await isBinaryFile(absolutePath);
				if (binary) {
					continue;
				}

				// Get file stats
				const stats = await fs.stat(absolutePath);
				const size = stats.size;
				const mtime = stats.mtimeMs;

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
				} else {
					// File is new or changed - compute hash
					hash = await computeFileHash(absolutePath);
				}

				const node = createFileNode(relativePath, hash, size, mtime);
				fileNodes.set(relativePath, node);
				fileCount++;
			} catch {
				// Skip files we can't read
				continue;
			}
		}

		// Build directory structure
		const root = buildDirectoryTree(fileNodes);

		return new MerkleTree(root, fileCount);
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
		if (!data) {
			return new MerkleTree(null, 0);
		}

		const root = deserializeNode(data);
		const fileCount = countFiles(root);
		return new MerkleTree(root, fileCount);
	}

	/**
	 * Create an empty tree.
	 */
	static empty(): MerkleTree {
		return new MerkleTree(null, 0);
	}
}

/**
 * Build a lookup map from path to node for quick access.
 */
function buildNodeLookup(
	root: MerkleNode | null,
): Map<string, MerkleNode> {
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
			const dirPath = i === parts.length ? '' : parts.slice(0, i).join('/');
			const childName = parts[i - 1]!;
			const childPath =
				i === parts.length ? filePath : parts.slice(0, i).join('/');

			if (!dirChildren.has(dirPath)) {
				dirChildren.set(dirPath, new Map());
			}

			// Only add the immediate child
			if (i === 1 || parts.slice(0, i - 1).join('/') === dirPath) {
				const childNode = allNodes.get(childPath);
				if (childNode) {
					dirChildren.get(dirPath)!.set(childName, childNode);
				}
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
