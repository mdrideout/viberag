/**
 * Chunker - Tree-sitter based code chunking.
 *
 * Uses web-tree-sitter (WASM) to parse code and extract semantic chunks
 * (functions, classes, methods) for embedding.
 */

import path from 'node:path';
import {createRequire} from 'node:module';
import Parser from 'web-tree-sitter';
import {computeStringHash} from '../merkle/hash.js';
import {
	EXTENSION_TO_LANGUAGE,
	type AnalyzedFile,
	type Chunk,
	type ChunkType,
	type ExtractedRef,
	type RefExtractionOptions,
	type SupportedLanguage,
} from './types.js';
import {LANGUAGE_WASM_FILES} from './grammars.js';

// Use createRequire to resolve WASM file paths from tree-sitter-wasms
const require = createRequire(import.meta.url);

type TokenFacts = {
	identifiers: string[];
	identifierParts: string[];
	calledNames: string[];
	stringLiterals: string[];
};

/**
 * Node types that represent functions in each language.
 */
const FUNCTION_NODE_TYPES: Record<SupportedLanguage, string[]> = {
	// JavaScript/TypeScript
	javascript: ['function_declaration', 'function_expression', 'arrow_function'],
	typescript: ['function_declaration', 'function_expression', 'arrow_function'],
	tsx: ['function_declaration', 'function_expression', 'arrow_function'],
	// Python
	python: ['function_definition'],
	// Go
	go: ['function_declaration'],
	// Rust
	rust: ['function_item'],
	// Java
	java: ['method_declaration', 'constructor_declaration'],
	// C#
	csharp: ['method_declaration', 'constructor_declaration'],
	// Dart
	dart: ['function_signature', 'method_signature'],
	// Swift
	swift: ['function_declaration'],
	// Kotlin
	kotlin: ['function_declaration'],
	// PHP
	php: ['function_definition', 'method_declaration'],
};

/**
 * Node types that represent classes in each language.
 */
const CLASS_NODE_TYPES: Record<SupportedLanguage, string[]> = {
	// JavaScript/TypeScript
	javascript: ['class_declaration'],
	typescript: ['class_declaration'],
	tsx: ['class_declaration'],
	// Python
	python: ['class_definition'],
	// Go (structs via type declarations)
	go: ['type_declaration'],
	// Rust
	rust: ['struct_item', 'impl_item', 'enum_item', 'trait_item'],
	// Java
	java: ['class_declaration', 'interface_declaration', 'enum_declaration'],
	// C#
	csharp: [
		'class_declaration',
		'interface_declaration',
		'struct_declaration',
		'enum_declaration',
	],
	// Dart
	dart: ['class_definition'],
	// Swift
	swift: ['class_declaration', 'struct_declaration', 'protocol_declaration'],
	// Kotlin
	kotlin: ['class_declaration', 'object_declaration', 'interface_declaration'],
	// PHP
	php: ['class_declaration', 'interface_declaration', 'trait_declaration'],
};

/**
 * Node types that represent methods in each language.
 */
const METHOD_NODE_TYPES: Record<SupportedLanguage, string[]> = {
	// JavaScript/TypeScript
	javascript: ['method_definition'],
	typescript: ['method_definition'],
	tsx: ['method_definition'],
	// Python (function_definition inside class)
	python: ['function_definition'],
	// Go
	go: ['method_declaration'],
	// Rust (function_item inside impl)
	rust: ['function_item'],
	// Java
	java: ['method_declaration'],
	// C#
	csharp: ['method_declaration'],
	// Dart
	dart: ['method_signature'],
	// Swift
	swift: ['function_declaration'],
	// Kotlin
	kotlin: ['function_declaration'],
	// PHP
	php: ['method_declaration'],
};

/**
 * Node types that indicate export in JS/TS.
 */
const EXPORT_WRAPPER_TYPES = [
	'export_statement',
	'export_specifier',
	'lexical_declaration', // May have export modifier
];

/**
 * Default max chunk size in characters.
 */
const DEFAULT_MAX_CHUNK_SIZE = 2000;

/**
 * Minimum chunk size before merging with siblings.
 */
const MIN_CHUNK_SIZE = 100;

/**
 * Default overlap in lines for non-AST chunks (unsupported languages).
 * Provides context continuity for embeddings at chunk boundaries.
 */
const DEFAULT_OVERLAP_LINES = 5;

/**
 * Overlap in lines for markdown chunks.
 * Slightly higher than code for better natural language context.
 */
const MARKDOWN_OVERLAP_LINES = 7;

/**
 * Target chunk size in lines for markdown files.
 */
const MARKDOWN_TARGET_LINES = 60;

/**
 * Markdown file extensions.
 */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

/**
 * Chunker that uses web-tree-sitter (WASM) to extract semantic code chunks.
 * Provides 100% platform compatibility - no native compilation required.
 */
export class Chunker {
	private parser: Parser | null = null;
	private languages: Map<SupportedLanguage, Parser.Language> = new Map();
	private initialized = false;
	private wasmBasePath: string | null = null;

	constructor() {
		// Parser instance created in initialize()
	}

	/**
	 * Initialize web-tree-sitter and load language grammars.
	 * Must be called before using chunkFile().
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		// Initialize the web-tree-sitter WASM module
		await Parser.init();

		// Create parser instance after init
		this.parser = new Parser();

		try {
			// Resolve the path to tree-sitter-wasms/out/
			const wasmPackagePath = require.resolve('tree-sitter-wasms/package.json');
			this.wasmBasePath = path.join(path.dirname(wasmPackagePath), 'out');

			// Load all language grammars sequentially (skip null entries like Dart)
			// IMPORTANT: Must be sequential - web-tree-sitter has global state that
			// gets corrupted when loading multiple WASM modules in parallel.
			for (const [lang, wasmFile] of Object.entries(LANGUAGE_WASM_FILES)) {
				if (!wasmFile) {
					// Language temporarily disabled (e.g., Dart due to version mismatch)
					continue;
				}
				try {
					const wasmPath = path.join(this.wasmBasePath!, wasmFile);
					const language = await Parser.Language.load(wasmPath);
					this.languages.set(lang as SupportedLanguage, language);
				} catch (error) {
					// Log but don't fail - we can still work with other languages
					console.error(`Failed to load ${lang} grammar:`, error);
				}
			}
			this.initialized = true;
		} catch (error) {
			// Cleanup parser on failure to prevent resource leak
			if (this.parser) {
				this.parser.delete();
				this.parser = null;
			}
			this.wasmBasePath = null;
			this.languages.clear();
			throw error;
		}
	}

	/**
	 * Get the language for a file extension.
	 */
	getLanguageForExtension(ext: string): SupportedLanguage | null {
		return EXTENSION_TO_LANGUAGE[ext] ?? null;
	}

	/**
	 * Check if a language is supported.
	 */
	isLanguageSupported(lang: SupportedLanguage): boolean {
		return this.languages.has(lang);
	}

	/**
	 * Check if a file is a markdown file.
	 */
	private isMarkdownFile(filepath: string): boolean {
		const ext = path.extname(filepath).toLowerCase();
		return MARKDOWN_EXTENSIONS.has(ext);
	}

	/**
	 * Extract chunks from a file.
	 *
	 * @param filepath - Path to the file (used for extension detection and context headers)
	 * @param content - File content to parse
	 * @param maxChunkSize - Maximum chunk size in characters (default: 2000)
	 * @returns Array of extracted chunks
	 */
	chunkFile(
		filepath: string,
		content: string,
		maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE,
	): Chunk[] {
		if (!this.initialized || !this.parser) {
			throw new Error(
				'Chunker not initialized. Call initialize() before chunkFile().',
			);
		}

		// Determine language from extension
		const ext = path.extname(filepath);
		const lang = this.getLanguageForExtension(ext);

		// Handle markdown files with heading-aware chunking
		if (this.isMarkdownFile(filepath)) {
			return this.chunkMarkdown(filepath, content, maxChunkSize);
		}

		if (!lang || !this.languages.has(lang)) {
			// Unsupported language - return module-level chunk (with size enforcement + overlap)
			const moduleChunk = this.createModuleChunk(filepath, content);
			return this.enforceSizeLimits(
				[moduleChunk],
				maxChunkSize,
				content,
				lang ?? 'javascript', // Use any lang for splitting (line-based)
				filepath,
				DEFAULT_OVERLAP_LINES, // Add overlap for context continuity
			);
		}

		// Set parser language
		const language = this.languages.get(lang)!;
		this.parser.setLanguage(language);

		// Parse the content
		const tree = this.parser.parse(content);

		// If parsing failed, fall back to module chunk (with size enforcement + overlap)
		if (!tree) {
			const moduleChunk = this.createModuleChunk(filepath, content);
			return this.enforceSizeLimits(
				[moduleChunk],
				maxChunkSize,
				content,
				lang,
				filepath,
				DEFAULT_OVERLAP_LINES, // Add overlap for context continuity
			);
		}

		// Extract chunks based on language with context tracking
		const chunks = this.extractChunks(
			tree.rootNode,
			content,
			lang,
			filepath,
			maxChunkSize,
		);

		// If no chunks found, fall back to module chunk (with size enforcement + overlap)
		if (chunks.length === 0) {
			const moduleChunk = this.createModuleChunk(filepath, content);
			return this.enforceSizeLimits(
				[moduleChunk],
				maxChunkSize,
				content,
				lang,
				filepath,
				DEFAULT_OVERLAP_LINES, // Add overlap for context continuity
			);
		}

		// Split oversized chunks and merge tiny ones
		const sizedChunks = this.enforceSizeLimits(
			chunks,
			maxChunkSize,
			content,
			lang,
			filepath,
		);

		return sizedChunks;
	}

	/**
	 * Analyze a file by parsing once and extracting:
	 * - definition_chunks: unsplit, unmerged semantic definitions (functions/classes/methods)
	 * - chunks: size-constrained chunks (may split large bodies)
	 * - refs: AST-derived references (calls/imports/identifiers), suitable for usage navigation
	 *
	 * This is intended for indexing pipelines that need multiple artifacts without
	 * re-parsing the file multiple times.
	 */
	analyzeFile(
		filepath: string,
		content: string,
		options: {
			chunkMaxSize: number;
			definitionMaxChunkSize?: number;
			refs?: RefExtractionOptions;
		},
	): AnalyzedFile {
		if (!this.initialized || !this.parser) {
			throw new Error(
				'Chunker not initialized. Call initialize() before analyzeFile().',
			);
		}

		const chunkMaxSize = options.chunkMaxSize;
		const definitionMaxChunkSize = options.definitionMaxChunkSize ?? 1_000_000;
		const refsOptions = options.refs ?? {};

		const ext = path.extname(filepath);
		const lang = this.getLanguageForExtension(ext);

		if (this.isMarkdownFile(filepath)) {
			return {
				language: null,
				parse_status: 'markdown',
				definition_chunks: [],
				chunks: this.chunkMarkdown(filepath, content, chunkMaxSize),
				refs: [],
			};
		}

		if (!lang || !this.languages.has(lang)) {
			const moduleChunk = this.createModuleChunk(filepath, content);
			return {
				language: null,
				parse_status: 'unsupported',
				definition_chunks: [],
				chunks: this.enforceSizeLimits(
					[moduleChunk],
					chunkMaxSize,
					content,
					lang ?? 'javascript',
					filepath,
					DEFAULT_OVERLAP_LINES,
				),
				refs: [],
			};
		}

		const language = this.languages.get(lang)!;
		this.parser.setLanguage(language);

		const tree = this.parser.parse(content);
		if (!tree) {
			const moduleChunk = this.createModuleChunk(filepath, content);
			return {
				language: lang,
				parse_status: 'parse_failed',
				definition_chunks: [],
				chunks: this.enforceSizeLimits(
					[moduleChunk],
					chunkMaxSize,
					content,
					lang,
					filepath,
					DEFAULT_OVERLAP_LINES,
				),
				refs: [],
			};
		}

		const definition_chunks = this.extractChunks(
			tree.rootNode,
			content,
			lang,
			filepath,
			definitionMaxChunkSize,
		);

		const chunks = this.enforceSizeLimits(
			this.extractChunks(tree.rootNode, content, lang, filepath, chunkMaxSize),
			chunkMaxSize,
			content,
			lang,
			filepath,
		);

		const refs = this.extractRefsFromTree(tree.rootNode, lang, refsOptions);

		return {
			language: lang,
			parse_status: 'parsed',
			definition_chunks,
			chunks,
			refs,
		};
	}

