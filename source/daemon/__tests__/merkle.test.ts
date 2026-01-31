/**
 * Merkle tree unit tests.
 * Tests tree structure building and change detection (diffing).
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {MerkleTree} from '../lib/merkle/index.js';
import type {MerkleNode} from '../lib/merkle/node.js';
import {
	copyFixtureToTemp,
	addFile,
	modifyFile,
	deleteFile,
	waitForFs,
	type TestContext,
} from './helpers.js';

/**
 * Helper to collect all file paths from tree.
 */
function collectFiles(node: MerkleNode | null): string[] {
	if (!node) return [];
	if (node.type === 'file') return [node.path];

	const files: string[] = [];
	if (node.children) {
		for (const child of node.children.values()) {
			files.push(...collectFiles(child));
		}
	}
	return files;
}

describe('MerkleTree', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await copyFixtureToTemp('codebase');
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Tree structure', () => {
		it('includes all files from nested directories', async () => {
			const tree = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx', '.js', '.py'],
				[],
			);

			// Count all files in tree
			const allFiles = collectFiles(tree.root);

			// Should have all ~15 files (5 original + 10 nested)
			expect(allFiles.length).toBeGreaterThanOrEqual(10);

			// Should include deeply nested file
			expect(allFiles.some(f => f.includes('deep/nested/file.ts'))).toBe(true);

			// Should include files at different levels
			expect(allFiles.some(f => f.includes('src/components/Button.tsx'))).toBe(
				true,
			);
			expect(
				allFiles.some(f => f.includes('src/components/forms/LoginForm.tsx')),
			).toBe(true);
		});

		it('respects .viberagignore patterns', async () => {
			await fs.writeFile(
				path.join(ctx.projectRoot, '.viberagignore'),
				'math.py\n',
			);

			const tree = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx', '.js', '.py'],
				[],
			);

			const allFiles = collectFiles(tree.root);
			expect(allFiles.includes('math.py')).toBe(false);
		});

		it('populates directory children correctly', async () => {
			const tree = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx', '.js', '.py'],
				[],
			);

			// Navigate to src/components
			const src = tree.root?.children?.get('src');
			expect(src).toBeDefined();
			expect(src?.type).toBe('directory');

			const components = src?.children?.get('components');
			expect(components).toBeDefined();
			expect(components?.type).toBe('directory');

			// Should have Button.tsx, Input.tsx, and forms/ as children
			expect(components?.children?.size).toBeGreaterThanOrEqual(2);

			// Check Button.tsx is a child
			const button = components?.children?.get('Button.tsx');
			expect(button).toBeDefined();
			expect(button?.type).toBe('file');
		});

		it('handles 4+ levels of nesting', async () => {
			const tree = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx', '.js', '.py'],
				[],
			);

			// Navigate: src → utils → deep → nested → file.ts
			const src = tree.root?.children?.get('src');
			expect(src).toBeDefined();

			const utils = src?.children?.get('utils');
			expect(utils).toBeDefined();

			const deep = utils?.children?.get('deep');
			expect(deep).toBeDefined();

			const nested = deep?.children?.get('nested');
			expect(nested).toBeDefined();

			const file = nested?.children?.get('file.ts');
			expect(file).toBeDefined();
			expect(file?.type).toBe('file');
			expect(file?.path).toBe('src/utils/deep/nested/file.ts');
		});

		it('handles multiple siblings at each level', async () => {
			const tree = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx', '.js', '.py'],
				[],
			);

			// src/services should have api.ts AND auth.ts
			const services = tree.root?.children
				?.get('src')
				?.children?.get('services');
			expect(services?.children?.has('api.ts')).toBe(true);
			expect(services?.children?.has('auth.ts')).toBe(true);

			// Root should have src/ AND lib/
			expect(tree.root?.children?.has('src')).toBe(true);
			expect(tree.root?.children?.has('lib')).toBe(true);
		});
	});

	describe('Tree diffing', () => {
		it('detects new file in subdirectory', async () => {
			const tree1 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);

			await addFile(
				ctx.projectRoot,
				'src/utils/newHelper.ts',
				'export const x = 1;',
			);
			await waitForFs();

			const tree2 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
				tree1,
			);
			const diff = tree1.compare(tree2);

			expect(diff.new).toContain('src/utils/newHelper.ts');
			expect(diff.modified.length).toBe(0);
			expect(diff.deleted.length).toBe(0);
		});

		it('detects modified file in deeply nested directory', async () => {
			const tree1 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);

			await modifyFile(
				ctx.projectRoot,
				'src/utils/deep/nested/file.ts',
				'// changed\nexport const y = 2;',
			);
			await waitForFs();

			const tree2 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
				tree1,
			);
			const diff = tree1.compare(tree2);

			expect(diff.modified).toContain('src/utils/deep/nested/file.ts');
		});

		it('detects deleted file from subdirectory', async () => {
			const tree1 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);

			await deleteFile(ctx.projectRoot, 'src/components/Input.tsx');
			await waitForFs();

			const tree2 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
				tree1,
			);
			const diff = tree1.compare(tree2);

			expect(diff.deleted).toContain('src/components/Input.tsx');
		});

		it('detects new directory with files', async () => {
			const tree1 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);

			// Add new directory with multiple files
			await addFile(ctx.projectRoot, 'src/newDir/a.ts', 'export const a = 1;');
			await addFile(ctx.projectRoot, 'src/newDir/b.ts', 'export const b = 2;');
			await waitForFs();

			const tree2 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
				tree1,
			);
			const diff = tree1.compare(tree2);

			expect(diff.new).toContain('src/newDir/a.ts');
			expect(diff.new).toContain('src/newDir/b.ts');
		});

		it('directory hash changes when child file changes', async () => {
			const tree1 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);
			const srcHash1 = tree1.root?.children?.get('src')?.hash;
			const utilsHash1 = tree1.root?.children
				?.get('src')
				?.children?.get('utils')?.hash;

			await modifyFile(ctx.projectRoot, 'src/utils/helpers.ts', '// changed');
			await waitForFs();

			const tree2 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);
			const srcHash2 = tree2.root?.children?.get('src')?.hash;
			const utilsHash2 = tree2.root?.children
				?.get('src')
				?.children?.get('utils')?.hash;

			// Both parent directories should have different hashes
			expect(utilsHash2).not.toBe(utilsHash1);
			expect(srcHash2).not.toBe(srcHash1);
		});

		it('sibling directory hash unchanged when other sibling changes', async () => {
			const tree1 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);
			const servicesHash1 = tree1.root?.children
				?.get('src')
				?.children?.get('services')?.hash;

			// Modify file in utils (sibling of services)
			await modifyFile(ctx.projectRoot, 'src/utils/helpers.ts', '// changed');
			await waitForFs();

			const tree2 = await MerkleTree.build(
				ctx.projectRoot,
				['.ts', '.tsx'],
				[],
			);
			const servicesHash2 = tree2.root?.children
				?.get('src')
				?.children?.get('services')?.hash;

			// Services hash should be unchanged
			expect(servicesHash2).toBe(servicesHash1);
		});
	});
});
