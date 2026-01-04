/**
 * Multi-step initialization wizard component.
 * Guides users through embedding provider selection and API key configuration.
 */

import React, {useState, useEffect} from 'react';
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
	/** Existing API key from previous config (for reinit flow) */
	existingApiKey?: string;
	/** Existing provider from previous config (for reinit flow) */
	existingProvider?: EmbeddingProviderType;
	onStepChange: (step: number, data?: Partial<InitWizardConfig>) => void;
	onComplete: (config: InitWizardConfig) => void;
	onCancel: () => void;
};

/**
 * Cloud providers that require API keys.
 */
const CLOUD_PROVIDERS = ['gemini', 'mistral', 'openai'] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

function isCloudProvider(
	provider: EmbeddingProviderType,
): provider is CloudProvider {
	return CLOUD_PROVIDERS.includes(provider as CloudProvider);
}

/**
 * URLs to get API keys for each cloud provider.
 */
const API_KEY_URLS: Record<CloudProvider, string> = {
	gemini: 'https://aistudio.google.com',
	mistral: 'https://console.mistral.ai/api-keys/',
	openai: 'https://platform.openai.com/api-keys',
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
		model: 'Qwen3-0.6B Q8',
		modelFull: 'Qwen/Qwen3-Embedding-0.6B',
		dims: '1024',
		context: '32K',
		cost: 'Free',
		note: '~700MB download, ~1.2GB RAM',
		description: 'Offline, no API key needed',
	},
	'local-4b': {
		name: 'Local 4B',
		model: 'Qwen3-4B FP32',
		modelFull: 'Qwen/Qwen3-Embedding-4B',
		dims: '2560',
		context: '32K',
		cost: 'Free',
		note: '~8GB download, ~8GB RAM',
		description: 'Offline, better quality (+5 MTEB)',
	},
	gemini: {
		name: 'Gemini',
		model: 'gemini-embedding-001',
		modelFull: 'gemini-embedding-001',
		dims: '1536',
		context: '2K',
		cost: 'Free tier',
		note: 'API key required',
		description: 'Fast API, free tier available',
	},
	mistral: {
		name: 'Mistral',
		model: 'codestral-embed',
		modelFull: 'codestral-embed',
		dims: '1536',
		context: '8K',
		cost: '$0.10/1M',
		note: 'API key required',
		description: 'Code-optimized embeddings',
	},
	openai: {
		name: 'OpenAI',
		model: 'text-embed-3-sm',
		modelFull: 'text-embedding-3-small',
		dims: '1536',
		context: '8K',
		cost: '$0.02/1M',
		note: 'API key required',
		description: 'Fast and reliable API',
	},
};

// Simple provider options for selection
// Note: local-4b exists in code but hidden from UI - no transformers.js-compatible ONNX available yet
const PROVIDER_ITEMS: SelectItem<EmbeddingProviderType>[] = [
	{label: 'Local     - Qwen3-0.6B Q8 (~700MB, ~1.2GB RAM)', value: 'local'},
	// {label: 'Local 4B  - Qwen3-4B FP32 (~8GB, ~8GB RAM)', value: 'local-4b'}, // No ONNX available
	{label: 'Gemini    - gemini-embedding-001 (Free tier)', value: 'gemini'},
	{label: 'Mistral   - codestral-embed', value: 'mistral'},
	{label: 'OpenAI    - text-embedding-3-small', value: 'openai'},
];

/**
 * Local model info.
 * Note: 4B not shown - no transformers.js-compatible ONNX available yet
 */
const LOCAL_MODELS_DATA = [
	{Model: 'Qwen3-0.6B', Quant: 'Q8', Download: '~700MB', RAM: '~1.2GB'},
];

/**
 * Frontier/API models - fastest, best quality.
 */
