/**
 * Search results display component with syntax highlighting.
 */

import React from 'react';
import {Box, Text, useStdout} from 'ink';
import {highlight} from 'cli-highlight';
import type {
	SearchExplain,
	SearchHit,
	SearchResultsData,
} from '../../common/types.js';

type Props = {
	data: SearchResultsData;
};

/**
 * Color mapping for tables.
 */
const TABLE_COLORS: Record<SearchHit['table'], string> = {
	symbols: 'magenta',
	chunks: 'gray',
	files: 'green',
	refs: 'yellow',
};

/**
 * Extension to language mapping for syntax highlighting.
 */
const EXT_TO_LANG: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	py: 'python',
	rs: 'rust',
	go: 'go',
	java: 'java',
};

/**
 * Get language from filepath for syntax highlighting.
 */
function getLanguage(filepath: string): string {
	const ext = filepath.split('.').pop()?.toLowerCase() ?? '';
	return EXT_TO_LANG[ext] ?? 'plaintext';
}

/**
 * Get score color based on value.
 */
function getScoreColor(score: number): string {
	if (score > 0.8) return 'green';
	if (score > 0.5) return 'yellow';
	return 'red';
}

function formatWhy(why: SearchExplain | undefined): {
	via: string;
	priors: string | null;
} | null {
	if (!why) return null;

	const via = why.channels
		.map(ch => `${ch.channel}(${ch.source}) #${ch.rank + 1}`)
		.join(', ');

	const priors =
		why.priors.length > 0
			? why.priors.map(p => `${p.name}×${p.value.toFixed(2)}`).join(', ')
			: null;

	return {via, priors};
}

/**
 * Truncate and format code snippet for display.
 */
function formatSnippet(
	text: string,
	filePath: string,
	maxWidth: number,
	maxLines: number = 4,
): string {
	const language = getLanguage(filePath);
	const lines = text.split('\n').slice(0, maxLines);

	// Truncate each line to max width
	const truncatedLines = lines.map(line => {
		if (line.length > maxWidth - 4) {
			return line.slice(0, maxWidth - 7) + '...';
		}
		return line;
	});

	const truncated = truncatedLines.join('\n');

	// Try to syntax highlight
	try {
		return highlight(truncated, {language, ignoreIllegals: true});
	} catch {
		return truncated;
	}
}

/**
 * Single search result component.
 */
function SearchResult({hit, maxWidth}: {hit: SearchHit; maxWidth: number}) {
	const tableColor = TABLE_COLORS[hit.table] ?? 'white';
	const scoreColor = getScoreColor(hit.score);

	// Format snippet with syntax highlighting
	const snippet = formatSnippet(hit.snippet, hit.filePath, maxWidth);
	const why = formatWhy(hit.why);

	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* Table badge and title */}
			<Box>
				<Text color={tableColor}>[{hit.table}]</Text>
				<Text> {hit.title}</Text>
			</Box>

			{/* File path and line numbers */}
			<Box>
				<Text> </Text>
				<Text color="green">{hit.filePath}</Text>
				<Text dimColor>
					:{hit.startLine}-{hit.endLine}
				</Text>
			</Box>

			{/* Score */}
			<Box>
				<Text> Score: </Text>
				<Text color={scoreColor}>{hit.score.toFixed(4)}</Text>
			</Box>

			{/* Syntax-highlighted code snippet */}
			<Box marginLeft={1} marginTop={0}>
				<Text>{snippet}</Text>
			</Box>

			{why && (
				<Box marginLeft={1} marginTop={0}>
					<Text dimColor>via: {why.via}</Text>
					{why.priors && (
						<Text dimColor>
							{'\n'}priors: {why.priors}
						</Text>
					)}
				</Box>
			)}
		</Box>
	);
}

/**
 * Search results display component.
 */
export default function SearchResultsDisplay({data}: Props) {
	const {stdout} = useStdout();
	const terminalWidth = stdout?.columns ?? 80;
	const maxSnippetWidth = Math.min(terminalWidth - 4, 176);

	const total =
		data.groups.definitions.length +
		data.groups.usages.length +
		data.groups.files.length +
		data.groups.blocks.length;

	if (total === 0) {
		return (
			<Box>
				<Text dimColor>
					No results found for "{data.query}" ({data.elapsedMs}ms)
				</Text>
			</Box>
		);
	}

	const filters = [
		data.filtersApplied.path_prefix?.length
			? `prefix=${data.filtersApplied.path_prefix.join(',')}`
			: null,
		data.filtersApplied.path_contains?.length
			? `contains=${data.filtersApplied.path_contains.join(',')}`
			: null,
		data.filtersApplied.path_not_contains?.length
			? `not_contains=${data.filtersApplied.path_not_contains.join(',')}`
			: null,
		data.filtersApplied.extension?.length
			? `ext=${data.filtersApplied.extension.join(',')}`
			: null,
	].filter(Boolean);

	return (
		<Box flexDirection="column">
			{/* Header */}
			<Box marginBottom={1}>
				<Text bold>Search </Text>
				<Text color="cyan">"{data.query}"</Text>
				<Text dimColor>
					{' '}
					· intent {data.intentUsed} · {data.elapsedMs}ms
				</Text>
			</Box>

			{filters.length > 0 && (
				<Box marginBottom={1}>
					<Text dimColor>scope: {filters.join(' · ')}</Text>
				</Box>
			)}

			{data.groups.definitions.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Definitions ({data.groups.definitions.length})</Text>
					{data.groups.definitions.map((hit, index) => (
						<SearchResult
							key={`${hit.filePath}:${hit.startLine}:def:${index}`}
							hit={hit}
							maxWidth={maxSnippetWidth}
						/>
					))}
				</Box>
			)}

			{data.groups.files.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Files ({data.groups.files.length})</Text>
					{data.groups.files.map((hit, index) => (
						<SearchResult
							key={`${hit.filePath}:${hit.startLine}:file:${index}`}
							hit={hit}
							maxWidth={maxSnippetWidth}
						/>
					))}
				</Box>
			)}

			{data.groups.blocks.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Blocks ({data.groups.blocks.length})</Text>
					{data.groups.blocks.map((hit, index) => (
						<SearchResult
							key={`${hit.filePath}:${hit.startLine}:block:${index}`}
							hit={hit}
							maxWidth={maxSnippetWidth}
						/>
					))}
				</Box>
			)}

			{data.groups.usages.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Usages ({data.groups.usages.length})</Text>
					{data.groups.usages.map((hit, index) => (
						<SearchResult
							key={`${hit.filePath}:${hit.startLine}:usage:${index}`}
							hit={hit}
							maxWidth={maxSnippetWidth}
						/>
					))}
				</Box>
			)}

			{data.suggestedNextActions.length > 0 && (
				<Box flexDirection="column">
					<Text dimColor>suggested:</Text>
					{data.suggestedNextActions.slice(0, 5).map((a, index) => (
						<Text key={`${a.tool}:${index}`} dimColor>
							- {a.tool} {JSON.stringify(a.args)}
						</Text>
					))}
				</Box>
			)}
		</Box>
	);
}
