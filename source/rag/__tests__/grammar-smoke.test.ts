/**
 * Grammar Smoke Tests
 *
 * Fast tests that verify each web-tree-sitter WASM grammar loads and can parse basic code.
 * These tests run in ~2 seconds and catch WASM loading issues early.
 *
 * Critical for CI/CD to verify WASM grammars work on all platforms.
 */

import {describe, it, expect, beforeAll} from 'vitest';
import {createRequire} from 'node:module';
import path from 'node:path';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);

interface GrammarTestCase {
	name: string;
	wasmFile: string;
	code: string;
	expectedRootType?: string;
}

const GRAMMARS: GrammarTestCase[] = [
	{
		name: 'javascript',
		wasmFile: 'tree-sitter-javascript.wasm',
		code: 'function foo() { return 42; }',
		expectedRootType: 'program',
	},
	{
		name: 'typescript',
		wasmFile: 'tree-sitter-typescript.wasm',
		code: 'const x: number = 1;',
		expectedRootType: 'program',
	},
	{
		name: 'tsx',
		wasmFile: 'tree-sitter-tsx.wasm',
		code: 'const X = () => <div>Hello</div>;',
		expectedRootType: 'program',
	},
	{
		name: 'python',
		wasmFile: 'tree-sitter-python.wasm',
		code: 'def foo():\n    return 42',
		expectedRootType: 'module',
	},
	{
		name: 'go',
		wasmFile: 'tree-sitter-go.wasm',
		code: 'package main\n\nfunc main() {}',
		expectedRootType: 'source_file',
	},
	{
		name: 'rust',
		wasmFile: 'tree-sitter-rust.wasm',
		code: 'fn main() { println!("Hello"); }',
		expectedRootType: 'source_file',
	},
	{
		name: 'java',
		wasmFile: 'tree-sitter-java.wasm',
		code: 'public class Main { public static void main(String[] args) {} }',
		expectedRootType: 'program',
	},
	{
		name: 'csharp',
		wasmFile: 'tree-sitter-c_sharp.wasm',
		code: 'namespace Sample { public class Foo {} }',
		expectedRootType: 'compilation_unit',
	},
	{
		name: 'kotlin',
		wasmFile: 'tree-sitter-kotlin.wasm',
		code: 'fun main() { println("Hello") }',
		expectedRootType: 'source_file',
	},
	{
		name: 'swift',
		wasmFile: 'tree-sitter-swift.wasm',
		code: 'func greet() -> String { return "Hello" }',
		expectedRootType: 'source_file',
	},
	// Note: Dart grammar temporarily disabled due to tree-sitter version mismatch
	// tree-sitter-wasms Dart WASM is version 15, but web-tree-sitter 0.24.7 supports 13-14
	// TODO: Re-enable when web-tree-sitter updates or use alternative Dart WASM
	// {
	// 	name: 'dart',
	// 	wasmFile: 'tree-sitter-dart.wasm',
	// 	code: 'void main() { print("Hello"); }',
	// 	expectedRootType: 'program',
	// },
	{
		name: 'php',
		wasmFile: 'tree-sitter-php.wasm',
		code: '<?php\nfunction foo() { return 42; }',
		expectedRootType: 'program',
	},
];

// Resolve WASM base path
const wasmPackagePath = require.resolve('tree-sitter-wasms/package.json');
const wasmBasePath = path.join(path.dirname(wasmPackagePath), 'out');

describe('Grammar Smoke Tests', () => {
	let parser: Parser;

	beforeAll(async () => {
		// Initialize web-tree-sitter WASM module
		await Parser.init();
		parser = new Parser();
	});

	it.each(GRAMMARS)(
		'$name: loads and parses correctly',
		async ({wasmFile, code}) => {
			// Load grammar from WASM
			const wasmPath = path.join(wasmBasePath, wasmFile);
			const language = await Parser.Language.load(wasmPath);

			// Set language and parse
			parser.setLanguage(language);
			const tree = parser.parse(code);

			// Verify parsing succeeded
			expect(tree).toBeDefined();
			expect(tree.rootNode).toBeDefined();
			expect(tree.rootNode.type).toBeDefined();

			// Verify no parse errors (syntax errors in the test code)
			expect(tree.rootNode.hasError).toBe(false);
		},
	);

	it.each(GRAMMARS)(
		'$name: root node type is $expectedRootType',
		async ({wasmFile, code, expectedRootType}) => {
			if (!expectedRootType) return; // Skip if no expected type

			const wasmPath = path.join(wasmBasePath, wasmFile);
			const language = await Parser.Language.load(wasmPath);
			parser.setLanguage(language);
			const tree = parser.parse(code);

			expect(tree.rootNode.type).toBe(expectedRootType);
		},
	);

	it('reports platform and Node.js info', () => {
		const info = {
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.version,
			grammarsLoaded: GRAMMARS.length,
			wasmBasePath,
		};

		console.log('Platform info:', JSON.stringify(info, null, 2));

		// Verify we're on a supported platform
		expect(['darwin', 'linux', 'win32']).toContain(process.platform);
		expect(['x64', 'arm64']).toContain(process.arch);
	});

	it('web-tree-sitter core loads correctly', async () => {
		expect(Parser).toBeDefined();
		expect(typeof Parser).toBe('function');

		// Parser.init() already called in beforeAll
		const testParser = new Parser();
		expect(testParser).toBeDefined();
	});

	it('all 11 grammars are tested (Dart temporarily disabled)', () => {
		// Note: Dart disabled due to tree-sitter version mismatch (version 15 vs supported 13-14)
		expect(GRAMMARS.length).toBe(11);

		const names = GRAMMARS.map(g => g.name);
		expect(names).toContain('javascript');
		expect(names).toContain('typescript');
		expect(names).toContain('tsx');
		expect(names).toContain('python');
		expect(names).toContain('go');
		expect(names).toContain('rust');
		expect(names).toContain('java');
		expect(names).toContain('csharp');
		expect(names).toContain('kotlin');
		expect(names).toContain('swift');
		// expect(names).toContain('dart'); // Temporarily disabled
		expect(names).toContain('php');
	});
});
