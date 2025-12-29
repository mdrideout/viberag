/**
 * Multi-step initialization wizard component.
 * Guides users through embedding provider selection.
 */

import React from 'react';
import {Box, Text, useInput} from 'ink';
import SelectInput from 'ink-select-input';
import type {
	InitWizardConfig,
	EmbeddingProviderType,
} from '../../common/types.js';

type Props = {
	step: number;
	config: Partial<InitWizardConfig>;
	isReinit: boolean;
	onStepChange: (step: number, data?: Partial<InitWizardConfig>) => void;
	onComplete: (config: InitWizardConfig) => void;
	onCancel: () => void;
};

type SelectItem<T> = {
	label: string;
	value: T;
};

/**
 * Provider configurations with specs and pricing.
 */
const PROVIDER_CONFIG: Record<
	EmbeddingProviderType,
	{
		name: string;
		model: string;
		modelFull: string;
		dims: string;
		context: string;
		cost: string;
		note: string;
		description: string;
	}
> = {
	local: {
		name: 'Local',
		model: 'jina-v2-code',
		modelFull: 'jina-embeddings-v2-base-code',
		dims: '768',
		context: '8K',
		cost: 'Free',
		note: 'No API key needed',
		description: 'Offline, private, no costs',
	},
	gemini: {
		name: 'Gemini',
		model: 'text-embedding-004',
		modelFull: 'text-embedding-004',
		dims: '768',
		context: '2K',
		cost: 'Free tier',
		note: 'Free tier available',
		description: 'Google Cloud, fast API',
	},
	mistral: {
		name: 'Mistral',
		model: 'mistral-embed',
		modelFull: 'mistral-embed',
		dims: '1024',
		context: '8K',
		cost: '$0.10/1M',
		note: 'Good for code',
		description: 'Fast and affordable',
	},
	openai: {
		name: 'OpenAI',
		model: 'text-embedding-3-large',
		modelFull: 'text-embedding-3-large',
		dims: '3072',
		context: '8K',
		cost: '$0.13/1M',
		note: 'Highest quality',
		description: 'Best quality embeddings',
	},
};

// Simple provider options for selection
const PROVIDER_ITEMS: SelectItem<EmbeddingProviderType>[] = [
	{
		label: 'Local   - jina-v2-code, offline, no API key (Recommended)',
		value: 'local',
	},
	{
		label: 'Gemini  - text-embedding-004, free tier',
		value: 'gemini',
	},
	{
		label: 'Mistral - mistral-embed, good for code',
		value: 'mistral',
	},
	{
		label: 'OpenAI  - text-embedding-3-large, highest quality',
		value: 'openai',
	},
];

/**
 * Comparison table data.
 */
const COMPARISON_DATA = [
	{
		Provider: 'Local*',
		Model: 'jina-v2',
		Dims: '768',
		Context: '8K',
		Cost: 'Free',
	},
	{
		Provider: 'Gemini',
		Model: 'embed-004',
		Dims: '768',
		Context: '2K',
		Cost: 'Free tier',
	},
	{
		Provider: 'Mistral',
		Model: 'embed',
		Dims: '1024',
		Context: '8K',
		Cost: '$0.10/1M',
	},
	{
		Provider: 'OpenAI',
		Model: 'embed-3-lg',
		Dims: '3072',
		Context: '8K',
		Cost: '$0.13/1M',
	},
];

/**
 * Simple table component using ink Box and Text primitives.
 */
type TableColumn = {key: string; width: number};

function SimpleTable({
	data,
	columns,
}: {
	data: Record<string, string>[];
	columns: TableColumn[];
}): React.ReactElement {
	const dataRow = (row: Record<string, string>, isHeader = false) => {
		const cells = columns.map(col => {
			const value = row[col.key] ?? '';
			return ' ' + value.padEnd(col.width - 1);
		});
		return (
			<Text bold={isHeader} color={isHeader ? 'cyan' : undefined}>
				{'│' + cells.join('│') + '│'}
			</Text>
		);
	};

	// Header row from column keys
	const headerRow: Record<string, string> = {};
	for (const col of columns) {
		headerRow[col.key] = col.key;
	}

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text>
				{'┌' + columns.map(col => '─'.repeat(col.width)).join('┬') + '┐'}
			</Text>
			{dataRow(headerRow, true)}
			<Text>
				{'├' + columns.map(col => '─'.repeat(col.width)).join('┼') + '┤'}
			</Text>
			{data.map((row, i) => (
				<React.Fragment key={i}>{dataRow(row)}</React.Fragment>
			))}
			<Text>
				{'└' + columns.map(col => '─'.repeat(col.width)).join('┴') + '┘'}
			</Text>
		</Box>
	);
}