const FRONTIER_MODELS_DATA = [
	{
		Provider: 'Gemini',
		Model: 'gemini-embedding-001',
		Dims: '1536',
		Cost: 'Free tier',
	},
	{
		Provider: 'Mistral',
		Model: 'codestral-embed',
		Dims: '1536',
		Cost: '$0.10/1M',
	},
	{
		Provider: 'OpenAI',
		Model: 'text-embed-3-small',
		Dims: '1536',
		Cost: '$0.02/1M',
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
 * Comparison table component showing local and frontier models.
 */
function ComparisonTable(): React.ReactElement {
	const localColumns: TableColumn[] = [
		{key: 'Model', width: 12},
		{key: 'Quant', width: 6},
		{key: 'Download', width: 10},
		{key: 'RAM', width: 8},
	];

	const frontierColumns: TableColumn[] = [
		{key: 'Provider', width: 10},
		{key: 'Model', width: 20},
		{key: 'Dims', width: 6},
		{key: 'Cost', width: 11},
	];

	return (
		<Box flexDirection="column">
			<Box marginTop={1}>
				<Text bold color="yellow">
					Local Models
				</Text>
				<Text dimColor> - Offline, Slower, Free</Text>
			</Box>
			<SimpleTable data={LOCAL_MODELS_DATA} columns={localColumns} />
			<Text dimColor italic>
				* Initial indexing may take time. Future updates are incremental.
			</Text>

			<Box marginTop={1}>
				<Text bold color="green">
					Frontier Models
				</Text>
				<Text dimColor> - Fastest, Best Quality</Text>
			</Box>
			<SimpleTable data={FRONTIER_MODELS_DATA} columns={frontierColumns} />
		</Box>
	);
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

// API key action options for reinit
const API_KEY_ACTION_ITEMS: SelectItem<'keep' | 'new'>[] = [
	{label: 'Keep existing API key', value: 'keep'},
	{label: 'Enter new API key', value: 'new'},
];

/**
 * Simple text input component for API key entry.
 * Uses a ref to accumulate input, which handles paste better than
 * relying on React state updates between rapid useInput calls.
 */
function ApiKeyInputStep({
	providerName,
	apiKeyInput,
	setApiKeyInput,
	onSubmit,
}: {
	providerName: string;
	apiKeyInput: string;
	setApiKeyInput: (value: string) => void;
	onSubmit: (key: string) => void;
}): React.ReactElement {
	// Use a ref to accumulate input - avoids closure stale state issues during rapid paste
	const inputRef = React.useRef(apiKeyInput);
	inputRef.current = apiKeyInput;

	// Handle text input (supports paste)
	useInput((input, key) => {
		if (key.return) {
			onSubmit(inputRef.current);
		} else if (key.backspace || key.delete) {
			setApiKeyInput(inputRef.current.slice(0, -1));
		} else if (!key.ctrl && !key.meta && input) {
			// Add printable characters (supports multi-char paste)
			// Filter out control characters that might slip through
			const printable = input.replace(/[\x00-\x1F\x7F]/g, '');
			if (printable) {
				setApiKeyInput(inputRef.current + printable);
			}
		}
	});

	// Mask API key display (show first 7 and last 4 chars)
	const maskedKey = apiKeyInput.length > 15
		? `${apiKeyInput.slice(0, 7)}${'•'.repeat(Math.min(apiKeyInput.length - 11, 20))}${apiKeyInput.slice(-4)}`
		: apiKeyInput;

	return (
		<Box marginTop={1} flexDirection="column">
			<Text>Enter your {providerName} API key:</Text>
			<Box marginTop={1}>
				<Text color="blue">&gt; </Text>
				<Text>{maskedKey}</Text>
				<Text color="gray">█</Text>
			</Box>
			{apiKeyInput.length > 0 && (
				<Text dimColor>Length: {apiKeyInput.length} characters</Text>
			)}
			{apiKeyInput.trim() === '' && (
				<Text color="yellow" dimColor>
					API key is required
				</Text>
			)}
			<Text dimColor>Press Enter to continue</Text>
		</Box>
	);
}

export function InitWizard({
	step,
	config,
	isReinit,
	existingApiKey,
	existingProvider,
	onStepChange,
	onComplete,
	onCancel,
}: Props): React.ReactElement {
	// State for API key input
	const [apiKeyInput, setApiKeyInput] = useState('');
	const [apiKeyAction, setApiKeyAction] = useState<'keep' | 'new' | null>(null);

	// Handle Escape to cancel
	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			onCancel();
		}
	});

	// Normalize props with defensive defaults
	const normalizedStep = typeof step === 'number' && !isNaN(step) ? step : 0;
	const normalizedIsReinit = typeof isReinit === 'boolean' ? isReinit : false;

	// Check if current provider is a cloud provider
	const currentProvider = config.provider ?? 'local';
	const needsApiKey = isCloudProvider(currentProvider);

	// Compute effective step (adjusted for non-reinit flow)
	// Steps: 0=reinit confirm, 1=provider select, 2=api key (cloud only), 3=final confirm
	const effectiveStep = normalizedIsReinit
		? normalizedStep
		: normalizedStep + 1;

	// Auto-advance past API key step for local providers (must be in useEffect, not render)
	useEffect(() => {
		if (effectiveStep === 2 && !needsApiKey) {
			onStepChange(normalizedStep + 1);
		}
	}, [effectiveStep, needsApiKey, normalizedStep, onStepChange]);

	// Check if we have an existing API key for the same provider
	const hasExistingKeyForProvider =
		existingApiKey && existingProvider === currentProvider;

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
							// Reset API key state when provider changes
							setApiKeyInput('');
							setApiKeyAction(null);
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

	// Step 2: API Key input (cloud providers only)
	// For local providers, skip to step 3 (confirmation) - handled by useEffect above
	if (effectiveStep === 2) {
		// Show loading while useEffect auto-advances for local providers
		if (!needsApiKey) {
			return (
				<Box>
					<Text dimColor>Loading...</Text>
				</Box>
			);
		}

		const provider = currentProvider as CloudProvider;
		const info = PROVIDER_CONFIG[provider];
		const apiKeyUrl = API_KEY_URLS[provider];

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>Configure {info.name} API Key</Text>

				<Box marginTop={1} flexDirection="column">
					<Text>
						Get your API key:{' '}
						<Text color="cyan" underline>
							{apiKeyUrl}
						</Text>
					</Text>
				</Box>

				{/* Show keep/new choice if existing key for same provider */}
				{hasExistingKeyForProvider && apiKeyAction === null ? (
					<Box marginTop={1} flexDirection="column">
						<Text color="green">
							An API key is already configured for {info.name}.
						</Text>
						<Box marginTop={1}>
							<SelectInput
								items={API_KEY_ACTION_ITEMS}
								onSelect={item => {
									if (item.value === 'keep') {
										// Keep existing key, advance to confirmation
										onStepChange(normalizedStep + 1, {apiKey: existingApiKey});
									} else {
										// Show text input for new key
										setApiKeyAction('new');
									}
								}}
							/>
						</Box>
					</Box>
				) : (
					<ApiKeyInputStep
						providerName={info.name}
						apiKeyInput={apiKeyInput}
						setApiKeyInput={setApiKeyInput}
						onSubmit={key => {
							if (key.trim()) {
								onStepChange(normalizedStep + 1, {apiKey: key.trim()});
							}
						}}
					/>
				)}

				<Box marginTop={1}>
					<Text dimColor>Esc to cancel</Text>
				</Box>
			</Box>
		);
	}

	// Step 3: Confirmation
	if (effectiveStep === 3) {
		const provider = config.provider ?? 'gemini';
		const info = PROVIDER_CONFIG[provider];
		const hasApiKey = !!config.apiKey;

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
					</Text>
					{isCloudProvider(provider) && (
						<Text>
							<Text dimColor>API Key: </Text>
							{hasApiKey ? (
								<Text color="green">Configured</Text>
							) : (
								<Text color="red">Missing</Text>
							)}
						</Text>
					)}
					<Text>
						<Text dimColor>Directory:</Text> .viberag/
					</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={CONFIRM_ITEMS}
						onSelect={item => {
							if (item.value === 'init') {
								onComplete({provider, apiKey: config.apiKey});
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
