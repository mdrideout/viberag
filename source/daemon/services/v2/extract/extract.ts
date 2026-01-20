/**
 * V2 extraction - deterministic facts from files.
 *
 * This pass performs parsing/chunking + token fact extraction but does not
 * touch embeddings or storage.
 */

import path from 'node:path';
import {computeStringHash} from '../../../lib/merkle/hash.js';
import type {Chunker} from '../../../lib/chunker/index.js';
import type {Chunk} from '../../../lib/chunker/types.js';
import type {V2ChunkKind, V2SymbolKind} from '../storage/types.js';

export type V2ExtractedSymbol = {
	symbol_id: string;
	repo_id: string;
	revision: string;
	file_path: string;
	extension: string;
	language_hint: string | null;
	start_line: number;
	end_line: number;
	start_byte: number | null;
	end_byte: number | null;

	symbol_kind: V2SymbolKind | string;
	symbol_name: string;
	qualname: string;
	symbol_name_fuzzy: string;
	qualname_fuzzy: string;
	parent_symbol_id: string | null;
	signature: string | null;
	docstring: string | null;
	is_exported: boolean;
	decorator_names: string[];

	context_header: string;
	code_text: string;
	search_text: string;

	identifiers_text: string;
	identifiers: string[];
	identifier_parts: string[];
	called_names: string[];
	string_literals: string[];

	content_hash: string;
	file_hash: string;

	embed_input: string;
	embed_hash: string;
};

export type V2ExtractedChunk = {
	chunk_id: string;
	repo_id: string;
	revision: string;
	file_path: string;
	extension: string;
	start_line: number;
	end_line: number;
	start_byte: number | null;
	end_byte: number | null;

	owner_symbol_id: string | null;
	chunk_kind: V2ChunkKind | string;

	context_header: string;
	code_text: string;
	search_text: string;

	identifiers_text: string;
	identifiers: string[];
	identifier_parts: string[];
	called_names: string[];
	string_literals: string[];

	content_hash: string;
	file_hash: string;

	embed_input: string;
	embed_hash: string;
};

export type V2ExtractedFile = {
	file_id: string;
	repo_id: string;
	revision: string;
	file_path: string;
	extension: string;
	file_hash: string;

	imports: string[];
	exports: string[];
	top_level_doc: string | null;

	file_summary_text: string;

	embed_input: string;
	embed_hash: string;
};

export type V2ExtractedRef = {
	ref_id: string;
	repo_id: string;
	revision: string;
	file_path: string;
	extension: string;
	start_line: number;
	end_line: number;
	start_byte: number | null;
	end_byte: number | null;
	ref_kind: 'import' | 'call' | 'identifier' | 'string_literal';
	token_texts: string[];
	context_snippet: string;
	module_name: string | null;
	imported_name: string | null;
};

export type V2ExtractedArtifacts = {
	file: V2ExtractedFile;
	symbols: V2ExtractedSymbol[];
	chunks: V2ExtractedChunk[];
	refs: V2ExtractedRef[];
};

export type V2ExtractOptions = {
	repoId: string;
	revision: string;
	chunkMaxSize: number;
	// If a symbol is smaller than this, we don't emit sub-chunks for it.
	minSymbolCharsForChunks?: number;
};

const DEFAULT_MIN_SYMBOL_CHARS_FOR_CHUNKS = 1200;

