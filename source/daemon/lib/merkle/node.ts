/**
 * Merkle Node - Types and utilities for Merkle tree nodes.
 *
 * A node in the Merkle tree represents either a file or a directory.
 * Files have hash = SHA256(content).
 * Directories have hash = SHA256(sorted child name+hash pairs).
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Type of a Merkle tree node.
 */
export type NodeType = 'file' | 'directory';

/**
 * A node in the Merkle tree.
 */
export interface MerkleNode {
	/** SHA256 hash of content (file) or children (directory) */
	hash: string;
	/** Node type */
	type: NodeType;
	/** Path relative to project root */
	path: string;
	/** Child nodes (directories only) */
	children?: Map<string, MerkleNode>;
	/** File size in bytes (files only) */
	size?: number;
	/** File modification time in Unix ms (files only) */
	mtime?: number;
}

/**
 * Serialized form of a MerkleNode for JSON storage.
 */
export interface SerializedNode {
	hash: string;
	type: NodeType;
	path: string;
	children?: Record<string, SerializedNode>;
	size?: number;
	mtime?: number;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize a MerkleNode to a plain object for JSON storage.
 */
export function serializeNode(node: MerkleNode): SerializedNode {
	const serialized: SerializedNode = {
		hash: node.hash,
		type: node.type,
		path: node.path,
	};

	if (node.children) {
		serialized.children = {};
		for (const [name, child] of node.children) {
			serialized.children[name] = serializeNode(child);
		}
	}

	if (node.size !== undefined) {
		serialized.size = node.size;
	}

	if (node.mtime !== undefined) {
		serialized.mtime = node.mtime;
	}

	return serialized;
}

/**
 * Deserialize a plain object back to a MerkleNode.
 */
export function deserializeNode(data: SerializedNode): MerkleNode {
	const node: MerkleNode = {
		hash: data.hash,
		type: data.type,
		path: data.path,
	};

	if (data.children) {
		node.children = new Map();
		for (const [name, childData] of Object.entries(data.children)) {
			node.children.set(name, deserializeNode(childData));
		}
	}

	if (data.size !== undefined) {
		node.size = data.size;
	}

	if (data.mtime !== undefined) {
		node.mtime = data.mtime;
	}

	return node;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a file node.
 */
export function createFileNode(
	path: string,
	hash: string,
	size: number,
	mtime: number,
): MerkleNode {
	return {
		hash,
		type: 'file',
		path,
		size,
		mtime,
	};
}

/**
 * Create a directory node.
 */
export function createDirectoryNode(
	path: string,
	hash: string,
	children: Map<string, MerkleNode>,
): MerkleNode {
	return {
		hash,
		type: 'directory',
		path,
		children,
	};
}
