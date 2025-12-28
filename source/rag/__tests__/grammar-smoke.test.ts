/**
 * Grammar Smoke Tests
 *
 * Fast tests that verify each tree-sitter grammar loads and can parse basic code.
 * These tests run in ~1 second and catch native module loading issues early.
 *
 * Critical for CI/CD to verify prebuilt binaries work on each platform.
 */

import {describe, it, expect} from 'vitest';
import {createRequire} from 'node:module';
import Parser from 'tree-sitter';

const require = createRequire(import.meta.url);

interface GrammarTestCase {
	name: string;
	pkg: string;
	code: string;
	expectedRootType?: string;
}

const GRAMMARS: GrammarTestCase[] = [
	{
		name: 'javascript',
		pkg: 'tree-sitter-javascript',
		code: 'function foo() { return 42; }',
		expectedRootType: 'program',
	},
	{
		name: 'typescript',
		pkg: 'tree-sitter-typescript/typescript',
		code: 'const x: number = 1;',
		expectedRootType: 'program',
	},
	{
		name: 'tsx',
		pkg: 'tree-sitter-typescript/tsx',
		code: 'const X = () => <div>Hello</div>;',
		expectedRootType: 'program',
	},
	{
		name: 'python',
		pkg: 'tree-sitter-python',
		code: 'def foo():\n    return 42',
		expectedRootType: 'module',
	},
	{
		name: 'go',
		pkg: 'tree-sitter-go',
		code: 'package main\n\nfunc main() {}',
		expectedRootType: 'source_file',
	},
	{
		name: 'rust',
		pkg: 'tree-sitter-rust',
		code: 'fn main() { println!("Hello"); }',
		expectedRootType: 'source_file',
	},
	{
		name: 'java',
		pkg: 'tree-sitter-java',
		code: 'public class Main { public static void main(String[] args) {} }',
		expectedRootType: 'program',
	},
	{
		name: 'csharp',
		pkg: 'tree-sitter-c-sharp',
		code: 'namespace Sample { public class Foo {} }',
		expectedRootType: 'compilation_unit',
	},
	{
		name: 'kotlin',
		pkg: 'tree-sitter-kotlin',
		code: 'fun main() { println("Hello") }',
		expectedRootType: 'source_file',
	},
	{
		name: 'swift',
		pkg: 'tree-sitter-swift',
		code: 'func greet() -> String { return "Hello" }',
		expectedRootType: 'source_file',
	},
	{
		name: 'dart',
		pkg: '@sengac/tree-sitter-dart',
		code: 'void main() { print("Hello"); }',
		expectedRootType: 'program',
	},
	{
		name: 'php',
		pkg: 'tree-sitter-php/php',
		code: '<?php\nfunction foo() { return 42; }',
		expectedRootType: 'program',
	},
];

describe('Grammar Smoke Tests', () => {
	it.each(GRAMMARS)('$name: loads and parses correctly', ({pkg, code}) => {
		// Load grammar
		const grammar = require(pkg);

		// Create parser and set language
		const parser = new Parser();
		parser.setLanguage(grammar);

		// Parse code
		const tree = parser.parse(code);

		// Verify parsing succeeded
		expect(tree).toBeDefined();
		expect(tree.rootNode).toBeDefined();
		expect(tree.rootNode.type).toBeDefined();

		// Verify no parse errors (syntax errors in the test code)
		// Note: hasError is a property, not a method, in native tree-sitter
		expect(tree.rootNode.hasError).toBe(false);
	});

	it.each(GRAMMARS)(
		'$name: root node type is $expectedRootType',
		({pkg, code, expectedRootType}) => {
			if (!expectedRootType) return; // Skip if no expected type

			const grammar = require(pkg);
			const parser = new Parser();
			parser.setLanguage(grammar);
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
		};

		console.log('Platform info:', JSON.stringify(info, null, 2));

		// Verify we're on a supported platform
		expect(['darwin', 'linux', 'win32']).toContain(process.platform);
		expect(['x64', 'arm64']).toContain(process.arch);
	});

	it('tree-sitter core loads correctly', () => {
		expect(Parser).toBeDefined();
		expect(typeof Parser).toBe('function');

		const parser = new Parser();
		expect(parser).toBeInstanceOf(Parser);
	});

	it('all 12 grammars are tested', () => {
		expect(GRAMMARS.length).toBe(12);

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
		expect(names).toContain('dart');
		expect(names).toContain('php');
	});
});
