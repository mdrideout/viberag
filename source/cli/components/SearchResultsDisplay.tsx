/**
 * Search results display component with syntax highlighting.
 */

import React from 'react';
import {Box, Text, useStdout} from 'ink';
import {highlight} from 'cli-highlight';
import type {SearchResultsData} from '../../common/types.js';

type Props = {
	data: SearchResultsData;
};

/**
 * Color mapping for chunk types.
 */
const TYPE_COLORS: Record<string, string> = {
	function: 'cyan',
	class: 'magenta',
	method: 'blue',
	module: 'gray',
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

/**
 * Truncate and format code snippet for display.
 */
function formatSnippet(
	text: string,
	filepath: string,
	maxWidth: number,
	maxLines: number = 4,
): string {
	const language = getLanguage(filepath);
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
function SearchResult({
	result,
	maxWidth,
}: {
	result: Props['data']['results'][0];
	maxWidth: number;
}) {
	const typeColor = TYPE_COLORS[result.type] ?? 'white';
	const scoreColor = getScoreColor(result.score);

	// Format snippet with syntax highlighting
	const snippet = formatSnippet(result.text, result.filepath, maxWidth);

	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* Type badge and name */}
			<Box>
				<Text color={typeColor}>[{result.type}]</Text>
				{result.name && <Text> {result.name}</Text>}
			</Box>

			{/* File path and line numbers */}
			<Box>
				<Text> </Text>
				<Text color="green">{result.filepath}</Text>
				<Text dimColor>
					:{result.startLine}-{result.endLine}
				</Text>
			</Box>

			{/* Score */}
			<Box>
				<Text> Score: </Text>
				<Text color={scoreColor}>{result.score.toFixed(4)}</Text>
			</Box>

			{/* Syntax-highlighted code snippet */}
			<Box marginLeft={1} marginTop={0}>
				<Text>{snippet}</Text>
			</Box>
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

	if (data.results.length === 0) {
		return (
			<Box>
				<Text dimColor>
					No results found for "{data.query}" ({data.elapsedMs}ms)
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			{/* Header */}
			<Box marginBottom={1}>
				<Text bold>Found {data.results.length} results for </Text>
				<Text color="cyan">"{data.query}"</Text>
				<Text dimColor> ({data.elapsedMs}ms):</Text>
			</Box>

			{/* Results */}
			{data.results.map((result, index) => (
				<SearchResult
					key={`${result.filepath}:${result.startLine}-${index}`}
					result={result}
					maxWidth={maxSnippetWidth}
				/>
			))}
		</Box>
	);
}
