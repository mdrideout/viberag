/**
 * Tree-sitter grammar support matrix for the chunker.
 *
 * This is kept in a lightweight module so CLI/MCP status can report language
 * coverage without importing `web-tree-sitter` or initializing WASM grammars.
 */

import type {SupportedLanguage} from './types.js';

export const LANGUAGE_DISPLAY_NAMES: Record<SupportedLanguage, string> = {
	javascript: 'JavaScript',
	typescript: 'TypeScript',
	tsx: 'TSX',
	python: 'Python',
	go: 'Go',
	rust: 'Rust',
	java: 'Java',
	csharp: 'C#',
	kotlin: 'Kotlin',
	swift: 'Swift',
	dart: 'Dart',
	php: 'PHP',
};

/**
 * Mapping from our language names to tree-sitter-wasms filenames.
 * WASM files are in node_modules/tree-sitter-wasms/out/
 */
export const LANGUAGE_WASM_FILES: Record<SupportedLanguage, string | null> = {
	javascript: 'tree-sitter-javascript.wasm',
	typescript: 'tree-sitter-typescript.wasm',
	tsx: 'tree-sitter-tsx.wasm',
	python: 'tree-sitter-python.wasm',
	go: 'tree-sitter-go.wasm',
	rust: 'tree-sitter-rust.wasm',
	java: 'tree-sitter-java.wasm',
	csharp: 'tree-sitter-c_sharp.wasm',
	kotlin: 'tree-sitter-kotlin.wasm',
	swift: 'tree-sitter-swift.wasm',
	dart: null, // Disabled: wasm version mismatch (see DISABLED_LANGUAGE_REASONS.dart)
	php: 'tree-sitter-php.wasm',
};

const DISABLED_LANGUAGE_REASONS: Partial<Record<SupportedLanguage, string>> = {
	// tree-sitter-wasms Dart WASM is version 15, but web-tree-sitter 0.24.7 supports 13-14.
	dart: 'Disabled: tree-sitter-wasms Dart WASM v15 is incompatible with web-tree-sitter 0.24.7 (supports 13–14).',
};

export type GrammarSupport = {
	language: SupportedLanguage;
	display_name: string;
	wasm_file: string | null;
	enabled: boolean;
	reason: string | null;
};

export function getGrammarSupport(): GrammarSupport[] {
	const languages = Object.keys(LANGUAGE_WASM_FILES) as SupportedLanguage[];
	return languages.sort().map(language => {
		const wasm_file = LANGUAGE_WASM_FILES[language];
		const enabled = Boolean(wasm_file);
		return {
			language,
			display_name: LANGUAGE_DISPLAY_NAMES[language],
			wasm_file,
			enabled,
			reason: enabled ? null : (DISABLED_LANGUAGE_REASONS[language] ?? null),
		};
	});
}

export function getGrammarSupportSummary(): {
	enabled: GrammarSupport[];
	disabled: Array<Pick<GrammarSupport, 'language' | 'display_name' | 'reason'>>;
} {
	const all = getGrammarSupport();
	return {
		enabled: all.filter(g => g.enabled),
		disabled: all
			.filter(g => !g.enabled)
			.map(g => ({
				language: g.language,
				display_name: g.display_name,
				reason: g.reason,
			})),
	};
}
