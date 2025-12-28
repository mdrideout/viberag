import {createRequire} from 'node:module';
import path from 'node:path';
import {Parser, Language, Node} from 'web-tree-sitter';
import {computeStringHash} from '../merkle/hash.js';
import {
	EXTENSION_TO_LANGUAGE,
	type Chunk,
	type ChunkType,
	type SupportedLanguage,
} from './types.js';

// Use require to resolve paths to wasm files in node_modules
const require = createRequire(import.meta.url);

/**
 * Paths to language WASM files.
 */
const LANGUAGE_WASM_PATHS: Record<SupportedLanguage, string> = {
	// JavaScript/TypeScript family
	javascript: require.resolve(
		'tree-sitter-javascript/tree-sitter-javascript.wasm',
	),
	typescript: require.resolve(
		'tree-sitter-typescript/tree-sitter-typescript.wasm',
	),
	tsx: require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
	// Python
	python: require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
	// Go
	go: require.resolve('tree-sitter-go/tree-sitter-go.wasm'),
	// Rust
	rust: require.resolve('tree-sitter-rust/tree-sitter-rust.wasm'),
	// Java
	java: require.resolve('tree-sitter-java/tree-sitter-java.wasm'),
	// C# (via tree-sitter-wasms for web-tree-sitter compatibility)
	csharp: require.resolve('tree-sitter-wasms/out/tree-sitter-c_sharp.wasm'),
	// Dart (via tree-sitter-wasms for web-tree-sitter compatibility)
	dart: require.resolve('tree-sitter-wasms/out/tree-sitter-dart.wasm'),
	// Swift (via tree-sitter-wasms for web-tree-sitter compatibility)
	swift: require.resolve('tree-sitter-wasms/out/tree-sitter-swift.wasm'),
	// Kotlin (via tree-sitter-wasms for web-tree-sitter compatibility)
	kotlin: require.resolve('tree-sitter-wasms/out/tree-sitter-kotlin.wasm'),
	// PHP (via tree-sitter-wasms for web-tree-sitter compatibility)
	php: require.resolve('tree-sitter-wasms/out/tree-sitter-php.wasm'),
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

// Note: Statement container types kept for future AST-based splitting
// const STATEMENT_CONTAINER_TYPES: Record<SupportedLanguage, string[]> = {
// 	python: ['block'],
// 	javascript: ['statement_block'],
// 	typescript: ['statement_block'],
// 	tsx: ['statement_block'],
// };

/**
 * Default max chunk size in characters.
 */
const DEFAULT_MAX_CHUNK_SIZE = 2000;

/**
 * Minimum chunk size before merging with siblings.
 */
const MIN_CHUNK_SIZE = 100;

/**
 * Chunker that uses tree-sitter to extract semantic code chunks.
 */
export class Chunker {
	private parser: Parser | null = null;
	private languages: Map<SupportedLanguage, Language> = new Map();
	private initialized = false;

	/**
	 * Initialize tree-sitter and load language grammars.
	 * Must be called before using chunkFile().
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		// Initialize the WASM runtime
		await Parser.init();

		// Create parser instance
		this.parser = new Parser();

		// Load all language grammars
		for (const [lang, wasmPath] of Object.entries(LANGUAGE_WASM_PATHS)) {
			try {
				const language = await Language.load(wasmPath);
				this.languages.set(lang as SupportedLanguage, language);
			} catch (error) {
				// Log but don't fail - we can still work with other languages
				console.error(`Failed to load ${lang} grammar:`, error);
			}
		}

		this.initialized = true;
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
	 * Extract chunks from a file.
	 *
	 * @param filepath - Path to the file (used for extension detection and context headers)
	 * @param content - File content to parse
	 * @param maxChunkSize - Maximum chunk size in characters (default: 2000)
	 * @returns Array of extracted chunks
	 */
	async chunkFile(
		filepath: string,
		content: string,
		maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE,
	): Promise<Chunk[]> {
		if (!this.initialized) {
			await this.initialize();
		}

		// Determine language from extension
		const ext = path.extname(filepath);
		const lang = this.getLanguageForExtension(ext);

		if (!lang || !this.languages.has(lang)) {
			// Unsupported language - return module-level chunk
			return [this.createModuleChunk(filepath, content)];
		}

		// Set parser language
		const language = this.languages.get(lang)!;
		this.parser!.setLanguage(language);

		// Parse the content
		const tree = this.parser!.parse(content);

		// If parsing failed, fall back to module chunk
		if (!tree) {
			return [this.createModuleChunk(filepath, content)];
		}

		// Extract chunks based on language with context tracking
		const chunks = this.extractChunks(tree.rootNode, content, lang, filepath);

		// If no chunks found, fall back to module chunk
		if (chunks.length === 0) {
			return [this.createModuleChunk(filepath, content)];
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
	 * Extract chunks from a syntax tree.
	 */
	private extractChunks(
		root: Node,
		content: string,
		lang: SupportedLanguage,
		filepath: string,
	): Chunk[] {
		const chunks: Chunk[] = [];
		const lines = content.split('\n');

		// Traverse the tree with context tracking
		this.traverseNode(root, lang, lines, chunks, filepath, null);

		return chunks;
	}

	/**
	 * Recursively traverse nodes to extract chunks.
	 * Tracks parent context (class name) for context headers.
	 */
	private traverseNode(
		node: Node,
		lang: SupportedLanguage,
		lines: string[],
		chunks: Chunk[],
		filepath: string,
		parentClassName: string | null,
	): void {
		const nodeType = node.type;

		// Check for class
		if (CLASS_NODE_TYPES[lang].includes(nodeType)) {
			const className = this.extractName(node, lang);
			const chunk = this.nodeToChunk(
				node,
				lines,
				'class',
				lang,
				filepath,
				null,
			);
			if (chunk) {
				chunks.push(chunk);
			}

			// Also extract methods from inside the class
			for (const child of node.children) {
				this.traverseNode(child, lang, lines, chunks, filepath, className);
			}

			return;
		}

		// Check for function/method
		const functionTypes = FUNCTION_NODE_TYPES[lang];
		const methodTypes = METHOD_NODE_TYPES[lang];

		if (parentClassName && methodTypes.includes(nodeType)) {
			// This is a method inside a class
			const chunk = this.nodeToChunk(
				node,
				lines,
				'method',
				lang,
				filepath,
				parentClassName,
			);
			if (chunk) {
				chunks.push(chunk);
			}

			return;
		}

		if (!parentClassName && functionTypes.includes(nodeType)) {
			// This is a top-level function
			const chunk = this.nodeToChunk(
				node,
				lines,
				'function',
				lang,
				filepath,
				null,
			);
			if (chunk) {
				chunks.push(chunk);
			}

			return;
		}

		// Recurse into children
		for (const child of node.children) {
			this.traverseNode(child, lang, lines, chunks, filepath, parentClassName);
		}
	}

	/**
	 * Convert a syntax node to a chunk.
	 */
	private nodeToChunk(
		node: Node,
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

		return {
			text,
			contextHeader,
			type,
			name,
			startLine,
			endLine,
			contentHash: computeStringHash(fullText),
			signature,
			docstring,
			isExported,
			decoratorNames,
		};
	}

	/**
	 * Extract the signature line (first line of function/class declaration).
	 */
	private extractSignature(
		node: Node,
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
	private extractDocstring(node: Node, lang: SupportedLanguage): string | null {
		// Python: Docstring as first string in body
		if (lang === 'python') {
			const body = node.childForFieldName('body');
			if (!body) return null;

			const firstStatement = body.children[0];
			if (firstStatement?.type === 'expression_statement') {
				const stringNode = firstStatement.children[0];
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
						comments.unshift(text.replace(/^\/\/[\/!]\s*/, ''));
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
						return text
							.replace(/^\/\*\*/, '')
							.replace(/\*\/$/, '')
							.replace(/^\s*\* ?/gm, '')
							.trim() || null;
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
						return text
							.replace(/^\/\*\*/, '')
							.replace(/\*\/$/, '')
							.replace(/^\s*\* ?/gm, '')
							.trim() || null;
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
		let checkNode: Node | null = node;

		while (checkNode) {
			const prev = checkNode.previousSibling;
			if (prev?.type === 'comment') {
				const text = prev.text;
				if (text.startsWith('/**')) {
					return text
						.replace(/^\/\*\*/, '')
						.replace(/\*\/$/, '')
						.replace(/^\s*\* ?/gm, '')
						.trim() || null;
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
	private extractIsExported(node: Node, lang: SupportedLanguage): boolean {
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
		let checkNode: Node | null = node;

		while (checkNode) {
			// Check if this node has export modifier
			if (checkNode.type === 'export_statement') {
				return true;
			}

			// Check for 'export' child (for class/function declarations)
			for (const child of checkNode.children) {
				if (child.type === 'export' || child.text === 'export') {
					return true;
				}
			}

			// Walk up through wrappers
			const parent: Node | null = checkNode.parent;
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
	private hasVisibilityModifier(node: Node, modifier: string): boolean {
		// Check direct children for visibility modifiers
		for (const child of node.children) {
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
				for (const grandchild of child.children) {
					if (
						grandchild.text === modifier ||
						grandchild.type === modifier
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
			for (const sibling of node.parent.children) {
				if (sibling === node) continue;
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
		node: Node,
		lang: SupportedLanguage,
	): string | null {
		const decorators: string[] = [];

		// Python: @decorator syntax
		if (lang === 'python') {
			let sibling = node.previousSibling;
			while (sibling) {
				if (sibling.type === 'decorator') {
					const nameNode = sibling.children.find(
						c => c.type === 'identifier' || c.type === 'call',
					);
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
				if (
					sibling.type === 'attribute_item' ||
					sibling.type === 'attribute'
				) {
					// Extract attribute name from #[name] or #[name(...)]
					const attrNode = sibling.children.find(
						c => c.type === 'attribute' || c.type === 'meta_item',
					);
					const target = attrNode || sibling;
					const pathNode = target.children.find(
						c =>
							c.type === 'path' ||
							c.type === 'identifier' ||
							c.type === 'scoped_identifier',
					);
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
					const nameNode = sibling.children.find(
						c => c.type === 'identifier' || c.type === 'scoped_identifier',
					);
					if (nameNode) {
						decorators.unshift(nameNode.text);
					}
				} else if (sibling.type === 'modifiers') {
					// Annotations may be inside modifiers node
					for (const child of sibling.children) {
						if (
							child.type === 'annotation' ||
							child.type === 'marker_annotation'
						) {
							const nameNode = child.children.find(
								c => c.type === 'identifier',
							);
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
					for (const attrNode of sibling.children) {
						if (attrNode.type === 'attribute') {
							const nameNode = attrNode.children.find(
								c =>
									c.type === 'identifier' ||
									c.type === 'qualified_name' ||
									c.type === 'name',
							);
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
					const nameNode = sibling.children.find(
						c =>
							c.type === 'user_type' ||
							c.type === 'simple_identifier' ||
							c.type === 'identifier',
					);
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
					const nameNode = sibling.children.find(
						c => c.type === 'identifier' || c.type === 'qualified',
					);
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
					for (const attrNode of sibling.children) {
						if (attrNode.type === 'attribute') {
							const nameNode = attrNode.children.find(
								c =>
									c.type === 'name' ||
									c.type === 'qualified_name' ||
									c.type === 'identifier',
							);
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
		else if (
			lang === 'javascript' ||
			lang === 'typescript' ||
			lang === 'tsx'
		) {
			let checkNode: Node | null = node;

			while (checkNode) {
				for (const child of checkNode.children) {
					if (child.type === 'decorator') {
						const expr = child.children.find(
							c => c.type === 'call_expression' || c.type === 'identifier',
						);
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
						const expr = sibling.children.find(
							c => c.type === 'call_expression' || c.type === 'identifier',
						);
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

				const parent: Node | null = checkNode.parent;
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

	/**
	 * Extract the name of a function/class/method from its node.
	 */
	private extractName(node: Node, _lang: SupportedLanguage): string {
		// Try to get name via field first (works for many languages)
		const nameField = node.childForFieldName('name');
		if (nameField) {
			return nameField.text;
		}

		// Look for common identifier node types
		for (const child of node.children) {
			// Common identifier types across languages
			if (
				child.type === 'identifier' ||
				child.type === 'name' ||
				child.type === 'simple_identifier' || // Kotlin, Swift
				child.type === 'type_identifier' // Rust, Go struct types
			) {
				return child.text;
			}

			// JS/TS method names
			if (child.type === 'property_identifier') {
				return child.text;
			}

			// Go type declarations (type Foo struct { })
			if (child.type === 'type_spec') {
				const specName = child.childForFieldName('name');
				if (specName) {
					return specName.text;
				}
			}
		}

		// For JS/TS variable declarations with arrow functions
		if (node.parent?.type === 'variable_declarator') {
			const varName = node.parent.childForFieldName('name');
			if (varName) {
				return varName.text;
			}
		}

		// For Rust impl blocks, try to get the type name
		if (node.type === 'impl_item') {
			const typeNode = node.childForFieldName('type');
			if (typeNode) {
				const typeId = typeNode.children.find(
					c => c.type === 'type_identifier' || c.type === 'identifier',
				);
				if (typeId) {
					return `impl ${typeId.text}`;
				}
			}
		}

		return '';
	}

	/**
	 * Create a module-level chunk for the entire file.
	 */
	private createModuleChunk(filepath: string, content: string): Chunk {
		const lines = content.split('\n');
		const contextHeader = this.buildContextHeader(filepath, null, null, false);
		const fullText = `${contextHeader}\n${content}`;
		return {
			text: content,
			contextHeader,
			type: 'module',
			name: '',
			startLine: 1,
			endLine: lines.length,
			contentHash: computeStringHash(fullText),
			// Module chunks don't have these metadata fields
			signature: null,
			docstring: null,
			isExported: true, // Entire module is implicitly "exported"
			decoratorNames: null,
		};
	}

	/**
	 * Enforce size limits: split oversized chunks and merge tiny ones.
	 */
	private enforceSizeLimits(
		chunks: Chunk[],
		maxSize: number,
		content: string,
		_lang: SupportedLanguage, // Reserved for future AST-based splitting
		filepath: string,
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
	 */
	private splitChunkByLines(
		chunk: Chunk,
		maxSize: number,
		allLines: string[],
		filepath: string,
	): Chunk[] {
		const chunkLines = allLines.slice(chunk.startLine - 1, chunk.endLine);
		const result: Chunk[] = [];

		let currentLines: string[] = [];
		let currentStartLine = chunk.startLine;
		let currentSize = 0;
		let partIndex = 0;

		for (let i = 0; i < chunkLines.length; i++) {
			const line = chunkLines[i]!;
			const lineSize = line.length + 1; // +1 for newline

			// Check if adding this line would exceed max size
			if (currentSize + lineSize > maxSize && currentLines.length > 0) {
				// Flush current chunk
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
				partIndex++;
				currentLines = [];
				currentStartLine = chunk.startLine + i;
				currentSize = 0;
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
			original.type === 'function' || original.type === 'method'
				? original.name
				: null;

		const contextHeader = this.buildContextHeader(
			filepath,
			parentClass,
			functionName,
			isContinuation,
		);

		const fullText = `${contextHeader}\n${text}`;

		return {
			text,
			contextHeader,
			type: original.type,
			name: original.name,
			startLine,
			endLine,
			contentHash: computeStringHash(fullText),
			// Inherit metadata from original chunk
			// Only first part gets the signature; continuations get null
			signature: isContinuation ? null : original.signature,
			docstring: isContinuation ? null : original.docstring,
			isExported: original.isExported,
			decoratorNames: isContinuation ? null : original.decoratorNames,
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
				current = {
					...current,
					text: mergedText,
					endLine: next.endLine,
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
		if (this.parser) {
			this.parser.delete();
			this.parser = null;
		}

		this.languages.clear();
		this.initialized = false;
	}
}