export async function extractV2FromFile(
	chunker: Chunker,
	filePath: string,
	content: string,
	options: V2ExtractOptions,
): Promise<V2ExtractedArtifacts> {
	const extension = path.extname(filePath);
	const language_hint = languageHintFromExtension(extension);
	const file_hash = computeStringHash(content);
	const contentLines = content.split('\n');

	// Parse once: extract definition spans, size-constrained chunks, and AST refs.
	const analysis = chunker.analyzeFile(filePath, content, {
		chunkMaxSize: options.chunkMaxSize,
		definitionMaxChunkSize: Number.MAX_SAFE_INTEGER,
		refs: {
			identifier_mode: 'symbolish',
			max_occurrences_per_token: 0,
			include_string_literals: false,
		},
	});

	const definitionChunks = analysis.definition_chunks;
	const chunks = analysis.chunks;

	const refs: V2ExtractedRef[] = analysis.refs.map(r => {
		const startKey = r.start_byte ?? r.start_line;
		const endKey = r.end_byte ?? r.end_line;
		const ref_id = computeStringHash(
			`${options.repoId}|${options.revision}|${filePath}|${r.ref_kind}|${startKey}|${endKey}|${r.module_name ?? ''}|${r.imported_name ?? ''}`,
		);
		const token_texts = uniqueStable(
			(r.token_texts ?? [])
				.map(t => (typeof t === 'string' ? t.trim() : ''))
				.filter(Boolean),
		);
		return {
			ref_id,
			repo_id: options.repoId,
			revision: options.revision,
			file_path: filePath,
			extension,
			start_line: r.start_line,
			end_line: r.end_line,
			start_byte: r.start_byte,
			end_byte: r.end_byte,
			ref_kind: r.ref_kind,
			token_texts,
			context_snippet: buildContextSnippetFromPreSplitLines(
				contentLines,
				r.start_line,
				r.end_line,
			),
			module_name: r.module_name,
			imported_name: r.imported_name,
		};
	});

	// Build exported symbol list from deterministic extraction
	const exportedNames = definitionChunks
		.filter(
			c => c.type !== 'module' && c.isExported && c.name.trim().length > 0,
		)
		.map(c => c.name.trim());

	const imports = uniqueStable(
		analysis.refs
			.filter(r => r.ref_kind === 'import')
			.map(r => (typeof r.module_name === 'string' ? r.module_name : ''))
			.map(m => m.trim())
			.filter(Boolean),
	);
	const top_level_doc = extractTopLevelDoc(content, extension);

	const file_summary_text = buildFileSummaryText({
		file_path: filePath,
		imports,
		exports: exportedNames,
		top_level_doc,
	});

	const file_id = computeStringHash(
		`${options.repoId}|${options.revision}|${filePath}`,
	);

	const file: V2ExtractedFile = {
		file_id,
		repo_id: options.repoId,
		revision: options.revision,
		file_path: filePath,
		extension,
		file_hash,
		imports,
		exports: exportedNames,
		top_level_doc,
		file_summary_text,
		embed_input: file_summary_text,
		embed_hash: computeStringHash(file_summary_text),
	};

	// Build class name -> class symbol_id map for parent relationships
	const classIdByName = new Map<string, string>();

	// First pass: build symbols (class/function/method)
	const symbols: V2ExtractedSymbol[] = [];
	for (const chunk of definitionChunks) {
		if (chunk.type === 'module') continue;

		const symbol_kind = chunk.type;
		const symbol_name = chunk.name?.trim() ?? '';
		const parentClassName = extractClassFromContextHeader(chunk.contextHeader);
		const qualname =
			symbol_kind === 'method' && parentClassName
				? `${parentClassName}.${symbol_name}`
				: symbol_name;

		const normalizedSignature = normalizeSignature(chunk.signature);
		const identityPart =
			normalizedSignature && normalizedSignature.length > 0
				? normalizedSignature
				: `${symbol_name}|${chunk.startByte ?? chunk.startLine}`;

		const symbol_id = computeStringHash(
			`${options.repoId}|${filePath}|${symbol_kind}|${qualname}|${identityPart}`,
		);

		if (symbol_kind === 'class' && symbol_name.length > 0) {
			classIdByName.set(symbol_name, symbol_id);
		}

		const decorator_names = chunk.decoratorNames
			? chunk.decoratorNames
					.split(',')
					.map(d => d.trim())
					.filter(Boolean)
			: [];

		const identifiers = chunk.identifiers;
		const identifier_parts = chunk.identifierParts;
		const called_names = chunk.calledNames;
		const string_literals = chunk.stringLiterals;

		const identifiers_text = identifiers.join(' ');

		const search_text = buildSymbolSearchText({
			symbol_name,
			qualname,
			signature: chunk.signature,
			docstring: chunk.docstring,
			context_header: chunk.contextHeader,
			identifiers_text,
		});

		const embed_input = buildSymbolEmbedInput({
			signature: chunk.signature,
			docstring: chunk.docstring,
			context_header: chunk.contextHeader,
		});

		symbols.push({
			symbol_id,
			repo_id: options.repoId,
			revision: options.revision,
			file_path: filePath,
			extension,
			language_hint,
			start_line: chunk.startLine,
			end_line: chunk.endLine,
			start_byte: chunk.startByte,
			end_byte: chunk.endByte,

			symbol_kind,
			symbol_name,
			qualname,
			symbol_name_fuzzy: symbol_name,
			qualname_fuzzy: qualname,
			parent_symbol_id: null,
			signature: chunk.signature,
			docstring: chunk.docstring,
			is_exported: chunk.isExported,
			decorator_names,

			context_header: chunk.contextHeader,
			code_text: chunk.text,
			search_text,

			identifiers_text,
			identifiers,
			identifier_parts,
			called_names,
			string_literals,

			content_hash: chunk.contentHash,
			file_hash,

			embed_input,
			embed_hash: computeStringHash(embed_input),
		});
	}

	// Second pass: attach parent_symbol_id for methods where we can find the class.
	for (const symbol of symbols) {
		if (symbol.symbol_kind !== 'method') continue;
		const parentClassName = symbol.qualname.includes('.')
			? symbol.qualname.split('.')[0]
			: null;
		if (!parentClassName) continue;
		const parentId = classIdByName.get(parentClassName);
		if (parentId) {
			symbol.parent_symbol_id = parentId;
		}
	}

	// Build chunks table rows (blocks)
	const minSymbolCharsForChunks =
		options.minSymbolCharsForChunks ?? DEFAULT_MIN_SYMBOL_CHARS_FOR_CHUNKS;

	const symbolByKey = new Map<string, V2ExtractedSymbol>();
	for (const s of symbols) {
		symbolByKey.set(buildSymbolLookupKey(s), s);
	}

	const extractedChunks: V2ExtractedChunk[] = [];
	for (const chunk of chunks) {
		const chunk_kind = inferChunkKind(chunk, extension);
		const owner_symbol_id = inferOwnerSymbolIdForChunk(
			chunk,
			extension,
			symbolByKey,
			minSymbolCharsForChunks,
		);

		// For small definitions, the symbol row is the product; don't duplicate as chunks.
		if (!owner_symbol_id && chunk.type !== 'module') {
			continue;
		}

		const identifiers = chunk.identifiers;
		const identifier_parts = chunk.identifierParts;
		const called_names = chunk.calledNames;
		const string_literals = chunk.stringLiterals;
		const identifiers_text = identifiers.join(' ');

		const search_text = buildChunkSearchText({
			context_header: chunk.contextHeader,
			code_text: chunk.text,
			identifiers_text,
		});

		const embed_input = `${chunk.contextHeader}\n${chunk.text}`;
		const content_hash = chunk.contentHash;
		const embed_hash = content_hash;

		const startKey = chunk.startByte ?? chunk.startLine;
		const endKey = chunk.endByte ?? chunk.endLine;
		const chunk_id = computeStringHash(
			`${owner_symbol_id ?? ''}|${filePath}|${startKey}|${endKey}|${content_hash}`,
		);

		extractedChunks.push({
			chunk_id,
			repo_id: options.repoId,
			revision: options.revision,
			file_path: filePath,
			extension,
			start_line: chunk.startLine,
			end_line: chunk.endLine,
			start_byte: chunk.startByte,
			end_byte: chunk.endByte,

			owner_symbol_id,
			chunk_kind,

			context_header: chunk.contextHeader,
			code_text: chunk.text,
			search_text,

			identifiers_text,
			identifiers,
			identifier_parts,
			called_names,
			string_literals,

			content_hash,
			file_hash,

			embed_input,
			embed_hash,
		});
	}

	return {
		file,
		symbols,
		chunks: extractedChunks,
		refs,
	};
}

