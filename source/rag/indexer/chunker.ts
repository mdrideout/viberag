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
	python: require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
	javascript: require.resolve(
		'tree-sitter-javascript/tree-sitter-javascript.wasm',
	),
	typescript: require.resolve(
		'tree-sitter-typescript/tree-sitter-typescript.wasm',
	),
	tsx: require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
};

/**
 * Node types that represent functions in each language.
 */
const FUNCTION_NODE_TYPES: Record<SupportedLanguage, string[]> = {
	python: ['function_definition'],
	javascript: ['function_declaration', 'function_expression', 'arrow_function'],
	typescript: ['function_declaration', 'function_expression', 'arrow_function'],
	tsx: ['function_declaration', 'function_expression', 'arrow_function'],
};

/**
 * Node types that represent classes in each language.
 */
const CLASS_NODE_TYPES: Record<SupportedLanguage, string[]> = {
	python: ['class_definition'],
	javascript: ['class_declaration'],
	typescript: ['class_declaration'],
	tsx: ['class_declaration'],
};

/**
 * Node types that represent methods in each language.
 */
const METHOD_NODE_TYPES: Record<SupportedLanguage, string[]> = {
	python: ['function_definition'], // When inside a class
	javascript: ['method_definition'],
	typescript: ['method_definition'],
	tsx: ['method_definition'],
};

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
			const chunk = this.nodeToChunk(node, lines, 'class', lang, filepath, null);
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
			const chunk = this.nodeToChunk(node, lines, 'function', lang, filepath, null);
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

		return {
			text,
			contextHeader,
			type,
			name,
			startLine,
			endLine,
			contentHash: computeStringHash(fullText),
		};
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
	private extractName(node: Node, lang: SupportedLanguage): string {
		// Look for identifier child node
		for (const child of node.children) {
			if (child.type === 'identifier' || child.type === 'name') {
				return child.text;
			}

			// For JS/TS, check property_identifier for methods
			if (child.type === 'property_identifier') {
				return child.text;
			}
		}

		// For Python, look for the name node
		if (lang === 'python') {
			const nameNode = node.childForFieldName('name');
			if (nameNode) {
				return nameNode.text;
			}
		}

		// For JS/TS variable declarations with arrow functions
		if (node.parent?.type === 'variable_declarator') {
			const nameNode = node.parent.childForFieldName('name');
			if (nameNode) {
				return nameNode.text;
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
