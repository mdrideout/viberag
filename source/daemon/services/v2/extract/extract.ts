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
	token_text: string;
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

	// Symbol extraction wants canonical, unsplit definition spans. We avoid the
	// chunker's size-based splitting by using a very large max chunk size.
	const definitionChunks = chunker.chunkFile(filePath, content, 1_000_000);

	// Chunk extraction uses configured size limits (may split large bodies).
	const chunks = chunker.chunkFile(filePath, content, options.chunkMaxSize);

	const refs = extractRefsFromContent({
		repoId: options.repoId,
		revision: options.revision,
		filePath,
		extension,
		content,
	});

	// Build exported symbol list from deterministic extraction
	const exportedNames = definitionChunks
		.filter(
			c => c.type !== 'module' && c.isExported && c.name.trim().length > 0,
		)
		.map(c => c.name.trim());

	const imports = extractImports(content, extension);
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

const NON_CALL_NAMES = new Set([
	'if',
	'for',
	'while',
	'switch',
	'catch',
	'function',
	'return',
	'await',
	'new',
	'throw',
	'case',
	'do',
	'try',
	'else',
	'with',
	'break',
	'continue',
]);

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

function extractImports(content: string, extension: string): string[] {
	const ext = extension.toLowerCase();
	if (
		ext === '.ts' ||
		ext === '.tsx' ||
		ext === '.js' ||
		ext === '.mjs' ||
		ext === '.cjs'
	) {
		const modules: string[] = [];
		const importFrom = /\bimport\s+(?:type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g;
		const importBare = /\bimport\s+['"]([^'"]+)['"]/g;
		let match: RegExpExecArray | null;
		while ((match = importFrom.exec(content)) !== null) {
			modules.push(match[1]!);
		}
		while ((match = importBare.exec(content)) !== null) {
			modules.push(match[1]!);
		}
		return uniqueStable(modules);
	}

	if (ext === '.py') {
		const modules: string[] = [];
		const importRe = /^\s*import\s+([A-Za-z0-9_.]+)/gm;
		const fromRe = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm;
		let match: RegExpExecArray | null;
		while ((match = importRe.exec(content)) !== null) {
			modules.push(match[1]!);
		}
		while ((match = fromRe.exec(content)) !== null) {
			modules.push(match[1]!);
		}
		return uniqueStable(modules);
	}

	if (ext === '.go') {
		const modules: string[] = [];
		const single = /^\s*import\s+"([^"]+)"\s*$/gm;
		const block = /^\s*import\s*\(\s*([\s\S]*?)\s*\)\s*$/gm;
		let match: RegExpExecArray | null;
		while ((match = single.exec(content)) !== null) {
			modules.push(match[1]!);
		}
		while ((match = block.exec(content)) !== null) {
			const body = match[1] ?? '';
			const inner = /"([^"]+)"/g;
			let innerMatch: RegExpExecArray | null;
			while ((innerMatch = inner.exec(body)) !== null) {
				modules.push(innerMatch[1]!);
			}
		}
		return uniqueStable(modules);
	}

	return [];
}

type RefMatch = {
	ref_kind: 'import' | 'call' | 'identifier' | 'string_literal';
	token_text: string;
	startIndex: number;
	endIndex: number;
	module_name: string | null;
	imported_name: string | null;
};