function languageHintFromExtension(extension: string): string | null {
	switch (extension.toLowerCase()) {
		case '.ts':
		case '.mts':
		case '.cts':
			return 'typescript';
		case '.tsx':
			return 'tsx';
		case '.js':
		case '.mjs':
		case '.cjs':
			return 'javascript';
		case '.py':
			return 'python';
		case '.go':
			return 'go';
		case '.rs':
			return 'rust';
		case '.java':
			return 'java';
		case '.cs':
			return 'csharp';
		case '.kt':
		case '.kts':
			return 'kotlin';
		case '.swift':
			return 'swift';
		case '.php':
			return 'php';
		case '.md':
		case '.mdx':
		case '.markdown':
			return 'markdown';
		default:
			return null;
	}
}

function normalizeSignature(signature: string | null): string {
	if (!signature) return '';
	return signature.trim().replace(/\s+/g, ' ');
}

function extractClassFromContextHeader(contextHeader: string): string | null {
	const match = contextHeader.match(/Class: ([^,)]+)/);
	return match ? match[1]!.trim() : null;
}

function buildSymbolEmbedInput(args: {
	signature: string | null;
	docstring: string | null;
	context_header: string;
}): string {
	const parts: string[] = [];
	if (args.signature) parts.push(args.signature);
	if (args.docstring) parts.push(args.docstring);
	parts.push(args.context_header);
	return parts.join('\n');
}

function buildSymbolSearchText(args: {
	symbol_name: string;
	qualname: string;
	signature: string | null;
	docstring: string | null;
	context_header: string;
	identifiers_text: string;
}): string {
	return [
		args.symbol_name,
		args.qualname,
		args.signature ?? '',
		args.docstring ?? '',
		args.context_header,
		args.identifiers_text,
	]
		.filter(Boolean)
		.join('\n');
}