/**
 * Comparison table component showing all provider stats.
 */
function ComparisonTable(): React.ReactElement {
	const columns: TableColumn[] = [
		{key: 'Provider', width: 10},
		{key: 'Model', width: 14},
		{key: 'Dims', width: 6},
		{key: 'Context', width: 9},
		{key: 'Cost', width: 10},
	];

	return <SimpleTable data={COMPARISON_DATA} columns={columns} />;
}

// Reinit confirmation options
const REINIT_ITEMS: SelectItem<'continue' | 'cancel'>[] = [
	{label: 'Continue (reinitialize)', value: 'continue'},
	{label: 'Cancel', value: 'cancel'},
];

// Final confirmation options
const CONFIRM_ITEMS: SelectItem<'init' | 'cancel'>[] = [
	{label: 'Initialize', value: 'init'},
	{label: 'Cancel', value: 'cancel'},
];

export function InitWizard({
	step,
	config,
	isReinit,
	onStepChange,
	onComplete,
	onCancel,
}: Props): React.ReactElement {
	// Handle Escape to cancel
	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			onCancel();
		}
	});

	// Normalize props with defensive defaults
	const normalizedStep = typeof step === 'number' && !isNaN(step) ? step : 0;
	const normalizedIsReinit = typeof isReinit === 'boolean' ? isReinit : false;

	// Compute effective step (adjusted for non-reinit flow)
	const effectiveStep = normalizedIsReinit
		? normalizedStep
		: normalizedStep + 1;

	// Step 0 (reinit only): Confirmation
	if (normalizedIsReinit && normalizedStep === 0) {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="yellow">
					Viberag is already initialized
				</Text>
				<Text dimColor>
					This will reset your configuration and reindex the codebase.
				</Text>
				<Box marginTop={1}>
					<SelectInput
						items={REINIT_ITEMS}
						onSelect={item => {
							if (item.value === 'continue') {
								onStepChange(1);
							} else {
								onCancel();
							}
						}}
					/>
				</Box>
				<Text dimColor>
					{'\n'}Use arrow keys to navigate, Enter to select, Esc to cancel
				</Text>
			</Box>
		);
	}

	// Step 1: Provider selection
	// Fresh init: step=0 (effectiveStep=1), Reinit: step=1 (effectiveStep=1)
	if (effectiveStep === 1) {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>Choose Embedding Provider</Text>
				<Box marginTop={1}>
					<SelectInput
						items={PROVIDER_ITEMS}
						onSelect={item => {
							// Use relative increment: step + 1
							onStepChange(normalizedStep + 1, {provider: item.value});
						}}
					/>
				</Box>
				<ComparisonTable />
				<Box marginTop={1}>
					<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
				</Box>
			</Box>
		);
	}

	// Step 2: Confirmation
	if (effectiveStep === 2) {
		const provider = config.provider ?? 'gemini';
		const info = PROVIDER_CONFIG[provider];
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>Ready to Initialize</Text>
				<Box marginTop={1} flexDirection="column">
					<Text>
						<Text dimColor>Provider: </Text>
						<Text bold>{info.name}</Text>
						<Text dimColor> - {info.description}</Text>
					</Text>
					<Text>
						<Text dimColor>Model: </Text>
						{info.modelFull}
					</Text>
					<Text>
						<Text dimColor>Specs: </Text>
						{info.dims}d, {info.context} context
					</Text>
					<Text>
						<Text dimColor>Cost: </Text>
						{info.cost}
						{info.note ? <Text dimColor> ({info.note})</Text> : null}
					</Text>
					<Text>
						<Text dimColor>Directory:</Text> .viberag/
					</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={CONFIRM_ITEMS}
						onSelect={item => {
							if (item.value === 'init') {
								onComplete({provider});
							} else {
								onCancel();
							}
						}}
					/>
				</Box>
				<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
			</Box>
		);
	}

	// Fallback (shouldn't happen)
	return (
		<Box flexDirection="column">
			<Text color="red">Unknown wizard step</Text>
			<Text dimColor>
				Debug: step={step} ({typeof step}), isReinit={String(isReinit)} (
				{typeof isReinit}), effectiveStep={effectiveStep}
			</Text>
		</Box>
	);
}

export default InitWizard;
