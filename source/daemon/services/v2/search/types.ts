/**
 * V2 search types.
 *
 * Search is intent-routed and returns grouped, agent-centric results.
 */

import type {V2RefKind} from '../storage/types.js';

export type V2SearchIntent =
	| 'auto'
	| 'definition'
	| 'usage'
	| 'concept'
	| 'exact_text'
	| 'similar_code';

export type V2SearchWarning = {
	code: string;
	message: string;
};

export type V2SearchScope = {
	path_prefix?: string[];
	path_contains?: string[];
	path_not_contains?: string[];
	extension?: string[];
};

export type V2ExplainChannel = {
	channel: 'fts' | 'vector';
	source: string;
	rank: number;
	rawScore: number;
};

export type V2Explain = {
	channels: V2ExplainChannel[];
	priors: Array<{name: string; value: number; note: string}>;
};

export type V2HitBase = {
	table: 'symbols' | 'chunks' | 'files' | 'refs';
	id: string;
	file_path: string;
	start_line: number;
	end_line: number;
	title: string;
	snippet: string;
	score: number;
	why?: V2Explain;
};

export type V2SearchGroups = {
	definitions: V2HitBase[];
	usages: V2HitBase[];
	files: V2HitBase[];
	blocks: V2HitBase[];
};

export type V2NextAction = {
	tool:
		| 'get_symbol_details'
		| 'read_file_lines'
		| 'get_surrounding_code'
		| 'find_references';
	args: Record<string, unknown>;
};

export type V2SearchResponse = {
	intent_used: Exclude<V2SearchIntent, 'auto'>;
	filters_applied: V2SearchScope;
	warnings?: V2SearchWarning[];
	groups: V2SearchGroups;
	suggested_next_actions: V2NextAction[];
};

export type V2SearchOptions = {
	intent?: V2SearchIntent;
	scope?: V2SearchScope;
	k?: number;
	explain?: boolean;
};

export type V2FindUsagesOptions = {
	symbol_id?: string;
	symbol_name?: string;
	scope?: V2SearchScope;
	k?: number;
};

export type V2UsageRef = {
	ref_id: string;
	file_path: string;
	start_line: number;
	end_line: number;
	ref_kind: V2RefKind;
	token_text: string;
	context_snippet: string;
	score: number;
	why?: V2Explain;
	module_name: string | null;
	imported_name: string | null;
};

export type V2FindUsagesResponse = {
	query: {symbol_id?: string; symbol_name?: string};
	resolved: {symbol_id?: string; symbol_name: string};
	filters_applied: V2SearchScope;
	by_file: Array<{file_path: string; refs: V2UsageRef[]}>;
	total_refs: number;
	suggested_next_actions: V2NextAction[];
};