function buildChunkSearchText(args: {
	context_header: string;
	code_text: string;
	identifiers_text: string;
}): string {
	return [args.context_header, args.identifiers_text, args.code_text]
		.filter(Boolean)
		.join('\n');
}

function buildFileSummaryText(args: {
	file_path: string;
	imports: string[];
	exports: string[];
	top_level_doc: string | null;
}): string {
	const lines: string[] = [];
	lines.push(`File: ${args.file_path}`);
	if (args.exports.length > 0) {
		lines.push(`Exports: ${args.exports.join(', ')}`);
	}
	if (args.imports.length > 0) {
		lines.push(`Imports: ${args.imports.join(', ')}`);
	}
	if (args.top_level_doc) {
		lines.push(args.top_level_doc);
	}
	return lines.join('\n');
}

function inferChunkKind(chunk: Chunk, extension: string): V2ChunkKind {
	const lowerExt = extension.toLowerCase();
	if (lowerExt === '.md' || lowerExt === '.mdx' || lowerExt === '.markdown') {
		return 'markdown_section';
	}
	if (chunk.type === 'module') {
		return 'block';
	}
	if (
		chunk.type === 'function' ||
		chunk.type === 'class' ||
		chunk.type === 'method'
	) {
		return 'statement_group';
	}
	return 'unknown';
}

function inferOwnerSymbolIdForChunk(
	chunk: Chunk,
	extension: string,
	symbolByKey: Map<string, V2ExtractedSymbol>,
	minSymbolCharsForChunks: number,
): string | null {
	const lowerExt = extension.toLowerCase();
	if (lowerExt === '.md' || lowerExt === '.mdx' || lowerExt === '.markdown') {
		return null;
	}
	if (chunk.type !== 'module') {
		const key = buildSymbolLookupKeyFromChunk(chunk);
		const symbol = symbolByKey.get(key);
		if (!symbol) return null;
		if (symbol.code_text.length < minSymbolCharsForChunks) return null;
		return symbol.symbol_id;
	}
	return null;
}

function buildSymbolLookupKey(symbol: V2ExtractedSymbol): string {
	if (symbol.symbol_kind === 'method') {
		const className = symbol.qualname.includes('.')
			? symbol.qualname.split('.')[0]!
			: '';
		return `method|${className}|${symbol.symbol_name}`;
	}
	return `${symbol.symbol_kind}|${symbol.symbol_name}`;
}

function buildSymbolLookupKeyFromChunk(chunk: Chunk): string {
	if (chunk.type === 'method') {
		const className = extractClassFromContextHeader(chunk.contextHeader) ?? '';
		return `method|${className}|${chunk.name ?? ''}`;
	}
	return `${chunk.type}|${chunk.name ?? ''}`;
}

function uniqueStable(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function buildContextSnippetFromPreSplitLines(
	lines: string[],
	startLine: number,
	endLine: number,
): string {
	const totalLines = lines.length;
	const clampedStart = Math.max(1, Math.min(totalLines, startLine));
	const clampedEnd = Math.max(clampedStart, Math.min(totalLines, endLine));

	const radius = 1;
	const from = Math.max(1, clampedStart - radius);
	const to = Math.min(totalLines, clampedEnd + radius);

	return lines
		.slice(from - 1, to)
		.join('\n')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractTopLevelDoc(content: string, extension: string): string | null {
	const ext = extension.toLowerCase();

	// JS/TS: /** ... */ at top
	if (
		ext === '.ts' ||
		ext === '.tsx' ||
		ext === '.js' ||
		ext === '.mjs' ||
		ext === '.cjs'
	) {
		const trimmed = content.trimStart();
		if (trimmed.startsWith('/**')) {
			const end = trimmed.indexOf('*/');
			if (end !== -1) {
				return trimmed.slice(0, end + 2).trim();
			}
		}
		return null;
	}

	// Python: leading triple-quote docstring
	if (ext === '.py') {
		const trimmed = content.trimStart();
		if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
			const quote = trimmed.startsWith('"""') ? '"""' : "'''";
			const end = trimmed.indexOf(quote, quote.length);
			if (end !== -1) {
				return trimmed.slice(0, end + quote.length).trim();
			}
		}
		return null;
	}

	// Markdown: first heading + paragraph
	if (ext === '.md' || ext === '.mdx' || ext === '.markdown') {
		const lines = content.split('\n');
		const out: string[] = [];
		for (let i = 0; i < lines.length && i < 40; i++) {
			const line = lines[i] ?? '';
			if (line.trim().length === 0 && out.length > 0) {
				break;
			}
			out.push(line);
		}
		const joined = out.join('\n').trim();
		return joined.length > 0 ? joined : null;
	}

	return null;
}