function extractRefsFromContent(args: {
	repoId: string;
	revision: string;
	filePath: string;
	extension: string;
	content: string;
}): V2ExtractedRef[] {
	const lineStarts = buildLineStarts(args.content);
	const rawMatches: RefMatch[] = [
		...extractImportRefMatches(args.content, args.extension),
		...extractCallRefMatches(args.content),
		...extractStringLiteralRefMatches(args.content),
		...extractIdentifierRefMatches(args.content),
	];

	rawMatches.sort(
		(a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex,
	);

	const matches = dedupeRefMatches(rawMatches);

	const refs: V2ExtractedRef[] = [];
	for (const m of matches) {
		const start_line = lineNumberAtIndex(lineStarts, m.startIndex);
		const end_line = lineNumberAtIndex(
			lineStarts,
			Math.max(m.startIndex, m.endIndex - 1),
		);
		const context_snippet = buildContextSnippet(
			args.content,
			m.startIndex,
			m.endIndex,
		);
		const ref_id = computeStringHash(
			`${args.repoId}|${args.revision}|${args.filePath}|${m.ref_kind}|${m.startIndex}|${m.endIndex}|${m.token_text}|${m.module_name ?? ''}|${m.imported_name ?? ''}`,
		);
		refs.push({
			ref_id,
			repo_id: args.repoId,
			revision: args.revision,
			file_path: args.filePath,
			extension: args.extension,
			start_line,
			end_line,
			start_byte: null,
			end_byte: null,
			ref_kind: m.ref_kind,
			token_text: m.token_text,
			context_snippet,
			module_name: m.module_name,
			imported_name: m.imported_name,
		});
	}

	return refs;
}

function dedupeRefMatches(matches: RefMatch[]): RefMatch[] {
	const byKey = new Map<
		string,
		{
			match: RefMatch;
			order: number;
		}
	>();

	for (let i = 0; i < matches.length; i++) {
		const m = matches[i]!;
		const key = `${m.startIndex}|${m.endIndex}|${m.token_text}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, {match: m, order: i});
			continue;
		}
		if (
			refKindPriority(m.ref_kind) > refKindPriority(existing.match.ref_kind)
		) {
			byKey.set(key, {match: m, order: existing.order});
		}
	}

	return [...byKey.values()]
		.sort((a, b) => a.order - b.order)
		.map(v => v.match);
}

function refKindPriority(kind: RefMatch['ref_kind']): number {
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
}

function buildLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			starts.push(i + 1);
		}
	}
	return starts;
}

function lineNumberAtIndex(starts: number[], index: number): number {
	if (index <= 0) return 1;
	let lo = 0;
	let hi = starts.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const start = starts[mid]!;
		if (start === index) return mid + 1;
		if (start < index) lo = mid + 1;
		else hi = mid - 1;
	}
	return Math.max(1, Math.min(starts.length, lo));
}

function buildContextSnippet(
	text: string,
	startIndex: number,
	endIndex: number,
): string {
	const radius = 80;
	const start = Math.max(0, startIndex - radius);
	const end = Math.min(text.length, endIndex + radius);
	const raw = text.slice(start, end);
	return raw.replace(/\s+/g, ' ').trim();
}

const IDENTIFIER_KEYWORDS = new Set([
	// Common across languages
	'true',
	'false',
	'null',
	'undefined',
	// JS/TS keywords
	'const',
	'let',
	'var',
	'function',
	'class',
	'return',
	'if',
	'else',
	'for',
	'while',
	'do',
	'switch',
	'case',
	'break',
	'continue',
	'try',
	'catch',
	'finally',
	'throw',
	'new',
	'import',
	'export',
	'from',
	'as',
	'await',
	'async',
	'extends',
	'implements',
	'interface',
	'type',
	'enum',
	'public',
	'private',
	'protected',
	'static',
	'get',
	'set',
	// Python keywords (subset)
	'def',
	'lambda',
	'pass',
	'raise',
	'with',
	'yield',
	'in',
	'is',
	'and',
	'or',
	'not',
	'None',
]);

function extractIdentifierRefMatches(text: string): RefMatch[] {
	const pattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
	const matches: RefMatch[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const token = match[0] ?? '';
		if (!token) continue;
		if (IDENTIFIER_KEYWORDS.has(token)) continue;
		matches.push({
			ref_kind: 'identifier',
			token_text: token,
			startIndex: match.index,
			endIndex: match.index + token.length,
			module_name: null,
			imported_name: null,
		});
	}
	return matches;
}

function extractCallRefMatches(text: string): RefMatch[] {
	const pattern =
		/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g;
	const matches: RefMatch[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const full = match[1] ?? '';
		if (!full) continue;
		const last = full.includes('.') ? full.split('.').pop()! : full;
		if (NON_CALL_NAMES.has(last)) continue;
		if (isLikelyDefinitionCallMatch(text, match.index)) continue;
		const localIdx = full.lastIndexOf(last);
		const startIndex = match.index + localIdx;
		matches.push({
			ref_kind: 'call',
			token_text: last,
			startIndex,
			endIndex: startIndex + last.length,
			module_name: null,
			imported_name: null,
		});
	}
	return matches;
}

function isLikelyDefinitionCallMatch(
	text: string,
	calleeStartIndex: number,
): boolean {
	const lineStart =
		text.lastIndexOf('\n', Math.max(0, calleeStartIndex - 1)) + 1;
	const prefix = text.slice(lineStart, calleeStartIndex);

	// JS/TS function declarations: export default async function foo(
	if (
		/^\s*(export\s+)?(default\s+)?(declare\s+)?(async\s+)?function\*?\s*$/.test(
			prefix,
		)
	) {
		return true;
	}

	// Python defs: async def foo(
	if (/^\s*(async\s+)?def\s*$/.test(prefix)) {
		return true;
	}

	// Rust fns: pub async fn foo(
	if (/^\s*(pub\s+)?(async\s+)?fn\s*$/.test(prefix)) {
		return true;
	}

	// Go funcs: func foo( or func (r *Receiver) Foo(
	if (/^\s*func(?:\s*\([^)]*\))?\s*$/.test(prefix)) {
		return true;
	}

	return false;
}

function extractStringLiteralRefMatches(text: string): RefMatch[] {
	const pattern =
		/("([^"\\\n]|\\.)*")|('([^'\\\n]|\\.)*')|(`([^`\\\n]|\\.)*`)/g;
	const matches: RefMatch[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const raw = match[0] ?? '';
		if (raw.length < 2) continue;
		const inner = raw.slice(1, -1);
		if (inner.trim().length === 0) continue;
		const startIndex = match.index + 1;
		matches.push({
			ref_kind: 'string_literal',
			token_text: inner,
			startIndex,
			endIndex: startIndex + inner.length,
			module_name: null,
			imported_name: null,
		});
	}
	return matches;
}

function extractImportRefMatches(text: string, extension: string): RefMatch[] {
	const ext = extension.toLowerCase();
	if (
		ext === '.ts' ||
		ext === '.tsx' ||
		ext === '.js' ||
		ext === '.mjs' ||
		ext === '.cjs'
	) {
		return extractImportRefMatchesJs(text);
	}
	if (ext === '.py') {
		return extractImportRefMatchesPython(text);
	}
	if (ext === '.go') {
		return extractImportRefMatchesGo(text);
	}
	return [];
}

function extractImportRefMatchesJs(text: string): RefMatch[] {
	const matches: RefMatch[] = [];

	const importFrom =
		/^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
	const bareImport = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

	let match: RegExpExecArray | null;
	while ((match = importFrom.exec(text)) !== null) {
		const clause = (match[1] ?? '').trim();
		const moduleName = match[2] ?? '';
		const full = match[0] ?? '';
		const base = match.index;

		const imported = parseJsImportClause(clause);
		for (const entry of imported) {
			const nameToFind = entry.local;
			const localIdx = full.indexOf(nameToFind);
			const startIndex = localIdx >= 0 ? base + localIdx : base;
			matches.push({
				ref_kind: 'import',
				token_text: entry.local,
				startIndex,
				endIndex: startIndex + entry.local.length,
				module_name: moduleName,
				imported_name: entry.imported,
			});
			if (
				entry.local !== entry.imported &&
				entry.imported !== 'default' &&
				entry.imported !== '*' &&
				/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry.imported)
			) {
				matches.push({
					ref_kind: 'import',
					token_text: entry.imported,
					startIndex,
					endIndex: startIndex + entry.imported.length,
					module_name: moduleName,
					imported_name: entry.imported,
				});
			}
		}
	}

	while ((match = bareImport.exec(text)) !== null) {
		const moduleName = match[1] ?? '';
		const full = match[0] ?? '';
		const base = match.index;
		const localIdx = full.indexOf(moduleName);
		const startIndex = localIdx >= 0 ? base + localIdx : base;
		matches.push({
			ref_kind: 'import',
			token_text: moduleName,
			startIndex,
			endIndex: startIndex + moduleName.length,
			module_name: moduleName,
			imported_name: null,
		});
	}

	return matches;
}

function parseJsImportClause(
	clause: string,
): Array<{imported: string; local: string}> {
	const out: Array<{imported: string; local: string}> = [];
	const trimmed = clause.trim();
	if (!trimmed) return out;

	// Namespace import: * as ns
	const ns = trimmed.match(/^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
	if (ns?.[1]) {
		out.push({imported: '*', local: ns[1]});
		return out;
	}

	// Named imports: {a, b as c}
	const named = trimmed.match(/^\{([\s\S]*)\}$/);
	if (named) {
		const inside = named[1] ?? '';
		for (const part of inside.split(',')) {
			let p = part.trim();
			if (!p) continue;
			if (p.startsWith('type ')) {
				p = p.slice('type '.length).trim();
				if (!p) continue;
			}
			const asMatch = p.match(
				/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/,
			);
			if (asMatch?.[1] && asMatch?.[2]) {
				out.push({imported: asMatch[1], local: asMatch[2]});
			} else {
				out.push({imported: p, local: p});
			}
		}
		return out;
	}

	// Default + named: defaultName, {a as b}
	const defaultPlusNamed = trimmed.match(
		/^([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*(\{[\s\S]*\})$/,
	);
	if (defaultPlusNamed?.[1] && defaultPlusNamed?.[2]) {
		out.push({imported: 'default', local: defaultPlusNamed[1]});
		out.push(...parseJsImportClause(defaultPlusNamed[2]));
		return out;
	}

	// Default import: defaultName
	const def = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
	if (def?.[1]) {
		out.push({imported: 'default', local: def[1]});
	}
	return out;
}

function extractImportRefMatchesPython(text: string): RefMatch[] {
	const matches: RefMatch[] = [];

	const importRe = /^\s*import\s+(.+)\s*$/gm;
	const fromRe = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)\s*$/gm;

	let match: RegExpExecArray | null;
	while ((match = importRe.exec(text)) !== null) {
		const clause = (match[1] ?? '').trim();
		const full = match[0] ?? '';
		const base = match.index;
		for (const part of clause.split(',')) {
			const p = part.trim();
			if (!p) continue;
			const asMatch = p.match(
				/^([A-Za-z0-9_.]+)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/,
			);
			if (asMatch?.[1] && asMatch?.[2]) {
				const moduleName = asMatch[1];
				const local = asMatch[2];
				const localIdx = full.indexOf(local);
				const startIndex = localIdx >= 0 ? base + localIdx : base;
				matches.push({
					ref_kind: 'import',
					token_text: local,
					startIndex,
					endIndex: startIndex + local.length,
					module_name: moduleName,
					imported_name: null,
				});
				matches.push({
					ref_kind: 'import',
					token_text: moduleName.split('.').pop() ?? moduleName,
					startIndex,
					endIndex:
						startIndex + (moduleName.split('.').pop() ?? moduleName).length,
					module_name: moduleName,
					imported_name: null,
				});
			} else {
				const moduleName = p;
				const name = moduleName.split('.').pop() ?? moduleName;
				const localIdx = full.indexOf(name);
				const startIndex = localIdx >= 0 ? base + localIdx : base;
				matches.push({
					ref_kind: 'import',
					token_text: name,
					startIndex,
					endIndex: startIndex + name.length,
					module_name: moduleName,
					imported_name: null,
				});
			}
		}
	}

	while ((match = fromRe.exec(text)) !== null) {
		const moduleName = match[1] ?? '';
		const clause = (match[2] ?? '').trim();
		const full = match[0] ?? '';
		const base = match.index;
		const cleaned = clause.replace(/^\(([\s\S]*)\)$/g, '$1');
		for (const part of cleaned.split(',')) {
			const p = part.trim();
			if (!p || p === '*') continue;
			const asMatch = p.match(
				/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/,
			);
			if (asMatch?.[1] && asMatch?.[2]) {
				const imported = asMatch[1];
				const local = asMatch[2];
				const localIdx = full.indexOf(local);
				const startIndex = localIdx >= 0 ? base + localIdx : base;
				matches.push({
					ref_kind: 'import',
					token_text: local,
					startIndex,
					endIndex: startIndex + local.length,
					module_name: moduleName,
					imported_name: imported,
				});
				matches.push({
					ref_kind: 'import',
					token_text: imported,
					startIndex,
					endIndex: startIndex + imported.length,
					module_name: moduleName,
					imported_name: imported,
				});
			} else {
				const imported = p;
				const localIdx = full.indexOf(imported);
				const startIndex = localIdx >= 0 ? base + localIdx : base;
				matches.push({
					ref_kind: 'import',
					token_text: imported,
					startIndex,
					endIndex: startIndex + imported.length,
					module_name: moduleName,
					imported_name: imported,
				});
			}
		}
	}

	return matches;
}

function extractImportRefMatchesGo(text: string): RefMatch[] {
	const matches: RefMatch[] = [];

	const single = /^\s*import\s+(?:(\w+)\s+)?"([^"]+)"\s*$/gm;
	const block = /^\s*import\s*\(\s*([\s\S]*?)\s*\)\s*$/gm;

	let match: RegExpExecArray | null;
	while ((match = single.exec(text)) !== null) {
		const alias = match[1] ?? null;
		const moduleName = match[2] ?? '';
		const full = match[0] ?? '';
		const base = match.index;
		const pkg = moduleName.split('/').pop() ?? moduleName;
		const local = alias ?? pkg;
		const localIdx = full.indexOf(local);
		const startIndex = localIdx >= 0 ? base + localIdx : base;
		matches.push({
			ref_kind: 'import',
			token_text: local,
			startIndex,
			endIndex: startIndex + local.length,
			module_name: moduleName,
			imported_name: pkg,
		});
	}

	while ((match = block.exec(text)) !== null) {
		const body = match[1] ?? '';
		const base = match.index;
		const lines = body.split('\n');
		let offset = 0;
		for (const line of lines) {
			const m = line.match(/^\s*(?:(\w+)\s+)?"([^"]+)"\s*$/);
			if (!m) {
				offset += line.length + 1;
				continue;
			}
			const alias = m[1] ?? null;
			const moduleName = m[2] ?? '';
			const pkg = moduleName.split('/').pop() ?? moduleName;
			const local = alias ?? pkg;
			const localIdx = line.indexOf(local);
			const startIndex =
				localIdx >= 0 ? base + offset + localIdx : base + offset;
			matches.push({
				ref_kind: 'import',
				token_text: local,
				startIndex,
				endIndex: startIndex + local.length,
				module_name: moduleName,
				imported_name: pkg,
			});
			offset += line.length + 1;
		}
	}

	return matches;
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
