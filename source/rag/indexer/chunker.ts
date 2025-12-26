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
	 * @param filepath - Path to the file (used for extension detection)
	 * @param content - File content to parse
	 * @returns Array of extracted chunks
	 */
	async chunkFile(filepath: string, content: string): Promise<Chunk[]> {
		if (!this.initialized) {
			await this.initialize();
		}

		// Determine language from extension
		const ext = path.extname(filepath);
		const lang = this.getLanguageForExtension(ext);

		if (!lang || !this.languages.has(lang)) {
			// Unsupported language - return module-level chunk
			return [this.createModuleChunk(content)];
		}

		// Set parser language
		const language = this.languages.get(lang)!;
		this.parser!.setLanguage(language);

		// Parse the content
		const tree = this.parser!.parse(content);

		// If parsing failed, fall back to module chunk
		if (!tree) {
			return [this.createModuleChunk(content)];
		}

		// Extract chunks based on language
		const chunks = this.extractChunks(tree.rootNode, content, lang);

		// If no chunks found, fall back to module chunk
		if (chunks.length === 0) {
			return [this.createModuleChunk(content)];
		}

		return chunks;
	}

	/**
	 * Extract chunks from a syntax tree.
	 */
	private extractChunks(
		root: Node,
		content: string,
		lang: SupportedLanguage,
	): Chunk[] {
		const chunks: Chunk[] = [];
		const lines = content.split('\n');

		// Traverse the tree
		this.traverseNode(root, lang, lines, chunks, false);

		return chunks;
	}

	/**
	 * Recursively traverse nodes to extract chunks.
	 */
	private traverseNode(
		node: Node,
		lang: SupportedLanguage,
		lines: string[],
		chunks: Chunk[],
		insideClass: boolean,
	): void {
		const nodeType = node.type;

		// Check for class
		if (CLASS_NODE_TYPES[lang].includes(nodeType)) {
			const chunk = this.nodeToChunk(node, lines, 'class', lang);
			if (chunk) {
				chunks.push(chunk);
			}

			// Also extract methods from inside the class
			for (const child of node.children) {
				this.traverseNode(child, lang, lines, chunks, true);
			}

			return;
		}

		// Check for function/method
		const functionTypes = FUNCTION_NODE_TYPES[lang];
		const methodTypes = METHOD_NODE_TYPES[lang];

		if (insideClass && methodTypes.includes(nodeType)) {
			// This is a method inside a class
			const chunk = this.nodeToChunk(node, lines, 'method', lang);
			if (chunk) {
				chunks.push(chunk);
			}

			return;
		}

		if (!insideClass && functionTypes.includes(nodeType)) {
			// This is a top-level function
			const chunk = this.nodeToChunk(node, lines, 'function', lang);
			if (chunk) {
				chunks.push(chunk);
			}

			return;
		}

		// Recurse into children
		for (const child of node.children) {
			this.traverseNode(child, lang, lines, chunks, insideClass);
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

		return {
			text,
			type,
			name,
			startLine,
			endLine,
			contentHash: computeStringHash(text),
		};
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
	private createModuleChunk(content: string): Chunk {
		const lines = content.split('\n');
		return {
			text: content,
			type: 'module',
			name: '',
			startLine: 1,
			endLine: lines.length,
			contentHash: computeStringHash(content),
		};
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