	/**
	 * Extract chunks from a syntax tree.
	 */
	private extractChunks(
		root: Parser.SyntaxNode,
		content: string,
		lang: SupportedLanguage,
		filepath: string,
		maxChunkSize: number,
	): Chunk[] {
		const chunks: Chunk[] = [];
		const lines = content.split('\n');

		// Traverse the tree with context tracking
		this.traverseNode(root, lang, lines, chunks, filepath, null, maxChunkSize);

		return chunks;
	}

	/**
	 * Recursively traverse nodes to extract chunks.
	 * Tracks parent context (class name) for context headers.
	 */
	private traverseNode(
		node: Parser.SyntaxNode,
		lang: SupportedLanguage,
		lines: string[],
		chunks: Chunk[],
		filepath: string,
		parentClassName: string | null,
		maxChunkSize: number,
	): void {
		const nodeType = node.type;

		// Check for class
		if (CLASS_NODE_TYPES[lang].includes(nodeType)) {
			const className = this.extractName(node, lang);
			const classChunks = this.nodeToChunks(
				node,
				lines,
				'class',
				lang,
				filepath,
				null,
				maxChunkSize,
			);
			chunks.push(...classChunks);

			// Also extract methods from inside the class
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child) {
					this.traverseNode(
						child,
						lang,
						lines,
						chunks,
						filepath,
						className,
						maxChunkSize,
					);
				}
			}

