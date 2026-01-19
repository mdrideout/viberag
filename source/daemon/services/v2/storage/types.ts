/**
 * Types for v2 storage tables.
 *
 * V2 tables store agent-centric entities: symbols, chunks, and files.
 * Column names are snake_case to match Arrow/LanceDB conventions.
 */

export type V2SymbolKind = 'function' | 'class' | 'method' | 'module';

export type V2ChunkKind =
	| 'statement_group'
	| 'block'
	| 'markdown_section'
	| 'unknown';

export type V2RefKind = 'import' | 'call' | 'identifier' | 'string_literal';

export type V2EmbeddingCacheRow = {
	input_hash: string;
	vector: number[];
	created_at: string;
};

export type V2SymbolRow = {
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

	vec_summary: number[];
};

export type V2ChunkRow = {
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

	vec_code: number[];
};

export type V2FileRow = {
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
	vec_file: number[];
};

export type V2RefRow = {
	ref_id: string;
	repo_id: string;
	revision: string;
	file_path: string;
	extension: string;
	start_line: number;
	end_line: number;
	start_byte: number | null;
	end_byte: number | null;
	ref_kind: V2RefKind | string;
	token_text: string;
	context_snippet: string;
	module_name: string | null;
	imported_name: string | null;
};
