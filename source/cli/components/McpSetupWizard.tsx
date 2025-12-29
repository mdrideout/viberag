/**
 * MCP Setup Wizard Component
 *
 * Multi-step wizard for configuring VibeRAG's MCP server
 * across various AI coding tools.
 */

import React, {useState, useCallback, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import SelectInput from 'ink-select-input';
import {EDITORS, type EditorId} from '../data/mcp-editors.js';
import {
	writeMcpConfig,
	getManualInstructions,
	isAlreadyConfigured,
	type McpSetupResult,
} from '../commands/mcp-setup.js';

/**
 * Wizard step types.
 */
export type McpSetupStep =
	| 'prompt' // Post-init prompt (Yes/Skip)
	| 'select' // Multi-select editors
	| 'configure' // Per-editor configuration
	| 'summary'; // Final summary

/**
 * Wizard configuration.
 */
export interface McpSetupWizardConfig {
	selectedEditors: EditorId[];
	results: McpSetupResult[];
}

type Props = {
	step: McpSetupStep;
	config: Partial<McpSetupWizardConfig>;
	projectRoot: string;
	/** Whether this is shown after /init (shows prompt step) */
	showPrompt: boolean;
	onStepChange: (
		step: McpSetupStep,
		data?: Partial<McpSetupWizardConfig>,
	) => void;
	onComplete: (config: McpSetupWizardConfig) => void;
	onCancel: () => void;
	/** For outputting instructions to console */
	addOutput?: (type: 'system' | 'user', content: string) => void;
};

type SelectItem<T> = {
	label: string;
	value: T;
};

/**
 * Prompt items for post-init flow.
 */
const PROMPT_ITEMS: SelectItem<'yes' | 'skip'>[] = [
	{label: 'Yes, configure now', value: 'yes'},
	{label: 'Skip (run /mcp-setup later)', value: 'skip'},
];

/**
 * Action items for each editor.
 */
const PROJECT_ACTION_ITEMS: SelectItem<'auto' | 'manual' | 'skip'>[] = [
	{label: 'Create config file (Recommended)', value: 'auto'},
	{label: 'Show manual instructions', value: 'manual'},
	{label: 'Skip this editor', value: 'skip'},
];

const GLOBAL_ACTION_ITEMS: SelectItem<'auto' | 'manual' | 'skip'>[] = [
	{label: 'Auto-merge into config (shows diff first)', value: 'auto'},
	{label: 'Show config to copy manually', value: 'manual'},
	{label: 'Skip this editor', value: 'skip'},
];

const UI_ACTION_ITEMS: SelectItem<'manual' | 'skip'>[] = [
	{label: 'Show setup instructions', value: 'manual'},
	{label: 'Skip this editor', value: 'skip'},
];

/**
 * Multi-select checkbox list component.
 */
function MultiSelect({
	items,
	selected,
	onToggle,
	onSubmit,
	highlightIndex,
	onHighlightChange,
	disabledItems,
}: {
	items: {id: EditorId; label: string; description: string}[];
	selected: Set<EditorId>;
	onToggle: (id: EditorId) => void;
	onSubmit: () => void;
	highlightIndex: number;
	onHighlightChange: (index: number) => void;
	disabledItems?: Set<EditorId>;
}): React.ReactElement {
	useInput((input, key) => {
		if (key.upArrow) {
			onHighlightChange(Math.max(0, highlightIndex - 1));
		} else if (key.downArrow) {
			onHighlightChange(Math.min(items.length - 1, highlightIndex + 1));
		} else if (input === ' ') {
			const item = items[highlightIndex];
			if (item && !disabledItems?.has(item.id)) {
				onToggle(item.id);
			}
		} else if (key.return) {
			onSubmit();
		}
	});

	return (
		<Box flexDirection="column">
			{items.map((item, index) => {
				const isSelected = selected.has(item.id);
				const isHighlighted = index === highlightIndex;
				const isDisabled = disabledItems?.has(item.id);
				const checkbox = isSelected ? '[x]' : '[ ]';

				return (
					<Box key={item.id}>
						<Text
							color={isDisabled ? 'gray' : isHighlighted ? 'cyan' : undefined}
							bold={isHighlighted}
							dimColor={isDisabled}
						>
							{isHighlighted ? '> ' : '  '}
							{checkbox} {item.label}
							<Text dimColor> ({item.description})</Text>
							{isDisabled ? (
								<Text color="yellow"> (already configured)</Text>
							) : null}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

/**
 * MCP Setup Wizard main component.
 */
export function McpSetupWizard({
	step,
	config,
	projectRoot,
	showPrompt,
	onStepChange,
	onComplete,
	onCancel,
	addOutput,
}: Props): React.ReactElement {
	// Multi-select state
	const [selected, setSelected] = useState<Set<EditorId>>(
		new Set(config.selectedEditors ?? []),
	);
	const [highlightIndex, setHighlightIndex] = useState(0);
	const [configuredEditors, setConfiguredEditors] = useState<Set<EditorId>>(
		new Set(),
	);

	// Per-editor configuration state
	const [currentEditorIndex, setCurrentEditorIndex] = useState(0);
	const [results, setResults] = useState<McpSetupResult[]>(
		config.results ?? [],
	);
	const [isProcessing, setIsProcessing] = useState(false);

	// Check which editors are already configured
	useEffect(() => {
		const checkConfigured = async () => {
			const configured = new Set<EditorId>();
			for (const editor of EDITORS) {
				const isConfigured = await isAlreadyConfigured(editor, projectRoot);
				if (isConfigured) {
					configured.add(editor.id);
				}
			}
			setConfiguredEditors(configured);
		};
		checkConfigured();
	}, [projectRoot]);

	// Handle Escape to cancel
	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			onCancel();
		}
	});

	// Toggle selection
	const handleToggle = useCallback((id: EditorId) => {
		setSelected(prev => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	// Submit selection
	const handleSubmitSelection = useCallback(() => {
		if (selected.size === 0) {
			onCancel();
			return;
		}
		onStepChange('configure', {selectedEditors: Array.from(selected)});
		setCurrentEditorIndex(0);
	}, [selected, onStepChange, onCancel]);

	// Get current editor being configured
	const selectedEditorIds = config.selectedEditors ?? [];
	const currentEditorId = selectedEditorIds[currentEditorIndex];
	const currentEditor = EDITORS.find(e => e.id === currentEditorId);

	// Handle editor action
	const handleEditorAction = useCallback(
		async (action: 'auto' | 'manual' | 'skip') => {
			if (!currentEditor) return;
			setIsProcessing(true);

			let result: McpSetupResult;

			if (action === 'skip') {
				result = {
					success: false,
					editor: currentEditor.id,
					method: 'instructions-shown',
					error: 'Skipped',
				};
			} else if (action === 'manual') {
				// Show manual instructions
				const instructions = getManualInstructions(currentEditor, projectRoot);
				if (addOutput) {
					addOutput('system', instructions);
				}
				result = {
					success: true,
					editor: currentEditor.id,
					method: 'instructions-shown',
				};
			} else {
				// Auto setup
				result = await writeMcpConfig(currentEditor, projectRoot);
			}

			const newResults = [...results, result];
			setResults(newResults);

			// Move to next editor or summary
			if (currentEditorIndex < selectedEditorIds.length - 1) {
				setCurrentEditorIndex(currentEditorIndex + 1);
			} else {
				onStepChange('summary', {results: newResults});
			}
			setIsProcessing(false);
		},
		[
			currentEditor,
			projectRoot,
			results,
			currentEditorIndex,
			selectedEditorIds.length,
			onStepChange,
			addOutput,
		],
	);

	// Build editor items for multi-select
	const editorItems = EDITORS.map(editor => ({
		id: editor.id,
		label: editor.name,
		description: editor.description,
	}));

	// Step: Prompt (post-init)
	if (step === 'prompt' && showPrompt) {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="green">
					Setup Complete
				</Text>
				<Box marginTop={1}>
					<Text>
						Would you like to configure an AI coding tool to use{'\n'}
						VibeRAG's MCP server?
					</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={PROMPT_ITEMS}
						onSelect={item => {
							if (item.value === 'yes') {
								onStepChange('select');
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

	// Step: Multi-select editors
	if (step === 'select') {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>MCP Setup Wizard</Text>
				<Box marginTop={1}>
					<Text>
						Select AI coding tool(s) to configure:{'\n'}
						<Text dimColor>(Space to toggle, Enter to confirm)</Text>
					</Text>
				</Box>
				<Box marginTop={1}>
					<MultiSelect
						items={editorItems}
						selected={selected}
						onToggle={handleToggle}
						onSubmit={handleSubmitSelection}
						highlightIndex={highlightIndex}
						onHighlightChange={setHighlightIndex}
						disabledItems={configuredEditors}
					/>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>
						{selected.size} selected | ↑/↓ move, Space toggle, Enter confirm,
						Esc cancel
					</Text>
				</Box>
			</Box>
		);
	}

	// Step: Configure each editor
	if (step === 'configure' && currentEditor) {
		if (isProcessing) {
			return (
				<Box
					flexDirection="column"
					borderStyle="round"
					paddingX={2}
					paddingY={1}
				>
					<Text bold>{currentEditor.name} MCP Setup</Text>
					<Box marginTop={1}>
						<Text color="yellow">Processing...</Text>
					</Box>
				</Box>
			);
		}

		const actionItems =
			currentEditor.scope === 'ui'
				? UI_ACTION_ITEMS
				: currentEditor.scope === 'global'
					? GLOBAL_ACTION_ITEMS
					: PROJECT_ACTION_ITEMS;

		const configPathDisplay =
			currentEditor.scope === 'project'
				? currentEditor.configPath
				: currentEditor.scope === 'global'
					? `${currentEditor.configPath}`
					: 'IDE Settings';

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>
					{currentEditor.name} MCP Setup ({currentEditorIndex + 1}/
					{selectedEditorIds.length})
				</Text>
				<Box marginTop={1} flexDirection="column">
					{currentEditor.scope === 'project' ? (
						<Text>
							VibeRAG can create <Text color="cyan">{configPathDisplay}</Text>{' '}
							automatically.
						</Text>
					) : currentEditor.scope === 'global' ? (
						<Text>
							{currentEditor.name} uses a global config at:{'\n'}
							<Text color="cyan">{configPathDisplay}</Text>
						</Text>
					) : (
						<Text>
							{currentEditor.name} requires manual configuration in the IDE.
						</Text>
					)}
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={actionItems}
						onSelect={item => {
							handleEditorAction(item.value as 'auto' | 'manual' | 'skip');
						}}
					/>
				</Box>
				<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
			</Box>
		);
	}

	// Step: Summary
	if (step === 'summary') {
		const successResults = results.filter(
			r => r.success && r.method !== 'instructions-shown',
		);
		const instructionResults = results.filter(
			r => r.success && r.method === 'instructions-shown',
		);
		const skippedResults = results.filter(r => !r.success);

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="green">
					MCP Setup Complete
				</Text>
				<Box marginTop={1} flexDirection="column">
					{successResults.map(r => {
						const editor = EDITORS.find(e => e.id === r.editor);
						return (
							<Text key={r.editor}>
								<Text color="green">✓</Text> {editor?.name ?? r.editor}
								<Text dimColor>
									{' '}
									{r.method === 'file-created'
										? `Created ${r.configPath}`
										: r.method === 'file-merged'
											? `Updated ${r.configPath}`
											: 'CLI command'}
								</Text>
							</Text>
						);
					})}
					{instructionResults.map(r => {
						const editor = EDITORS.find(e => e.id === r.editor);
						return (
							<Text key={r.editor}>
								<Text color="blue">ℹ</Text> {editor?.name ?? r.editor}
								<Text dimColor> Instructions shown above</Text>
							</Text>
						);
					})}
					{skippedResults.map(r => {
						const editor = EDITORS.find(e => e.id === r.editor);
						return (
							<Text key={r.editor}>
								<Text color="gray">-</Text> {editor?.name ?? r.editor}
								<Text dimColor> Skipped</Text>
							</Text>
						);
					})}
				</Box>
				{successResults.length > 0 && (
					<Box marginTop={1} flexDirection="column">
						<Text bold>Next steps:</Text>
						<Text>1. Restart your editor(s) to load the MCP server</Text>
						<Text>2. Test with a semantic search query</Text>
					</Box>
				)}
				<Box marginTop={1}>
					<Text dimColor>
						Run /mcp-setup anytime to configure more editors.
					</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={[{label: 'Done', value: 'done'}]}
						onSelect={() => {
							onComplete({
								selectedEditors: selectedEditorIds,
								results,
							});
						}}
					/>
				</Box>
			</Box>
		);
	}

	// Fallback
	return (
		<Box flexDirection="column">
			<Text color="red">Unknown wizard step: {step}</Text>
		</Box>
	);
}

export default McpSetupWizard;