			return;
		}

		// Check for function/method
		const functionTypes = FUNCTION_NODE_TYPES[lang];
		const methodTypes = METHOD_NODE_TYPES[lang];

		if (parentClassName && methodTypes.includes(nodeType)) {
			// This is a method inside a class
			const methodChunks = this.nodeToChunks(
				node,
				lines,
				'method',
				lang,
				filepath,
				parentClassName,
				maxChunkSize,
			);
			chunks.push(...methodChunks);

			return;
		}

		if (!parentClassName && functionTypes.includes(nodeType)) {
			// This is a top-level function
			const functionChunks = this.nodeToChunks(
				node,
				lines,
				'function',
				lang,
				filepath,
				null,
				maxChunkSize,
			);
			chunks.push(...functionChunks);

			return;
		}

		// Recurse into children
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child) {
				this.traverseNode(
					child,
					lang,
					lines,
					chunks,
					filepath,
					parentClassName,
					maxChunkSize,
				);
			}
		}
	}

	/**
	 * Convert a syntax node to a chunk.
	 */
	private nodeToChunk(
		node: Parser.SyntaxNode,
		lines: string[],
		type: ChunkType,
		lang: SupportedLanguage,
		filepath: string,
		parentClassName: string | null,
	): Chunk | null {
		// Get name from the node
		const name = this.extractName(node, lang);

		// Get start and end lines (1-indexed)
		const startLine = node.startPosition.row + 1;
		const endLine = node.endPosition.row + 1;

		// Extract text
		const text = lines.slice(startLine - 1, endLine).join('\n');

		if (!text.trim()) {
			return null;
		}

		// Build context header
		const contextHeader = this.buildContextHeader(
			filepath,
			parentClassName,
			type === 'method' ? null : name, // Don't include function name for methods (class provides context)
			false,
		);

		// Hash includes context header for unique embedding per context
		const fullText = contextHeader ? `${contextHeader}\n${text}` : text;

		// Extract new metadata fields
		const signature = this.extractSignature(node, lines, lang);
		const docstring = this.extractDocstring(node, lang);
		const isExported = this.extractIsExported(node, lang);
		const decoratorNames = this.extractDecoratorNames(node, lang);
		const tokenFacts = this.extractAstTokenFacts(node, lang);

		return {
			text,
			contextHeader,
			type,
			name,
			startLine,
			endLine,
			startByte: node.startIndex,
			endByte: node.endIndex,
			contentHash: computeStringHash(fullText),
			signature,
			docstring,
			isExported,
			decoratorNames,
			identifiers: tokenFacts.identifiers,
			identifierParts: tokenFacts.identifierParts,
			calledNames: tokenFacts.calledNames,
			stringLiterals: tokenFacts.stringLiterals,
		};
	}

	private nodeToChunks(
		node: Parser.SyntaxNode,
		lines: string[],
		type: ChunkType,
		lang: SupportedLanguage,
		filepath: string,
		parentClassName: string | null,
		maxChunkSize: number,
	): Chunk[] {
		const base = this.nodeToChunk(
			node,
			lines,
			type,
			lang,
			filepath,
			parentClassName,
		);
		if (!base) return [];
		if (base.text.length <= maxChunkSize) return [base];

		if (type === 'function' || type === 'method') {
			const split = this.splitNodeByStatementGroups({
				node,
				lines,
				lang,
				filepath,
				parentClassName,
				type,
				base,
				maxChunkSize,
			});
			if (split.length > 0) {
				return split;
			}
		}

		// Fall back to line-based splitting in enforceSizeLimits().
		return [base];
	}

	private splitNodeByStatementGroups(args: {
		node: Parser.SyntaxNode;
		lines: string[];
		lang: SupportedLanguage;
		filepath: string;
		parentClassName: string | null;
		type: 'function' | 'method';
		base: Chunk;
		maxChunkSize: number;
	}): Chunk[] {
		const body = args.node.childForFieldName('body');
		if (!body || body.namedChildCount === 0) return [];

		const statements: Parser.SyntaxNode[] = [];
		for (let i = 0; i < body.namedChildCount; i++) {
			const child = body.namedChild(i);
			if (child) statements.push(child);
		}
		if (statements.length === 0) return [];

		const chunks: Chunk[] = [];
		const baseStartLine = args.base.startLine;
		const baseEndLine = args.base.endLine;
		const baseStartByte = args.base.startByte;
		const baseEndByte = args.base.endByte;

		if (baseStartByte == null || baseEndByte == null) return [];

		let groupStartLine = baseStartLine;
		let groupStartByte = baseStartByte;
		let groupEndLine = baseStartLine;
		let groupEndByte = baseStartByte;
		let groupHasAny = false;

		const flush = (isLast: boolean) => {
			if (!groupHasAny) return;
			const endLine = isLast ? baseEndLine : groupEndLine;
			const endByte = isLast ? baseEndByte : groupEndByte;
			const text = args.lines.slice(groupStartLine - 1, endLine).join('\n');
			if (!text.trim()) return;

			const isContinuation = chunks.length > 0;
			const functionName =
				isContinuation && args.base.name
					? args.base.name
					: args.type === 'method'
						? null
						: args.base.name;
			const contextHeader = this.buildContextHeader(
				args.filepath,
				args.parentClassName,
				functionName,
				isContinuation,
			);
			const fullText = `${contextHeader}\n${text}`;
			const tokenFacts = this.extractAstTokenFacts(args.node, args.lang, {
				startIndex: groupStartByte,
				endIndex: endByte,
			});

			chunks.push({
				text,
				contextHeader,
				type: args.type,
				name: args.base.name,
				startLine: groupStartLine,
				endLine,
				startByte: groupStartByte,
				endByte,
				contentHash: computeStringHash(fullText),
				signature: isContinuation ? null : args.base.signature,
				docstring: isContinuation ? null : args.base.docstring,
				isExported: args.base.isExported,
				decoratorNames: isContinuation ? null : args.base.decoratorNames,
				identifiers: tokenFacts.identifiers,
				identifierParts: tokenFacts.identifierParts,
				calledNames: tokenFacts.calledNames,
				stringLiterals: tokenFacts.stringLiterals,
			});

			groupHasAny = false;
		};

		for (const stmt of statements) {
			const stmtStartLine = stmt.startPosition.row + 1;
			const stmtEndLine = stmt.endPosition.row + 1;

			const candidateEndLine = stmtEndLine;
			const candidateText = args.lines
				.slice(groupStartLine - 1, candidateEndLine)
				.join('\n');

			if (
				candidateText.length > args.maxChunkSize &&
				groupHasAny &&
				chunks.length < 2000
			) {
				flush(false);
				groupStartLine = stmtStartLine;
				groupStartByte = stmt.startIndex;
			}

			groupEndLine = stmtEndLine;
			groupEndByte = stmt.endIndex;
			groupHasAny = true;
		}

		flush(true);

		return chunks;
	}

	/**
	 * Extract the signature line (first line of function/class declaration).
	 */
	private extractSignature(
		node: Parser.SyntaxNode,
		lines: string[],
		lang: SupportedLanguage,
	): string | null {
		const startLine = node.startPosition.row;

		// Python: Signature ends with colon
		if (lang === 'python') {
			let signatureEnd = startLine;
			for (let i = startLine; i < lines.length && i < startLine + 10; i++) {
				const line = lines[i];
				if (line?.includes(':')) {
					signatureEnd = i;
					break;
				}
			}
			return lines
				.slice(startLine, signatureEnd + 1)
				.join('\n')
				.trim();
		}

		// C-style languages (Go, Rust, Java, C#, Swift, Kotlin, Dart, PHP):
		// Signature ends at opening brace, may span multiple lines
		if (
			lang === 'go' ||
			lang === 'rust' ||
			lang === 'java' ||
			lang === 'csharp' ||
			lang === 'swift' ||
			lang === 'kotlin' ||
			lang === 'dart' ||
			lang === 'php'
		) {
			const signatureLines: string[] = [];
			for (let i = startLine; i < lines.length && i < startLine + 10; i++) {
				const line = lines[i];
				if (!line) continue;
				signatureLines.push(line);

				// Check for opening brace to end signature
				if (line.includes('{')) {
					const lastLine = signatureLines[signatureLines.length - 1];
					if (lastLine) {
						const braceIndex = lastLine.indexOf('{');
						signatureLines[signatureLines.length - 1] = lastLine
							.slice(0, braceIndex)
							.trim();
					}
					break;
				}
			}
			const result = signatureLines.join('\n').trim();
			return result || null;
		}

		// JS/TS: First line up to opening brace or arrow
		const firstLine = lines[startLine];
		if (!firstLine) return null;

		// Remove opening brace and body
		const braceIndex = firstLine.indexOf('{');
		if (braceIndex !== -1) {
			return firstLine.slice(0, braceIndex).trim();
		}

		// Arrow function might not have brace on same line
		const arrowIndex = firstLine.indexOf('=>');
		if (arrowIndex !== -1) {
			return firstLine.slice(0, arrowIndex + 2).trim();
		}

		return firstLine.trim();
	}

	/**
	 * Extract docstring from a function/class node.
	 */
	private extractDocstring(
		node: Parser.SyntaxNode,
		lang: SupportedLanguage,
	): string | null {
		// Python: Docstring as first string in body
		if (lang === 'python') {
			const body = node.childForFieldName('body');
			if (!body) return null;

			const firstStatement = body.child(0);
			if (firstStatement?.type === 'expression_statement') {
				const stringNode = firstStatement.child(0);
				if (stringNode?.type === 'string') {
					let text = stringNode.text;
					if (text.startsWith('"""') || text.startsWith("'''")) {
						text = text.slice(3, -3);
					} else if (text.startsWith('"') || text.startsWith("'")) {
						text = text.slice(1, -1);
					}
					return text.trim() || null;
				}
			}
			return null;
		}

		// Go: // comment(s) immediately before
		if (lang === 'go') {
			const comments: string[] = [];
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'comment') {
					const text = sibling.text.replace(/^\/\/\s*/, '');
					comments.unshift(text);
				} else {
					break;
				}
				sibling = sibling.previousSibling;
			}
			return comments.length > 0 ? comments.join('\n').trim() : null;
		}

		// Rust: /// or //! doc comments
		if (lang === 'rust') {
			const comments: string[] = [];
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'line_comment') {
					const text = sibling.text;
					if (text.startsWith('///') || text.startsWith('//!')) {
						comments.unshift(text.replace(/^\/\/[/!]\s*/, ''));
					} else {
						break;
					}
				} else if (sibling.type === 'block_comment') {
					break;
				} else {
					break;
				}
				sibling = sibling.previousSibling;
			}
			return comments.length > 0 ? comments.join('\n').trim() : null;
		}

		// C#: /// XML doc comments
		if (lang === 'csharp') {
			const comments: string[] = [];
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'comment') {
					const text = sibling.text;
					if (text.startsWith('///')) {
						// Strip /// and XML tags
						comments.unshift(
							text
								.replace(/^\/\/\/\s*/, '')
								.replace(/<\/?[^>]+>/g, '')
								.trim(),
						);
					} else {
						break;
					}
				} else {
					break;
				}
				sibling = sibling.previousSibling;
			}
			return comments.length > 0 ? comments.join(' ').trim() : null;
		}

		// Java, Kotlin, PHP: /** Javadoc */ style
		if (lang === 'java' || lang === 'kotlin' || lang === 'php') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (
					sibling.type === 'comment' ||
					sibling.type === 'multiline_comment' ||
					sibling.type === 'block_comment'
				) {
					const text = sibling.text;
					if (text.startsWith('/**')) {
						return (
							text
								.replace(/^\/\*\*/, '')
								.replace(/\*\/$/, '')
								.replace(/^\s*\* ?/gm, '')
								.trim() || null
						);
					}
				}
				// Skip modifiers/annotations to find doc comment
				if (
					sibling.type === 'modifiers' ||
					sibling.type === 'annotation' ||
					sibling.type === 'marker_annotation'
				) {
					sibling = sibling.previousSibling;
					continue;
				}
				break;
			}
			return null;
		}

		// Swift, Dart: /// or /** */ style
		if (lang === 'swift' || lang === 'dart') {
			const comments: string[] = [];
			let sibling = node.previousSibling;
			while (sibling) {
				if (
					sibling.type === 'comment' ||
					sibling.type === 'multiline_comment'
				) {
					const text = sibling.text;
					if (text.startsWith('/**')) {
						return (
							text
								.replace(/^\/\*\*/, '')
								.replace(/\*\/$/, '')
								.replace(/^\s*\* ?/gm, '')
								.trim() || null
						);
					} else if (text.startsWith('///')) {
						comments.unshift(text.replace(/^\/\/\/\s*/, ''));
					} else {
						break;
					}
				} else {
					break;
				}
				sibling = sibling.previousSibling;
			}
			return comments.length > 0 ? comments.join('\n').trim() : null;
		}

		// JS/TS: JSDoc /** */ style
		let checkNode: Parser.SyntaxNode | null = node;

		while (checkNode) {
			const prev = checkNode.previousSibling;
			if (prev?.type === 'comment') {
				const text = prev.text;
				if (text.startsWith('/**')) {
					return (
						text
							.replace(/^\/\*\*/, '')
							.replace(/\*\/$/, '')
							.replace(/^\s*\* ?/gm, '')
							.trim() || null
					);
				}
			}
			checkNode = checkNode.parent;
			if (
				checkNode &&
				!EXPORT_WRAPPER_TYPES.includes(checkNode.type) &&
				checkNode.type !== 'variable_declarator' &&
				checkNode.type !== 'variable_declaration'
			) {
				break;
			}
		}

		return null;
	}

	/**
	 * Check if a node is exported/public.
	 */
	private extractIsExported(
		node: Parser.SyntaxNode,
		lang: SupportedLanguage,
	): boolean {
		// Python: Public if name doesn't start with underscore
		if (lang === 'python') {
			const name = this.extractName(node, lang);
			return !name.startsWith('_');
		}

		// Dart: Same as Python - underscore prefix means private
		if (lang === 'dart') {
			const name = this.extractName(node, lang);
			return !name.startsWith('_');
		}

		// Go: Exported if name starts with uppercase letter
		if (lang === 'go') {
			const name = this.extractName(node, lang);
			return name.length > 0 && name[0] === name[0]?.toUpperCase();
		}

		// Rust: Look for 'pub' visibility modifier
		if (lang === 'rust') {
			return this.hasVisibilityModifier(node, 'pub');
		}

		// Java, C#, Swift: Look for 'public' keyword
		if (lang === 'java' || lang === 'csharp' || lang === 'swift') {
			return this.hasVisibilityModifier(node, 'public');
		}

		// Kotlin: Default is public unless marked private/internal/protected
		if (lang === 'kotlin') {
			return (
				!this.hasVisibilityModifier(node, 'private') &&
				!this.hasVisibilityModifier(node, 'internal') &&
				!this.hasVisibilityModifier(node, 'protected')
			);
		}

		// PHP: Public if has 'public' modifier or no visibility modifier (for functions)
		if (lang === 'php') {
			if (this.hasVisibilityModifier(node, 'public')) return true;
			// Top-level functions are always public
			if (
				node.type === 'function_definition' &&
				node.parent?.type === 'program'
			) {
				return true;
			}
			// Methods: check for visibility - no modifier means package-private
			return (
				!this.hasVisibilityModifier(node, 'private') &&
				!this.hasVisibilityModifier(node, 'protected')
			);
		}

		// JS/TS: Check for export keyword in node or parent
		let checkNode: Parser.SyntaxNode | null = node;

		while (checkNode) {
			// Check if this node has export modifier
			if (checkNode.type === 'export_statement') {
				return true;
			}

			// Check for 'export' child (for class/function declarations)
			for (let i = 0; i < checkNode.childCount; i++) {
				const child = checkNode.child(i);
				if (child && (child.type === 'export' || child.text === 'export')) {
					return true;
				}
			}

			// Walk up through wrappers
			const parent: Parser.SyntaxNode | null = checkNode.parent;
			if (
				parent &&
				(parent.type === 'export_statement' ||
					parent.type === 'variable_declaration' ||
					parent.type === 'lexical_declaration')
			) {
				checkNode = parent;
			} else {
				break;
			}
		}

		return false;
	}

	/**
	 * Helper to check for visibility modifiers in a node.
	 */
	private hasVisibilityModifier(
		node: Parser.SyntaxNode,
		modifier: string,
	): boolean {
		// Check direct children for visibility modifiers
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (!child) continue;

			// Check common modifier node types
			if (
				child.type === 'visibility_modifier' ||
				child.type === 'modifier' ||
				child.type === 'modifiers' ||
				child.type === modifier
			) {
				if (child.text === modifier || child.text?.includes(modifier)) {
					return true;
				}
				// Check nested modifiers
				for (let j = 0; j < child.childCount; j++) {
					const grandchild = child.child(j);
					if (
						grandchild &&
						(grandchild.text === modifier || grandchild.type === modifier)
					) {
						return true;
					}
				}
			}
			// Direct text match
			if (child.text === modifier) {
				return true;
			}
		}

		// Check parent for modifiers (for wrapped declarations)
		if (node.parent) {
			for (let i = 0; i < node.parent.childCount; i++) {
				const sibling = node.parent.child(i);
				if (!sibling || sibling.equals(node)) continue;
				if (
					sibling.type === 'visibility_modifier' ||
					sibling.type === 'modifier' ||
					sibling.type === 'modifiers'
				) {
					if (sibling.text === modifier || sibling.text?.includes(modifier)) {
						return true;
					}
				}
				if (sibling.text === modifier) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Extract decorator names from a node.
	 */
	private extractDecoratorNames(
		node: Parser.SyntaxNode,
		lang: SupportedLanguage,
	): string | null {
		const decorators: string[] = [];

		// Python: @decorator syntax
		if (lang === 'python') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'decorator') {
					const nameNode = this.findChildOfType(sibling, [
						'identifier',
						'call',
					]);
					if (nameNode) {
						if (nameNode.type === 'call') {
							const funcNode = nameNode.childForFieldName('function');
							if (funcNode) {
								decorators.unshift(funcNode.text);
							}
						} else {
							decorators.unshift(nameNode.text);
						}
					}
				} else if (sibling.type !== 'comment') {
					break;
				}
				sibling = sibling.previousSibling;
			}
		}

		// Rust: #[attribute] syntax
		else if (lang === 'rust') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'attribute_item' || sibling.type === 'attribute') {
					// Extract attribute name from #[name] or #[name(...)]
					const attrNode = this.findChildOfType(sibling, [
						'attribute',
						'meta_item',
					]);
					const target = attrNode || sibling;
					const pathNode = this.findChildOfType(target, [
						'path',
						'identifier',
						'scoped_identifier',
					]);
					if (pathNode) {
						decorators.unshift(pathNode.text);
					}
				} else if (
					sibling.type !== 'line_comment' &&
					sibling.type !== 'block_comment'
				) {
					break;
				}
				sibling = sibling.previousSibling;
			}
		}

		// Java, Kotlin: @Annotation syntax
		else if (lang === 'java' || lang === 'kotlin') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (
					sibling.type === 'annotation' ||
					sibling.type === 'marker_annotation'
				) {
					const nameNode = this.findChildOfType(sibling, [
						'identifier',
						'scoped_identifier',
					]);
					if (nameNode) {
						decorators.unshift(nameNode.text);
					}
				} else if (sibling.type === 'modifiers') {
					// Annotations may be inside modifiers node
					for (let i = 0; i < sibling.childCount; i++) {
						const child = sibling.child(i);
						if (
							child &&
							(child.type === 'annotation' ||
								child.type === 'marker_annotation')
						) {
							const nameNode = this.findChildOfType(child, ['identifier']);
							if (nameNode) {
								decorators.unshift(nameNode.text);
							}
						}
					}
				} else if (
					sibling.type !== 'comment' &&
					sibling.type !== 'multiline_comment'
				) {
					break;
				}
				sibling = sibling.previousSibling;
			}
		}

		// C#: [Attribute] syntax
		else if (lang === 'csharp') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'attribute_list') {
					for (let i = 0; i < sibling.childCount; i++) {
						const attrNode = sibling.child(i);
						if (attrNode?.type === 'attribute') {
							const nameNode = this.findChildOfType(attrNode, [
								'identifier',
								'qualified_name',
								'name',
							]);
							if (nameNode) {
								decorators.unshift(nameNode.text);
							}
						}
					}
				} else if (sibling.type !== 'comment') {
					break;
				}
				sibling = sibling.previousSibling;
			}
		}

		// Swift: @attribute syntax
		else if (lang === 'swift') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'attribute') {
					const nameNode = this.findChildOfType(sibling, [
						'user_type',
						'simple_identifier',
						'identifier',
					]);
					if (nameNode) {
						decorators.unshift(nameNode.text);
					}
				} else if (
					sibling.type !== 'comment' &&
					sibling.type !== 'multiline_comment'
				) {
					break;
				}
				sibling = sibling.previousSibling;
			}
		}

		// Dart: @annotation syntax
		else if (lang === 'dart') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'annotation') {
					const nameNode = this.findChildOfType(sibling, [
						'identifier',
						'qualified',
					]);
					if (nameNode) {
						decorators.unshift(nameNode.text);
					}
				} else if (sibling.type !== 'comment') {
					break;
				}
				sibling = sibling.previousSibling;
			}
		}

		// PHP: #[Attribute] syntax (PHP 8+)
		else if (lang === 'php') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (
					sibling.type === 'attribute_group' ||
					sibling.type === 'attribute_list'
				) {
					for (let i = 0; i < sibling.childCount; i++) {
						const attrNode = sibling.child(i);
						if (attrNode?.type === 'attribute') {
							const nameNode = this.findChildOfType(attrNode, [
								'name',
								'qualified_name',
								'identifier',
							]);
							if (nameNode) {
								decorators.unshift(nameNode.text);
							}
						}
					}
				} else if (sibling.type !== 'comment') {
					break;
				}
				sibling = sibling.previousSibling;
			}
		}

		// Go: No decorators (uses comments like //go:embed but not proper decorators)

		// JS/TS: @decorator syntax
		else if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
			let checkNode: Parser.SyntaxNode | null = node;

			while (checkNode) {
				for (let i = 0; i < checkNode.childCount; i++) {
					const child = checkNode.child(i);
					if (child?.type === 'decorator') {
						const expr = this.findChildOfType(child, [
							'call_expression',
							'identifier',
						]);
						if (expr) {
							if (expr.type === 'call_expression') {
								const func = expr.childForFieldName('function');
								if (func) {
									decorators.push(func.text);
								}
							} else {
								decorators.push(expr.text);
							}
						}
					}
				}

				let sibling = checkNode.previousSibling;
				while (sibling) {
					if (sibling.type === 'decorator') {
						const expr = this.findChildOfType(sibling, [
							'call_expression',
							'identifier',
						]);
						if (expr) {
							if (expr.type === 'call_expression') {
								const func = expr.childForFieldName('function');
								if (func) {
									decorators.unshift(func.text);
								}
							} else {
								decorators.unshift(expr.text);
							}
						}
					} else if (sibling.type !== 'comment') {
						break;
					}
					sibling = sibling.previousSibling;
				}

				const parent: Parser.SyntaxNode | null = checkNode.parent;
				if (parent && EXPORT_WRAPPER_TYPES.includes(parent.type)) {
					checkNode = parent;
				} else {
					break;
				}
			}
		}

		return decorators.length > 0 ? decorators.join(',') : null;
	}

	/**
	 * Helper to find a child node of specific types.
	 */
	private findChildOfType(
		node: Parser.SyntaxNode,
		types: string[],
	): Parser.SyntaxNode | null {
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child && types.includes(child.type)) {
				return child;
			}
		}
		return null;
	}

	/**
	 * Build a context header for a chunk.
	 */
	private buildContextHeader(
		filepath: string,
		parentClassName: string | null,
		functionName: string | null,
		isContinuation: boolean,
	): string {
		const parts = [`// File: ${filepath}`];
		if (parentClassName) {
			parts.push(`Class: ${parentClassName}`);
		}
		if (functionName) {
			parts.push(`Function: ${functionName}`);
		}
		if (isContinuation) {
			parts.push('(continued)');
		}
		return parts.join(', ');
	}

	private uniqueStable(values: string[]): string[] {
		if (values.length <= 1) return values;
		const out: string[] = [];
		const seen = new Set<string>();
		for (const value of values) {
			if (!seen.has(value)) {
				seen.add(value);
				out.push(value);
			}
		}
		return out;
	}

	private splitIdentifierParts(identifier: string): string[] {
		const raw = identifier.trim();
		if (!raw) return [];

		const parts: string[] = [];
		const tokens = raw.split(/[^A-Za-z0-9]+/g).filter(Boolean);
		for (const token of tokens) {
			// Split camelCase / PascalCase / SCREAMING_SNAKE / digits.
			const matches = token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g);
			if (matches) {
				for (const match of matches) {
					const lowered = match.toLowerCase();
					if (lowered) parts.push(lowered);
				}
			} else {
				const lowered = token.toLowerCase();
				if (lowered) parts.push(lowered);
			}
		}
		return parts;
	}

	private stripStringLiteral(text: string): string | null {
		const raw = text.trim();
		if (!raw) return null;

		// C# verbatim/interpolated strings: @"..." / $@"..." / @$"..." / $"..."
		const csharpPrefixMatch = raw.match(/^(\$@|@\$\s*|\$|@)"/);
		if (csharpPrefixMatch) {
			const start = csharpPrefixMatch[0].replace(/\s+/g, '').length - 1; // keep the opening quote
			const inner = raw.slice(start);
			if (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) {
				return inner.slice(1, -1);
			}
		}

		// Rust raw strings: r"..." / r#"..."# / r##"..."##
		const rustRaw = raw.match(/^r(#+)?"([\s\S]*)"(\1)$/);
		if (rustRaw) {
			return rustRaw[2] ?? '';
		}

		// Python triple-quoted strings.
		if (
			(raw.startsWith("'''") && raw.endsWith("'''") && raw.length >= 6) ||
			(raw.startsWith('"""') && raw.endsWith('"""') && raw.length >= 6)
		) {
			return raw.slice(3, -3);
		}

		// Common quoting.
		const first = raw[0];
		const last = raw[raw.length - 1];
		if (
			(first === '"' && last === '"') ||
			(first === "'" && last === "'") ||
			(first === '`' && last === '`')
		) {
			return raw.slice(1, -1);
		}

		return raw;
	}

	private isIdentifierLike(text: string): boolean {
		return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text);
	}

	private isIdentifierNodeType(nodeType: string): boolean {
		if (nodeType === 'identifier' || nodeType === 'name') return true;
		if (nodeType.endsWith('identifier')) return true;
		return false;
	}

	private isCommentNodeType(nodeType: string): boolean {
		if (nodeType === 'comment') return true;
		if (nodeType.endsWith('_comment')) return true;
		return nodeType.includes('comment');
	}

	private isStringLiteralNodeType(nodeType: string): boolean {
		if (nodeType === 'string') return true;
		if (nodeType === 'string_literal') return true;
		if (nodeType === 'template_string') return true;
		if (nodeType === 'interpreted_string_literal') return true;
		if (nodeType === 'raw_string_literal') return true;
		if (nodeType === 'character_literal' || nodeType === 'char_literal')
			return true;

		if (nodeType.includes('string')) {
			if (nodeType.includes('content')) return false;
			if (nodeType.includes('interpolation')) return false;
			if (nodeType.includes('escape')) return false;
			return true;
		}

		return false;
	}

	private isCallExpressionNodeType(nodeType: string): boolean {
		if (nodeType === 'call' || nodeType === 'call_expression') return true;
		if (nodeType === 'new_expression') return true;
		if (nodeType.endsWith('invocation') || nodeType.includes('invocation'))
			return true;
		if (nodeType === 'macro_invocation') return true;
		if (nodeType === 'invocation_expression') return true;
		if (nodeType.endsWith('_call_expression')) return true;
		if (nodeType.endsWith('_call')) return true;
		return nodeType.includes('call') && nodeType.includes('expression');
	}

	private isQualifiedCallToken(text: string): boolean {
		return /^[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(text);
	}

	private collectImportedReceiverNames(
		root: Parser.SyntaxNode,
		lang: SupportedLanguage,
	): Set<string> {
		const out = new Set<string>();

		const walk = (node: Parser.SyntaxNode) => {
			if (this.isCommentNodeType(node.type)) return;

			if (this.isImportNodeType(lang, node.type)) {
				for (const ref of this.extractImportRefsFromNode(node, lang)) {
					if (!ref.imported_name) continue; // ignore side-effect imports
					const local = ref.token_texts[0] ?? '';
					if (!this.isIdentifierLike(local)) continue;
					out.add(local);
				}

				// JS/TS export_statement nodes can wrap real declarations (export function/class/const).
				// We still want to traverse those to capture call refs inside bodies.
				if (
					(lang === 'javascript' || lang === 'typescript' || lang === 'tsx') &&
					node.type === 'export_statement'
				) {
					const isReExport = node.childForFieldName('source') != null;
					if (isReExport) return;
				} else {
					return;
				}
			}

			for (let i = 0; i < node.namedChildCount; i++) {
				const child = node.namedChild(i);
				if (child) walk(child);
			}
		};

		walk(root);
		return out;
	}

	private extractQualifiedCallToken(
		callNode: Parser.SyntaxNode,
		importedReceivers: Set<string>,
	): string | null {
		const callee =
			callNode.childForFieldName('function') ??
			callNode.childForFieldName('name') ??
			callNode.childForFieldName('method') ??
			callNode.childForFieldName('callee') ??
			callNode.childForFieldName('target') ??
			callNode.childForFieldName('macro') ??
			callNode.childForFieldName('constructor') ??
			(callNode.namedChildCount > 0 ? callNode.namedChild(0) : null);
		if (!callee) return null;

		const ignoredReceivers = new Set(['this', 'self', 'super', 'cls']);

		const extractChain = (node: Parser.SyntaxNode): string[] | null => {
			if (this.isCommentNodeType(node.type)) return null;
			if (this.isStringLiteralNodeType(node.type)) return null;

			if (this.isIdentifierNodeType(node.type)) {
				const text = node.text.trim();
				return this.isIdentifierLike(text) ? [text] : null;
			}

			const property =
				node.childForFieldName('property') ??
				node.childForFieldName('field') ??
				node.childForFieldName('attribute') ??
				node.childForFieldName('name') ??
				node.childForFieldName('method');
			const object =
				node.childForFieldName('object') ??
				node.childForFieldName('receiver') ??
				node.childForFieldName('value') ??
				node.childForFieldName('operand');
			if (property && object) {
				const prop = property.text.trim();
				if (!this.isIdentifierLike(prop)) return null;
				const left = extractChain(object);
				if (!left) return null;
				return [...left, prop];
			}

			// Namespaced identifiers: Foo::bar (Rust, PHP, etc.)
			const scope = node.childForFieldName('scope');
			const name = node.childForFieldName('name');
			if (scope && name && scope !== node && name !== node) {
				const nameText = name.text.trim();
				if (!this.isIdentifierLike(nameText)) return null;
				const left = extractChain(scope);
				if (!left) return null;
				return [...left, nameText];
			}

			const unwrap =
				node.childForFieldName('expression') ??
				node.childForFieldName('operand') ??
				node.childForFieldName('function') ??
				node.childForFieldName('value') ??
				node.childForFieldName('callee') ??
				node.childForFieldName('target');
			if (unwrap && unwrap !== node) {
				const inner = extractChain(unwrap);
				if (inner) return inner;
			}

			if (node.namedChildCount === 1) {
				const only = node.namedChild(0);
				if (only && only !== node) return extractChain(only);
			}

			return null;
		};

		let chain = extractChain(callee);

		// Some grammars model the receiver + name as fields on the call node itself
		// (e.g., java: method_invocation {object, name}).
		if (!chain || chain.length < 2) {
			const receiverNode =
				callNode.childForFieldName('object') ??
				callNode.childForFieldName('receiver') ??
				callNode.childForFieldName('value') ??
				callNode.childForFieldName('operand');
			const nameNode =
				callNode.childForFieldName('name') ??
				callNode.childForFieldName('method') ??
				callNode.childForFieldName('property') ??
				callNode.childForFieldName('attribute') ??
				callNode.childForFieldName('field');

			if (receiverNode && nameNode) {
				const method = nameNode.text.trim();
				const left = extractChain(receiverNode);
				if (left && this.isIdentifierLike(method)) {
					chain = [...left, method];
				}
			}
		}

		if (!chain || chain.length < 2) return null;

		const method = chain[chain.length - 1] ?? '';
		const receiver = chain[chain.length - 2] ?? '';
		if (!this.isIdentifierLike(receiver) || !this.isIdentifierLike(method))
			return null;
		if (ignoredReceivers.has(receiver)) return null;

		const qualified = `${receiver}.${method}`;
		if (!this.isQualifiedCallToken(qualified)) return null;

		// Only emit receiver.method for:
		// - deeper chains (foo.bar.baz → bar.baz), or
		// - 2-segment chains where receiver looks "stable" (imported or Symbolish).
		if (chain.length >= 3) return qualified;
		if (importedReceivers.has(receiver) || this.isSymbolishIdentifier(receiver))
			return qualified;
		return null;
	}

	private extractCalleeText(node: Parser.SyntaxNode): string | null {
		const direct =
			node.childForFieldName('function') ??
			node.childForFieldName('name') ??
			node.childForFieldName('method') ??
			node.childForFieldName('callee') ??
			node.childForFieldName('target') ??
			node.childForFieldName('macro');
		if (direct) return direct.text.trim();

		// Best-effort: some grammars put the callee as the first named child.
		if (node.namedChildCount > 0) {
			const first = node.namedChild(0);
			if (first) return first.text.trim();
		}
		return null;
	}

	private normalizeCalledName(text: string): string[] {
		const raw = text.trim();
		if (!raw) return [];

		const out: string[] = [];

		if (raw.length <= 128) out.push(raw);

		// Also include the last identifier-like segment for member/qualified calls.
		const lastId = raw.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
		if (lastId?.[1]) out.push(lastId[1]);

		return this.uniqueStable(out);
	}

	private extractAstTokenFacts(
		node: Parser.SyntaxNode,
		lang: SupportedLanguage,
		range?: {startIndex: number; endIndex: number},
	): TokenFacts {
		const identifiers: string[] = [];
		const calledNames: string[] = [];
		const stringLiterals: string[] = [];

		const overlaps = (n: Parser.SyntaxNode): boolean => {
			if (!range) return true;
			// tree-sitter indices are byte offsets with endIndex exclusive.
			return n.endIndex > range.startIndex && n.startIndex < range.endIndex;
		};

		const within = (n: Parser.SyntaxNode): boolean => {
			if (!range) return true;
			return n.startIndex >= range.startIndex && n.endIndex <= range.endIndex;
		};

		const walk = (n: Parser.SyntaxNode) => {
			if (!overlaps(n)) return;

			if (this.isIdentifierNodeType(n.type) && within(n)) {
				const text = n.text.trim();
				if (text && this.isIdentifierLike(text)) {
					identifiers.push(text);
				}
			}

			if (this.isStringLiteralNodeType(n.type) && within(n)) {
				const stripped = this.stripStringLiteral(n.text);
				if (stripped) {
					// Avoid massive captures (e.g., huge template strings).
					stringLiterals.push(stripped.slice(0, 512));
				}
			}

			if (this.isCallExpressionNodeType(n.type) && overlaps(n)) {
				const callee = this.extractCalleeText(n);
				if (callee) {
					for (const normalized of this.normalizeCalledName(callee)) {
						if (normalized) calledNames.push(normalized);
					}
				}
			}

			for (let i = 0; i < n.namedChildCount; i++) {
				const child = n.namedChild(i);
				if (child) walk(child);
			}
		};

		// Some grammars (e.g., python) label calls/identifiers differently, but the
		// traversal is language-agnostic; lang is reserved for future tuning.
		void lang;
		walk(node);

		const uniqueIdentifiers = this.uniqueStable(identifiers);
		const identifierParts = this.uniqueStable(
			uniqueIdentifiers.flatMap(id => this.splitIdentifierParts(id)),
		);

		return {
			identifiers: uniqueIdentifiers,
			identifierParts,
			calledNames: this.uniqueStable(calledNames),
			stringLiterals: this.uniqueStable(stringLiterals),
		};
	}

	private extractRefsFromTree(
		root: Parser.SyntaxNode,
		lang: SupportedLanguage,
		options: RefExtractionOptions,
	): ExtractedRef[] {
		const identifierMode = options.identifier_mode ?? 'symbolish';
		const includeStringLiterals = options.include_string_literals ?? false;
		const maxOccurrencesPerToken = options.max_occurrences_per_token ?? 0;

		const excludeDefinitionNameRanges = this.collectDefinitionNameRanges(
			root,
			lang,
		);

		const importedReceivers = this.collectImportedReceiverNames(root, lang);

		const refs: ExtractedRef[] = [];

		const walk = (node: Parser.SyntaxNode) => {
			if (this.isCommentNodeType(node.type)) return;

			if (this.isImportNodeType(lang, node.type)) {
				refs.push(...this.extractImportRefsFromNode(node, lang));
				// JS/TS export_statement nodes can wrap real declarations (export function/class/const).
				// We still want to traverse those to capture call refs inside bodies.
				if (
					(lang === 'javascript' || lang === 'typescript' || lang === 'tsx') &&
					node.type === 'export_statement'
				) {
					const isReExport = node.childForFieldName('source') != null;
					if (isReExport) return;
				} else {
					return;
				}
			}

			if (this.isStringLiteralNodeType(node.type)) {
				if (includeStringLiterals) {
					const stripped = this.stripStringLiteral(node.text);
					if (stripped && stripped.trim().length > 0) {
						refs.push({
							ref_kind: 'string_literal',
							token_texts: [stripped.slice(0, 512)],
							start_line: node.startPosition.row + 1,
							end_line: node.endPosition.row + 1,
							start_byte: node.startIndex,
							end_byte: node.endIndex,
							module_name: null,
							imported_name: null,
						});
					}
				}
				// Avoid capturing identifiers from literal content, but still traverse into
				// interpolations / substitutions (e.g., JS/TS template strings, Python f-strings).
				if (node.namedChildCount > 0) {
					for (let i = 0; i < node.namedChildCount; i++) {
						const child = node.namedChild(i);
						if (child) walk(child);
					}
				}
				return;
			}

			if (this.isCallExpressionNodeType(node.type)) {
				const calledNode = this.extractCalledNameNode(node);
				const locNode = calledNode ?? node;
				const base = (calledNode?.text ?? '').trim();
				const qualified = this.extractQualifiedCallToken(
					node,
					importedReceivers,
				);
				const tokens = this.uniqueStable(
					[base, qualified].filter(
						(t): t is string =>
							typeof t === 'string' &&
							t.trim().length > 0 &&
							(this.isIdentifierLike(t) || this.isQualifiedCallToken(t)),
					),
				);

				if (tokens.length > 0) {
					refs.push({
						ref_kind: 'call',
						token_texts: tokens,
						start_line: locNode.startPosition.row + 1,
						end_line: locNode.endPosition.row + 1,
						start_byte: locNode.startIndex,
						end_byte: locNode.endIndex,
						module_name: null,
						imported_name: null,
					});
				}
			}

			if (identifierMode !== 'none' && this.isIdentifierNodeType(node.type)) {
				const text = node.text.trim();
				if (
					text &&
					this.isIdentifierLike(text) &&
					!excludeDefinitionNameRanges.has(
						`${node.startIndex}|${node.endIndex}`,
					)
				) {
					const shouldInclude =
						identifierMode === 'all' || this.isSymbolishIdentifier(text);
					if (shouldInclude) {
						refs.push({
							ref_kind: 'identifier',
							token_texts: [text],
							start_line: node.startPosition.row + 1,
							end_line: node.endPosition.row + 1,
							start_byte: node.startIndex,
							end_byte: node.endIndex,
							module_name: null,
							imported_name: null,
						});
					}
				}
			}

			for (let i = 0; i < node.namedChildCount; i++) {
				const child = node.namedChild(i);
				if (child) walk(child);
			}
		};

		walk(root);

		const deduped = this.dedupeRefs(refs);
		return maxOccurrencesPerToken > 0
			? this.limitRefsPerToken(deduped, maxOccurrencesPerToken)
			: deduped;
	}

	private isImportNodeType(lang: SupportedLanguage, nodeType: string): boolean {
		switch (lang) {
			case 'javascript':
			case 'typescript':
			case 'tsx':
				return (
					nodeType === 'import_statement' || nodeType === 'export_statement'
				);
			case 'python':
				return (
					nodeType === 'import_statement' ||
					nodeType === 'import_from_statement'
				);
			case 'go':
				return nodeType === 'import_declaration';
			case 'rust':
				return (
					nodeType === 'use_declaration' ||
					nodeType === 'extern_crate_declaration'
				);
			case 'java':
				return nodeType === 'import_declaration';
			case 'csharp':
				return nodeType === 'using_directive';
			case 'kotlin':
				return nodeType === 'import_header';
			case 'swift':
				return nodeType === 'import_declaration';
			case 'php':
				return (
					nodeType === 'namespace_use_declaration' ||
					nodeType === 'namespace_use_clause'
				);
			default:
				return false;
		}
	}

	private extractImportRefsFromNode(
		node: Parser.SyntaxNode,
		lang: SupportedLanguage,
	): ExtractedRef[] {
		if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
			return this.extractImportRefsFromJsLikeNode(node);
		}
		if (lang === 'python') {
			return this.extractImportRefsFromPythonNode(node);
		}
		if (lang === 'go') {
			return this.extractImportRefsFromGoNode(node);
		}
		if (lang === 'rust') {
			return this.extractImportRefsFromRustNode(node);
		}
		if (lang === 'java') {
			return this.extractImportRefsFromJavaNode(node);
		}
		if (lang === 'csharp') {
			return this.extractImportRefsFromCSharpNode(node);
		}
		if (lang === 'kotlin') {
			return this.extractImportRefsFromKotlinNode(node);
		}
		if (lang === 'swift') {
			return this.extractImportRefsFromSwiftNode(node);
		}
		if (lang === 'php') {
			return this.extractImportRefsFromPhpNode(node);
		}
		return [];
	}

	private extractImportRefsFromJsLikeNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const moduleNode =
			node.childForFieldName('source') ?? this.findFirstStringLiteralNode(node);
		const moduleRaw = moduleNode ? moduleNode.text : null;
		const module_name = moduleRaw ? this.stripStringLiteral(moduleRaw) : null;
		if (!module_name) return [];

		const extractClauseNode = (): Parser.SyntaxNode | null => {
			const byField =
				node.childForFieldName('import_clause') ??
				node.childForFieldName('export_clause') ??
				node.childForFieldName('clause');
			if (byField) return byField;
			for (let i = 0; i < node.namedChildCount; i++) {
				const child = node.namedChild(i);
				if (!child) continue;
				if (child.type === 'import_clause' || child.type === 'export_clause') {
					return child;
				}
			}
			return null;
		};

		const clauseNode = extractClauseNode();
		if (!clauseNode) {
			// Side-effect import: `import "x";`
			if (node.type !== 'import_statement') return [];
			return [
				{
					ref_kind: 'import',
					token_texts: [module_name],
					start_line: node.startPosition.row + 1,
					end_line: node.endPosition.row + 1,
					start_byte: node.startIndex,
					end_byte: node.endIndex,
					module_name,
					imported_name: null,
				},
			];
		}

		const imports: Array<{imported: string; local: string}> = [];

		// Default import: import Foo from "x"
		const defaultName = clauseNode.childForFieldName('name');
		if (defaultName && this.isIdentifierLike(defaultName.text.trim())) {
			imports.push({imported: 'default', local: defaultName.text.trim()});
		}

		// Namespace import/export: import * as ns from "x" / export * as ns from "x"
		const namespaceNodes: Parser.SyntaxNode[] = [];
		const specifierNodes: Parser.SyntaxNode[] = [];

		const visit = (n: Parser.SyntaxNode) => {
			if (this.isCommentNodeType(n.type)) return;
			if (n.type === 'namespace_import' || n.type === 'namespace_export') {
				namespaceNodes.push(n);
				return;
			}
			if (n.type === 'import_specifier' || n.type === 'export_specifier') {
				specifierNodes.push(n);
				return;
			}
			for (let i = 0; i < n.namedChildCount; i++) {
				const child = n.namedChild(i);
				if (child) visit(child);
			}
		};

		visit(clauseNode);

		for (const nsNode of namespaceNodes) {
			const nameNode = nsNode.childForFieldName('name') ?? nsNode.namedChild(0);
			const local = nameNode ? nameNode.text.trim() : '';
			if (local && this.isIdentifierLike(local)) {
				imports.push({imported: '*', local});
			}
		}

		for (const spec of specifierNodes) {
			const importedNode =
				spec.childForFieldName('name') ??
				spec.childForFieldName('property') ??
				spec.childForFieldName('value') ??
				spec.namedChild(0);
			const aliasNode =
				spec.childForFieldName('alias') ??
				spec.childForFieldName('as') ??
				spec.childForFieldName('exported') ??
				(spec.namedChildCount > 1 ? spec.namedChild(1) : null);
			const imported = importedNode ? importedNode.text.trim() : '';
			const alias = aliasNode ? aliasNode.text.trim() : '';
			if (!imported || !this.isIdentifierLike(imported)) continue;
			if (alias && this.isIdentifierLike(alias)) {
				imports.push({imported, local: alias});
			} else {
				imports.push({imported, local: imported});
			}
		}

		// Fallback: text parsing (best-effort) for grammars that don't expose
		// import/export clause shapes consistently.
		if (imports.length === 0) {
			const text = node.text.trim();
			if (!text) return [];
			const fromMatch = text.match(
				/^\s*(?:import|export)\s+(?:type\s+)?([\s\S]+?)\s+from\s+['"][^'"]+['"]\s*;?\s*$/,
			);
			if (fromMatch?.[1]) {
				const clause = fromMatch[1].trim();
				imports.push(...this.parseJsImportClause(clause));
			}
		}

		if (imports.length === 0) return [];

		return imports.map(entry => ({
			ref_kind: 'import',
			token_texts: [entry.local],
			start_line: node.startPosition.row + 1,
			end_line: node.endPosition.row + 1,
			start_byte: node.startIndex,
			end_byte: node.endIndex,
			module_name,
			imported_name: entry.imported,
		}));
	}

	private parseJsImportClause(
		clause: string,
	): Array<{imported: string; local: string}> {
		const out: Array<{imported: string; local: string}> = [];
		const trimmed = clause.trim();
		if (!trimmed) return out;

		const parseNamed = (segment: string) => {
			const body = segment.replace(/^{\s*|\s*}$/g, '');
			for (const raw of body.split(',')) {
				const entry = raw.trim();
				if (!entry) continue;

				const cleaned = entry.replace(/^type\s+/, '').trim();
				if (!cleaned) continue;

				const asMatch = cleaned.match(
					/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/,
				);
				if (!asMatch?.[1]) continue;
				const imported = asMatch[1];
				const local = asMatch[2] ?? imported;
				out.push({imported, local});
			}
		};

		const parseNamespace = (segment: string) => {
			const nsMatch = segment.match(/^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
			if (nsMatch?.[1]) {
				out.push({imported: '*', local: nsMatch[1]});
			}
		};

		const parseDefault = (segment: string) => {
			const defaultMatch = segment.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
			if (defaultMatch?.[1]) {
				out.push({imported: 'default', local: defaultMatch[1]});
			}
		};

		// Named-only import: {a, b as c}
		if (trimmed.startsWith('{')) {
			parseNamed(trimmed);
			return out;
		}

		// Namespace-only import: * as ns
		if (trimmed.startsWith('*')) {
			parseNamespace(trimmed);
			return out;
		}

		const commaIndex = trimmed.indexOf(',');
		if (commaIndex === -1) {
			parseDefault(trimmed);
			return out;
		}

		const defaultPart = trimmed.slice(0, commaIndex).trim();
		const rest = trimmed.slice(commaIndex + 1).trim();
		if (defaultPart) parseDefault(defaultPart);
		if (!rest) return out;
		if (rest.startsWith('{')) {
			parseNamed(rest);
			return out;
		}
		if (rest.startsWith('*')) {
			parseNamespace(rest);
		}

		return out;
	}

	private extractImportRefsFromPythonNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const lastSegment = (value: string): string => {
			const trimmed = value.trim();
			if (!trimmed) return '';
			const parts = trimmed.split('.').filter(Boolean);
			return parts.length > 0 ? parts[parts.length - 1]! : trimmed;
		};

		const build = (
			localNode: Parser.SyntaxNode,
			module_name: string,
			imported_name: string,
			token_text: string,
		): ExtractedRef | null => {
			const local = token_text.trim();
			if (!local || !this.isIdentifierLike(local)) return null;
			const imported = imported_name.trim();
			return {
				ref_kind: 'import',
				token_texts: [local],
				start_line: localNode.startPosition.row + 1,
				end_line: localNode.endPosition.row + 1,
				start_byte: localNode.startIndex,
				end_byte: localNode.endIndex,
				module_name: module_name.trim() || null,
				imported_name: imported || null,
			};
		};

		if (node.type === 'import_statement') {
			const refs: ExtractedRef[] = [];

			for (let i = 0; i < node.namedChildCount; i++) {
				const child = node.namedChild(i);
				if (!child) continue;
				if (this.isCommentNodeType(child.type)) continue;

				if (child.type === 'dotted_name') {
					const module_name = child.text.trim();
					if (!module_name) continue;
					const imported = lastSegment(module_name);
					const ref = build(child, module_name, imported, imported);
					if (ref) refs.push(ref);
					continue;
				}

				if (child.type === 'aliased_import') {
					const nameNode = child.childForFieldName('name');
					if (!nameNode) continue;
					const module_name = nameNode.text.trim();
					if (!module_name) continue;
					const imported = lastSegment(module_name);

					const aliasNode = child.childForFieldName('alias');
					const token_text = aliasNode?.text?.trim() || imported;
					const locNode = aliasNode ?? nameNode;
					const ref = build(locNode, module_name, imported, token_text);
					if (ref) refs.push(ref);
					continue;
				}
			}

			return refs;
		}

		if (node.type === 'import_from_statement') {
			const moduleNode = node.childForFieldName('module_name');
			if (!moduleNode) return [];
			const module_name = moduleNode.text.trim();
			if (!module_name) return [];

			const refs: ExtractedRef[] = [];

			for (let i = 0; i < node.namedChildCount; i++) {
				const child = node.namedChild(i);
				if (!child) continue;
				if (child === moduleNode) continue;
				if (this.isCommentNodeType(child.type)) continue;
				if (child.type === 'wildcard_import') continue;

				if (child.type === 'dotted_name') {
					const importedPath = child.text.trim();
					if (!importedPath) continue;
					const imported = lastSegment(importedPath);
					const ref = build(child, module_name, imported, imported);
					if (ref) refs.push(ref);
					continue;
				}

				if (child.type === 'aliased_import') {
					const nameNode = child.childForFieldName('name');
					if (!nameNode) continue;
					const importedPath = nameNode.text.trim();
					if (!importedPath) continue;
					const imported = lastSegment(importedPath);

					const aliasNode = child.childForFieldName('alias');
					const token_text = aliasNode?.text?.trim() || imported;
					const locNode = aliasNode ?? nameNode;
					const ref = build(locNode, module_name, imported, token_text);
					if (ref) refs.push(ref);
					continue;
				}
			}

			return refs;
		}

		return [];
	}

	private extractImportRefsFromGoNode(node: Parser.SyntaxNode): ExtractedRef[] {
		const stringNodes = this.findStringLiteralNodes(node);
		if (stringNodes.length === 0) return [];

		const refs: ExtractedRef[] = [];
		for (const s of stringNodes) {
			const stripped = this.stripStringLiteral(s.text);
			if (!stripped) continue;
			const module_name = stripped.trim();
			if (!module_name) continue;

			const parent = s.parent;
			const aliasNode = parent?.childForFieldName('name') ?? null;
			const alias =
				aliasNode && this.isIdentifierLike(aliasNode.text.trim())
					? aliasNode.text.trim()
					: null;

			const imported = module_name.split('/').pop() ?? module_name;
			const token_text = alias ?? imported;

			refs.push({
				ref_kind: 'import',
				token_texts: [token_text],
				start_line: (parent ?? s).startPosition.row + 1,
				end_line: (parent ?? s).endPosition.row + 1,
				start_byte: (parent ?? s).startIndex,
				end_byte: (parent ?? s).endIndex,
				module_name,
				imported_name: imported,
			});
		}

		return refs;
	}

	private extractImportRefsFromRustNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const normalized = node.text.replace(/\s+/g, ' ').trim();
		if (!normalized) return [];

		if (normalized.startsWith('extern crate ')) {
			const body = normalized
				.replace(/^extern\s+crate\s+/, '')
				.replace(/;\s*$/, '')
				.trim();
			const match = body.match(
				/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/,
			);
			if (!match?.[1]) return [];
			const module_name = match[1];
			const token_text = match[2] ?? module_name;
			return [
				{
					ref_kind: 'import',
					token_texts: [token_text],
					start_line: node.startPosition.row + 1,
					end_line: node.endPosition.row + 1,
					start_byte: node.startIndex,
					end_byte: node.endIndex,
					module_name,
					imported_name: module_name,
				},
			];
		}

		if (!normalized.startsWith('use ')) return [];

		const body = normalized
			.replace(/^use\s+/, '')
			.replace(/;\s*$/, '')
			.trim();
		if (!body) return [];

		const refs: ExtractedRef[] = [];

		const braceStart = body.indexOf('{');
		const braceEnd = body.lastIndexOf('}');
		const hasBraces = braceStart >= 0 && braceEnd > braceStart;

		const prefix = hasBraces
			? body
					.slice(0, braceStart)
					.replace(/::\s*$/, '')
					.trim()
			: body.split('::').slice(0, -1).join('::').trim();

		const entriesPart = hasBraces
			? body.slice(braceStart + 1, braceEnd).trim()
			: body.split('::').pop()!.trim();

		const entries = entriesPart
			.split(',')
			.map(e => e.trim())
			.filter(Boolean)
			.filter(e => e !== '*' && e !== 'self' && e !== 'super' && e !== 'crate');

		for (const entry of entries) {
			const cleaned = entry.replace(/^pub\s+/, '').trim();
			if (!cleaned) continue;
			const match = cleaned.match(
				/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/,
			);
			if (!match?.[1]) continue;
			const imported = match[1];
			const local = match[2] ?? imported;
			const module_name = prefix || body;

			refs.push({
				ref_kind: 'import',
				token_texts: [local],
				start_line: node.startPosition.row + 1,
				end_line: node.endPosition.row + 1,
				start_byte: node.startIndex,
				end_byte: node.endIndex,
				module_name,
				imported_name: imported,
			});
		}

		return refs;
	}

	private extractImportRefsFromJavaNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const normalized = node.text.replace(/\s+/g, ' ').trim();
		const match = normalized.match(
			/^\s*import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\.\*)?\s*;?\s*$/,
		);
		if (!match?.[1]) return [];
		const module_name = match[1];
		const imported = module_name.split('.').pop() ?? module_name;
		return [
			{
				ref_kind: 'import',
				token_texts: [imported],
				start_line: node.startPosition.row + 1,
				end_line: node.endPosition.row + 1,
				start_byte: node.startIndex,
				end_byte: node.endIndex,
				module_name,
				imported_name: imported,
			},
		];
	}

	private extractImportRefsFromCSharpNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const normalized = node.text.replace(/\s+/g, ' ').trim();
		if (!normalized.startsWith('using ')) return [];
		const body = normalized
			.replace(/^using\s+/, '')
			.replace(/;\s*$/, '')
			.trim();
		if (!body) return [];

		const aliasMatch = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
		if (aliasMatch?.[1] && aliasMatch[2]) {
			const token_text = aliasMatch[1];
			const module_name = aliasMatch[2].trim();
			const imported = module_name.split('.').pop() ?? module_name;
			return [
				{
					ref_kind: 'import',
					token_texts: [token_text],
					start_line: node.startPosition.row + 1,
					end_line: node.endPosition.row + 1,
					start_byte: node.startIndex,
					end_byte: node.endIndex,
					module_name,
					imported_name: imported,
				},
			];
		}

		const module_name = body.replace(/^static\s+/, '').trim();
		const imported = module_name.split('.').pop() ?? module_name;
		return [
			{
				ref_kind: 'import',
				token_texts: [imported],
				start_line: node.startPosition.row + 1,
				end_line: node.endPosition.row + 1,
				start_byte: node.startIndex,
				end_byte: node.endIndex,
				module_name,
				imported_name: imported,
			},
		];
	}

	private extractImportRefsFromKotlinNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const normalized = node.text.replace(/\s+/g, ' ').trim();
		const match = normalized.match(
			/^\s*import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/,
		);
		if (!match?.[1]) return [];
		const module_name = match[1];
		const imported = module_name.split('.').pop() ?? module_name;
		const token_text = match[2] ?? imported;
		return [
			{
				ref_kind: 'import',
				token_texts: [token_text],
				start_line: node.startPosition.row + 1,
				end_line: node.endPosition.row + 1,
				start_byte: node.startIndex,
				end_byte: node.endIndex,
				module_name,
				imported_name: imported,
			},
		];
	}

	private extractImportRefsFromSwiftNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const normalized = node.text.replace(/\s+/g, ' ').trim();
		const match = normalized.match(/^\s*import\s+(.+?)\s*$/);
		if (!match?.[1]) return [];
		const module_name = match[1].replace(/^class\s+|^struct\s+/, '').trim();
		if (!module_name) return [];
		const imported = module_name.split('.').pop() ?? module_name;
		return [
			{
				ref_kind: 'import',
				token_texts: [imported],
				start_line: node.startPosition.row + 1,
				end_line: node.endPosition.row + 1,
				start_byte: node.startIndex,
				end_byte: node.endIndex,
				module_name,
				imported_name: imported,
			},
		];
	}

	private extractImportRefsFromPhpNode(
		node: Parser.SyntaxNode,
	): ExtractedRef[] {
		const normalized = node.text.replace(/\s+/g, ' ').trim();
		if (!normalized.startsWith('use ')) return [];

		const body = normalized
			.replace(/^use\s+/, '')
			.replace(/;\s*$/, '')
			.replace(/^function\s+/, '')
			.replace(/^const\s+/, '')
			.trim();
		if (!body) return [];

		const match = body.match(/^(.+?)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
		if (!match?.[1]) return [];

		const module_name = match[1].trim();
		const imported = module_name.split(/\\+/).pop() ?? module_name;
		const token_text = match[2] ?? imported;

		return [
			{
				ref_kind: 'import',
				token_texts: [token_text],
				start_line: node.startPosition.row + 1,
				end_line: node.endPosition.row + 1,
				start_byte: node.startIndex,
				end_byte: node.endIndex,
				module_name,
				imported_name: imported,
			},
		];
	}

	private findFirstStringLiteralNode(
		node: Parser.SyntaxNode,
	): Parser.SyntaxNode | null {
		let found: Parser.SyntaxNode | null = null;
		const visit = (n: Parser.SyntaxNode) => {
			if (found) return;
			if (this.isCommentNodeType(n.type)) return;
			if (this.isStringLiteralNodeType(n.type)) {
				found = n;
				return;
			}
			for (let i = 0; i < n.namedChildCount; i++) {
				const child = n.namedChild(i);
				if (child) visit(child);
			}
		};
		visit(node);
		return found;
	}

	private findStringLiteralNodes(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
		const found: Parser.SyntaxNode[] = [];
		const visit = (n: Parser.SyntaxNode) => {
			if (this.isCommentNodeType(n.type)) return;
			if (this.isStringLiteralNodeType(n.type)) {
				found.push(n);
				return;
			}
			for (let i = 0; i < n.namedChildCount; i++) {
				const child = n.namedChild(i);
				if (child) visit(child);
			}
		};
		visit(node);
		return found;
	}

	private extractCalledNameNode(
		callNode: Parser.SyntaxNode,
	): Parser.SyntaxNode | null {
		const callee =
			callNode.childForFieldName('function') ??
			callNode.childForFieldName('name') ??
			callNode.childForFieldName('method') ??
			callNode.childForFieldName('callee') ??
			callNode.childForFieldName('target') ??
			callNode.childForFieldName('macro') ??
			callNode.childForFieldName('constructor') ??
			(callNode.namedChildCount > 0 ? callNode.namedChild(0) : null);
		if (!callee) return null;

		if (this.isIdentifierNodeType(callee.type)) {
			const text = callee.text.trim();
			return this.isIdentifierLike(text) ? callee : null;
		}

		const property =
			callee.childForFieldName('property') ??
			callee.childForFieldName('field') ??
			callee.childForFieldName('attribute') ??
			callee.childForFieldName('name') ??
			callee.childForFieldName('method');
		if (property) {
			const text = property.text.trim();
			if (this.isIdentifierLike(text)) return property;
		}

		return this.findRightmostIdentifierNode(callee);
	}

	private findRightmostIdentifierNode(
		node: Parser.SyntaxNode,
	): Parser.SyntaxNode | null {
		let last: Parser.SyntaxNode | null = null;
		const visit = (n: Parser.SyntaxNode) => {
			if (this.isCommentNodeType(n.type)) return;
			if (this.isStringLiteralNodeType(n.type)) return;
			for (let i = 0; i < n.namedChildCount; i++) {
				const child = n.namedChild(i);
				if (child) visit(child);
			}
			if (this.isIdentifierNodeType(n.type)) {
				const text = n.text.trim();
				if (this.isIdentifierLike(text)) {
					last = n;
				}
			}
		};
		visit(node);
		return last;
	}

	private collectDefinitionNameRanges(
		root: Parser.SyntaxNode,
		lang: SupportedLanguage,
	): Set<string> {
		const out = new Set<string>();

		const isDefinitionNode = (nodeType: string) =>
			CLASS_NODE_TYPES[lang].includes(nodeType) ||
			FUNCTION_NODE_TYPES[lang].includes(nodeType) ||
			METHOD_NODE_TYPES[lang].includes(nodeType);

		const walk = (node: Parser.SyntaxNode) => {
			if (this.isCommentNodeType(node.type)) return;

			if (isDefinitionNode(node.type)) {
				const nameNode = this.extractNameNode(node, lang);
				if (nameNode) {
					out.add(`${nameNode.startIndex}|${nameNode.endIndex}`);
				}
			}

			for (let i = 0; i < node.namedChildCount; i++) {
				const child = node.namedChild(i);
				if (child) walk(child);
			}
		};

		walk(root);
		return out;
	}

	private isSymbolishIdentifier(text: string): boolean {
		if (text.length < 2) return false;
		if (/^[A-Z][A-Z0-9_]+$/.test(text)) return true; // SCREAMING_SNAKE_CASE
		return /^[A-Z][A-Za-z0-9]*$/.test(text); // PascalCase (best-effort)
	}

	private dedupeRefs(refs: ExtractedRef[]): ExtractedRef[] {
		const priority = (kind: ExtractedRef['ref_kind']): number => {
			switch (kind) {
				case 'import':
					return 4;
				case 'call':
					return 3;
				case 'identifier':
					return 2;
				case 'string_literal':
					return 1;
				default:
					return 0;
			}
		};

		const mergeTokenTexts = (base: string[], extra: string[]): string[] => {
			if (extra.length === 0) return base;
			const seen = new Set(base);
			const out = [...base];
			for (const t of extra) {
				if (!t) continue;
				if (seen.has(t)) continue;
				seen.add(t);
				out.push(t);
			}
			return out;
		};

		const byKey = new Map<string, {ref: ExtractedRef; order: number}>();
		for (let i = 0; i < refs.length; i++) {
			const ref = refs[i]!;
			const primary = ref.token_texts[0] ?? '';
			const key = `${ref.start_byte ?? ''}|${ref.end_byte ?? ''}|${primary}`;
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, {ref, order: i});
				continue;
			}

			const existingPriority = priority(existing.ref.ref_kind);
			const nextPriority = priority(ref.ref_kind);

			if (nextPriority > existingPriority) {
				byKey.set(key, {
					ref: {
						...ref,
						token_texts: mergeTokenTexts(
							ref.token_texts,
							existing.ref.token_texts,
						),
					},
					order: existing.order,
				});
			} else if (nextPriority === existingPriority) {
				byKey.set(key, {
					ref: {
						...existing.ref,
						token_texts: mergeTokenTexts(
							existing.ref.token_texts,
							ref.token_texts,
						),
					},
					order: existing.order,
				});
			}
		}

		return [...byKey.values()]
			.sort((a, b) => a.order - b.order)
			.map(v => v.ref);
	}

	private limitRefsPerToken(
		refs: ExtractedRef[],
		maxPerToken: number,
	): ExtractedRef[] {
		if (maxPerToken <= 0) return refs;
		const counts = new Map<string, number>();
		const out: ExtractedRef[] = [];

		for (const ref of refs) {
			const primary = ref.token_texts[0] ?? '';
			const key = `${ref.ref_kind}|${primary}`;
			const prev = counts.get(key) ?? 0;
			if (prev >= maxPerToken) continue;
			counts.set(key, prev + 1);
			out.push(ref);
		}

		return out;
	}

	private extractFallbackTokenFacts(text: string): TokenFacts {
		const identifiers: string[] = [];
		const stringLiterals: string[] = [];

		for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
			if (!match[0]) continue;
			identifiers.push(match[0]);
		}

		for (const match of text.matchAll(/(['"])(?:(?=(\\?))\2.)*?\1/g)) {
			if (!match[0]) continue;
			const stripped = this.stripStringLiteral(match[0]);
			if (stripped) stringLiterals.push(stripped.slice(0, 512));
		}

		const uniqueIdentifiers = this.uniqueStable(identifiers);
		const identifierParts = this.uniqueStable(
			uniqueIdentifiers.flatMap(id => this.splitIdentifierParts(id)),
		);

		return {
			identifiers: uniqueIdentifiers,
			identifierParts,
			calledNames: [],
			stringLiterals: this.uniqueStable(stringLiterals),
		};
	}

	/**
	 * Extract the name of a function/class/method from its node.
	 */
	private extractNameNode(
		node: Parser.SyntaxNode,
		_lang: SupportedLanguage,
	): Parser.SyntaxNode | null {
		// Try to get name via field first (works for many languages)
		const nameField = node.childForFieldName('name');
		if (nameField) {
			return nameField;
		}

		// Look for common identifier node types
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (!child) continue;

			// Common identifier types across languages
			if (
				child.type === 'identifier' ||
				child.type === 'name' ||
				child.type === 'simple_identifier' || // Kotlin, Swift
				child.type === 'type_identifier' // Rust, Go struct types
			) {
				return child;
			}

			// JS/TS method names
			if (child.type === 'property_identifier') {
				return child;
			}

			// Go type declarations (type Foo struct { })
			if (child.type === 'type_spec') {
				const specName = child.childForFieldName('name');
				if (specName) {
					return specName;
				}
			}
		}

		// For JS/TS variable declarations with arrow functions
		if (node.parent?.type === 'variable_declarator') {
			const varName = node.parent.childForFieldName('name');
			if (varName) {
				return varName;
			}
		}

		// For Rust impl blocks, try to get the type identifier node.
		if (node.type === 'impl_item') {
			const typeNode = node.childForFieldName('type');
			if (typeNode) {
				const typeId = this.findChildOfType(typeNode, [
					'type_identifier',
					'identifier',
				]);
				if (typeId) {
					return typeId;
				}
			}
		}

		return null;
	}

	private extractName(
		node: Parser.SyntaxNode,
		_lang: SupportedLanguage,
	): string {
		const nameNode = this.extractNameNode(node, _lang);
		if (!nameNode) return '';

		if (node.type === 'impl_item') {
			return `impl ${nameNode.text}`;
		}

		return nameNode.text;
	}

	/**
	 * Create a module-level chunk for the entire file.
	 */
	private createModuleChunk(filepath: string, content: string): Chunk {
		const lines = content.split('\n');
		const contextHeader = this.buildContextHeader(filepath, null, null, false);
		const fullText = `${contextHeader}\n${content}`;
		const tokenFacts = this.extractFallbackTokenFacts(content);
		return {
			text: content,
			contextHeader,
			type: 'module',
			name: '',
			startLine: 1,
			endLine: lines.length,
			startByte: 0,
			endByte: Buffer.byteLength(content, 'utf8'),
			contentHash: computeStringHash(fullText),
			// Module chunks don't have these metadata fields
			signature: null,
			docstring: null,
			isExported: true, // Entire module is implicitly "exported"
			decoratorNames: null,
			identifiers: tokenFacts.identifiers,
			identifierParts: tokenFacts.identifierParts,
			calledNames: tokenFacts.calledNames,
			stringLiterals: tokenFacts.stringLiterals,
		};
	}

	/**
	 * Chunk markdown files with heading-aware splitting and overlap.
	 *
	 * Strategy:
	 * 1. Try to split at heading boundaries (# lines)
	 * 2. Use sliding window with overlap between chunks
	 * 3. Merge small final chunks to avoid orphans
	 */
	private chunkMarkdown(
		filepath: string,
		content: string,
		maxChunkSize: number,
	): Chunk[] {
		const lines = content.split('\n');

		// If file is small enough, return as single module chunk
		if (
			content.length <= maxChunkSize &&
			lines.length <= MARKDOWN_TARGET_LINES * 1.5
		) {
			return [this.createModuleChunk(filepath, content)];
		}

		const chunks: Chunk[] = [];
		let currentStartLine = 0; // 0-indexed for array access
		let chunkIndex = 0;

		while (currentStartLine < lines.length) {
			// Calculate target end (before overlap)
			const targetEnd = Math.min(
				currentStartLine + MARKDOWN_TARGET_LINES,
				lines.length,
			);

			// Look for a heading boundary near the target to split cleanly
			let actualEnd = targetEnd;
			const searchStart = Math.max(
				targetEnd - 15,
				currentStartLine + Math.floor(MARKDOWN_TARGET_LINES / 3),
			);

			// Search backwards from target for a heading
			for (let i = targetEnd; i >= searchStart && i > currentStartLine; i--) {
				const line = lines[i];
				if (line && /^#{1,6}\s/.test(line)) {
					// Found a heading - split before it
					actualEnd = i;
					break;
				}
			}

			// If no heading found and we're at the end, take remaining lines
			if (actualEnd >= lines.length) {
				actualEnd = lines.length;
			}

			// Extract chunk lines
			const chunkLines = lines.slice(currentStartLine, actualEnd);
			const chunkText = chunkLines.join('\n');

			// Skip if chunk is too small and not at the end (will merge later)
			if (
				chunkText.trim().length < MIN_CHUNK_SIZE &&
				chunks.length > 0 &&
				actualEnd < lines.length
			) {
				// Move forward and let the next iteration include these lines
				currentStartLine = actualEnd;
				continue;
			}

			const chunk = this.createMarkdownChunk(
				filepath,
				chunkText,
				currentStartLine + 1, // 1-indexed
				currentStartLine + chunkLines.length, // 1-indexed
				chunkIndex > 0,
			);

			chunks.push(chunk);
			chunkIndex++;

			// Calculate next start with overlap
			const nextStart = actualEnd - MARKDOWN_OVERLAP_LINES;

			// Ensure we make progress
			if (nextStart <= currentStartLine) {
				currentStartLine = actualEnd;
			} else {
				currentStartLine = nextStart;
			}

			// Check if we've reached the end
			if (actualEnd >= lines.length) {
				break;
			}
		}

		// If final chunk is too small, merge with previous
		if (chunks.length >= 2) {
			const lastChunk = chunks[chunks.length - 1]!;
			if (lastChunk.text.length < MIN_CHUNK_SIZE) {
				const prevChunk = chunks[chunks.length - 2]!;
				// Merge last into previous
				const mergedText = prevChunk.text + '\n' + lastChunk.text;
				if (mergedText.length <= maxChunkSize * 1.5) {
					// Allow some overflow for merging
					const contextHeader = this.buildContextHeader(
						filepath,
						null,
						null,
						false,
					);
					const fullText = `${contextHeader}\n${mergedText}`;
					const mergedIdentifiers = this.uniqueStable([
						...prevChunk.identifiers,
						...lastChunk.identifiers,
					]);
					const mergedIdentifierParts = this.uniqueStable([
						...prevChunk.identifierParts,
						...lastChunk.identifierParts,
					]);
					const mergedCalledNames = this.uniqueStable([
						...prevChunk.calledNames,
						...lastChunk.calledNames,
					]);
					const mergedStringLiterals = this.uniqueStable([
						...prevChunk.stringLiterals,
						...lastChunk.stringLiterals,
					]);
					chunks[chunks.length - 2] = {
						...prevChunk,
						text: mergedText,
						endLine: lastChunk.endLine,
						endByte:
							prevChunk.endByte != null && lastChunk.endByte != null
								? lastChunk.endByte
								: null,
						identifiers: mergedIdentifiers,
						identifierParts: mergedIdentifierParts,
						calledNames: mergedCalledNames,
						stringLiterals: mergedStringLiterals,
						contentHash: computeStringHash(fullText),
					};
					chunks.pop();
				}
			}
		}

		return chunks;
	}

	/**
	 * Create a chunk from markdown content.
	 */
	private createMarkdownChunk(
		filepath: string,
		text: string,
		startLine: number,
		endLine: number,
		isContinuation: boolean,
	): Chunk {
		const contextHeader = this.buildContextHeader(
			filepath,
			null,
			null,
			isContinuation,
		);

		const fullText = `${contextHeader}\n${text}`;
		const tokenFacts = this.extractFallbackTokenFacts(text);

		return {
			text,
			contextHeader,
			type: 'module',
			name: '',
			startLine,
			endLine,
			startByte: null,
			endByte: null,
			contentHash: computeStringHash(fullText),
			signature: null,
			docstring: null,
			isExported: true,
			decoratorNames: null,
			identifiers: tokenFacts.identifiers,
			identifierParts: tokenFacts.identifierParts,
			calledNames: tokenFacts.calledNames,
			stringLiterals: tokenFacts.stringLiterals,
		};
	}

	/**
	 * Enforce size limits: split oversized chunks and merge tiny ones.
	 *
	 * @param overlapLines - Number of lines to overlap between chunks (for context continuity)
	 */
	private enforceSizeLimits(
		chunks: Chunk[],
		maxSize: number,
		content: string,
		_lang: SupportedLanguage, // Reserved for future AST-based splitting
		filepath: string,
		overlapLines: number = 0,
	): Chunk[] {
		const lines = content.split('\n');
		const result: Chunk[] = [];

		for (const chunk of chunks) {
			if (chunk.text.length <= maxSize) {
				result.push(chunk);
			} else {
				// Split oversized chunk by lines
				const splitChunks = this.splitChunkByLines(
					chunk,
					maxSize,
					lines,
					filepath,
					overlapLines,
				);
				result.push(...splitChunks);
			}
		}

		// Merge small adjacent chunks of the same type
		return this.mergeSmallChunks(result, maxSize);
	}

	/**
	 * Split an oversized chunk by lines.
	 * Tries to split at natural boundaries (empty lines, statement ends).
	 *
	 * @param overlapLines - Number of lines from previous chunk to include for context
	 */
	private splitChunkByLines(
		chunk: Chunk,
		maxSize: number,
		allLines: string[],
		filepath: string,
		overlapLines: number = 0,
	): Chunk[] {
		const chunkLines = allLines.slice(chunk.startLine - 1, chunk.endLine);
		const result: Chunk[] = [];

		let currentLines: string[] = [];
		let currentStartLine = chunk.startLine;
		let currentSize = 0;
		let partIndex = 0;

		for (let i = 0; i < chunkLines.length; i++) {
			const line = chunkLines[i]!;
			const lineNumber = chunk.startLine + i;

			if (line.length > maxSize) {
				if (currentLines.length > 0) {
					const chunkEndLine = currentStartLine + currentLines.length - 1;
					result.push(
						this.createSplitChunk(
							chunk,
							currentLines,
							currentStartLine,
							chunkEndLine,
							filepath,
							partIndex > 0,
						),
					);
					partIndex++;
					currentLines = [];
					currentSize = 0;
				}

				const segments = this.splitLongLine(line, maxSize);
				for (const segment of segments) {
					result.push(
						this.createSplitChunk(
							chunk,
							[segment],
							lineNumber,
							lineNumber,
							filepath,
							partIndex > 0,
						),
					);
					partIndex++;
				}

				currentStartLine = lineNumber + 1;
				continue;
			}

			const lineSize = line.length + 1; // +1 for newline

			// Check if adding this line would exceed max size
			if (currentSize + lineSize > maxSize && currentLines.length > 0) {
				// Flush current chunk
				const chunkEndLine = currentStartLine + currentLines.length - 1;
				result.push(
					this.createSplitChunk(
						chunk,
						currentLines,
						currentStartLine,
						chunkEndLine,
						filepath,
						partIndex > 0,
					),
				);
				partIndex++;

				// Start next chunk with overlap from the end of previous chunk
				if (overlapLines > 0 && currentLines.length > overlapLines) {
					// Include last N lines from previous chunk as overlap
					const overlapStart = currentLines.length - overlapLines;
					currentLines = currentLines.slice(overlapStart);
					currentStartLine = chunkEndLine - overlapLines + 1;
					currentSize = currentLines.reduce((sum, l) => sum + l.length + 1, 0);
				} else {
					// No overlap or previous chunk too small
					currentLines = [];
					currentStartLine = lineNumber;
					currentSize = 0;
				}
			}

			currentLines.push(line);
			currentSize += lineSize;
		}

		// Flush remaining lines
		if (currentLines.length > 0) {
			result.push(
				this.createSplitChunk(
					chunk,
					currentLines,
					currentStartLine,
					currentStartLine + currentLines.length - 1,
					filepath,
					partIndex > 0,
				),
			);
		}

		return result;
	}

	private splitLongLine(line: string, maxSize: number): string[] {
		const segments: string[] = [];
		for (let i = 0; i < line.length; i += maxSize) {
			segments.push(line.slice(i, i + maxSize));
		}
		return segments;
	}

	/**
	 * Create a chunk from a split portion.
	 */
	private createSplitChunk(
		original: Chunk,
		lines: string[],
		startLine: number,
		endLine: number,
		filepath: string,
		isContinuation: boolean,
	): Chunk {
		const text = lines.join('\n');

		// Build context header with continuation marker if needed
		const parentClass =
			original.type === 'method'
				? this.extractClassFromContext(original.contextHeader)
				: null;
		const functionName =
			original.type === 'function' ||
			(original.type === 'method' && isContinuation)
				? original.name
				: null;

		const contextHeader = this.buildContextHeader(
			filepath,
			parentClass,
			functionName,
			isContinuation,
		);

		const fullText = `${contextHeader}\n${text}`;
		const tokenFacts = this.extractFallbackTokenFacts(text);

		return {
			text,
			contextHeader,
			type: original.type,
			name: original.name,
			startLine,
			endLine,
			startByte: null,
			endByte: null,
			contentHash: computeStringHash(fullText),
			// Inherit metadata from original chunk
			// Only first part gets the signature; continuations get null
			signature: isContinuation ? null : original.signature,
			docstring: isContinuation ? null : original.docstring,
			isExported: original.isExported,
			decoratorNames: isContinuation ? null : original.decoratorNames,
			identifiers: tokenFacts.identifiers,
			identifierParts: tokenFacts.identifierParts,
			calledNames: tokenFacts.calledNames,
			stringLiterals: tokenFacts.stringLiterals,
		};
	}

	/**
	 * Extract class name from a context header string.
	 */
	private extractClassFromContext(contextHeader: string): string | null {
		const match = contextHeader.match(/Class: ([^,)]+)/);
		return match ? match[1]! : null;
	}

	/**
	 * Merge small adjacent chunks of the same type to avoid fragment explosion.
	 */
	private mergeSmallChunks(chunks: Chunk[], maxSize: number): Chunk[] {
		if (chunks.length <= 1) return chunks;

		const result: Chunk[] = [];
		let current = chunks[0]!;

		for (let i = 1; i < chunks.length; i++) {
			const next = chunks[i]!;

			// Check if we should merge: both small, same type, adjacent
			const canMerge =
				current.text.length < MIN_CHUNK_SIZE &&
				next.text.length < MIN_CHUNK_SIZE &&
				current.type === next.type &&
				current.endLine + 1 >= next.startLine &&
				current.text.length + next.text.length + 1 <= maxSize;

			if (canMerge) {
				// Merge chunks
				const mergedText = current.text + '\n' + next.text;
				const fullText = `${current.contextHeader}\n${mergedText}`;
				const mergedIdentifiers = this.uniqueStable([
					...current.identifiers,
					...next.identifiers,
				]);
				const mergedIdentifierParts = this.uniqueStable([
					...current.identifierParts,
					...next.identifierParts,
				]);
				const mergedCalledNames = this.uniqueStable([
					...current.calledNames,
					...next.calledNames,
				]);
				const mergedStringLiterals = this.uniqueStable([
					...current.stringLiterals,
					...next.stringLiterals,
				]);

				current = {
					...current,
					text: mergedText,
					endLine: next.endLine,
					endByte:
						current.endByte != null && next.endByte != null
							? next.endByte
							: null,
					identifiers: mergedIdentifiers,
					identifierParts: mergedIdentifierParts,
					calledNames: mergedCalledNames,
					stringLiterals: mergedStringLiterals,
					contentHash: computeStringHash(fullText),
				};
			} else {
				result.push(current);
				current = next;
			}
		}

		result.push(current);
		return result;
	}

	/**
	 * Close the parser and free resources.
	 */
	close(): void {
		// Delete the parser to free WASM memory
		if (this.parser) {
			this.parser.delete();
			this.parser = null;
		}
		// Clear the language cache
		this.languages.clear();
		this.initialized = false;
	}
}
