/**
 * Merkle Diff - Tree comparison for change detection.
 *
 * Compares two Merkle trees to find new, modified, and deleted files.
 * Uses hash comparison for efficient subtree comparison.
 */

import type {MerkleNode} from './node.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of comparing two Merkle trees.
 */
export interface TreeDiff {
	/** Paths of new files */
	new: string[];
	/** Paths of modified files */
	modified: string[];
	/** Paths of deleted files */
	deleted: string[];
	/** Whether there are any changes */
	hasChanges: boolean;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an empty TreeDiff.
 */
export function createEmptyDiff(): TreeDiff {
	return {
		new: [],
		modified: [],
		deleted: [],
		hasChanges: false,
	};
}

// ============================================================================
// Tree Comparison
// ============================================================================

/**
 * Collect all file paths from a node (recursively).
 */
function collectAllFiles(node: MerkleNode, paths: string[]): void {
	if (node.type === 'file') {
		paths.push(node.path);
	} else if (node.children) {
		for (const child of node.children.values()) {
			collectAllFiles(child, paths);
		}
	}
}

/**
 * Compare two Merkle nodes and populate the diff.
 */
function compareNodes(
	oldNode: MerkleNode,
	newNode: MerkleNode,
	diff: TreeDiff,
): void {
	// Quick check: if hashes match, entire subtree unchanged
	if (oldNode.hash === newNode.hash) {
		return;
	}

	// File modified
	if (oldNode.type === 'file' && newNode.type === 'file') {
		diff.modified.push(newNode.path);
		return;
	}

	// Type changed (file→dir or dir→file)
	if (oldNode.type !== newNode.type) {
		collectAllFiles(oldNode, diff.deleted);
		collectAllFiles(newNode, diff.new);
		return;
	}

	// Both directories: compare children
	const oldChildren = oldNode.children ?? new Map<string, MerkleNode>();
	const newChildren = newNode.children ?? new Map<string, MerkleNode>();

	// Find new entries (in new but not in old)
	for (const [name, child] of newChildren) {
		if (!oldChildren.has(name)) {
			collectAllFiles(child, diff.new);
		}
	}

	// Find deleted entries (in old but not in new)
	for (const [name, child] of oldChildren) {
		if (!newChildren.has(name)) {
			collectAllFiles(child, diff.deleted);
		}
	}

	// Recurse into shared entries
	for (const [name, newChild] of newChildren) {
		const oldChild = oldChildren.get(name);
		if (oldChild) {
			compareNodes(oldChild, newChild, diff);
		}
	}
}

/**
 * Compare two Merkle trees and return the differences.
 *
 * @param oldRoot - The previous tree's root node (or null if no previous tree)
 * @param newRoot - The current tree's root node
 * @returns TreeDiff with new, modified, and deleted file paths
 */
export function compareTrees(
	oldRoot: MerkleNode | null,
	newRoot: MerkleNode | null,
): TreeDiff {
	const diff = createEmptyDiff();

	// No old tree - everything is new
	if (!oldRoot) {
		if (newRoot) {
			collectAllFiles(newRoot, diff.new);
		}

		diff.hasChanges = diff.new.length > 0;
		return diff;
	}

	// No new tree - everything is deleted
	if (!newRoot) {
		collectAllFiles(oldRoot, diff.deleted);
		diff.hasChanges = diff.deleted.length > 0;
		return diff;
	}

	// Both trees exist - compare them
	compareNodes(oldRoot, newRoot, diff);
	diff.hasChanges =
		diff.new.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;

	return diff;
}
