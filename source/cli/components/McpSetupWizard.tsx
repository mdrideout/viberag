/**
 * MCP Setup Wizard Component
 *
 * Single-editor wizard for configuring VibeRAG's MCP server
 * with scope selection (global vs project).
 */

import React, {useState, useCallback, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import SelectInput from 'ink-select-input';
import {
	EDITORS,
	type EditorId,
	needsScopeSelection,
	isGlobalManualOnly,
	getConfigPath,
} from '../data/mcp-editors.js';
import {
	writeMcpConfig,
	getManualInstructions,
	getConfiguredScopes,
	addToGitignore,
	type McpSetupResult,
} from '../commands/mcp-setup.js';

/**
 * Wizard step types.
 */
export type McpSetupStep =
	| 'prompt' // Post-init prompt (Yes/Skip)
	| 'select' // Single-select editor
	| 'scope' // Global vs Project selection
	| 'configure' // Configuration action
	| 'summary'; // Final summary

/**
 * Wizard configuration.
 */
export interface McpSetupWizardConfig {
	selectedEditor: EditorId | null;
	selectedScope: 'global' | 'project' | null;
	result: McpSetupResult | null;
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
	// Track which editors are already configured (at any scope)
	const [configuredEditors, setConfiguredEditors] = useState<
		Map<EditorId, {global: boolean; project: boolean}>
	>(new Map());

	// Processing state
	const [isProcessing, setIsProcessing] = useState(false);

	// Gitignore prompt state (for project scope)
	const [gitignoreHandled, setGitignoreHandled] = useState(false);
	const [gitignoreAdded, setGitignoreAdded] = useState<string | null>(null);

	// Check which editors are already configured at each scope
	useEffect(() => {
		const checkConfigured = async () => {
			const configured = new Map<
				EditorId,
				{global: boolean; project: boolean}
			>();
			for (const editor of EDITORS) {
				const scopes = await getConfiguredScopes(editor, projectRoot);
				configured.set(editor.id, scopes);
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

	// Get current editor
	const currentEditor = config.selectedEditor
		? EDITORS.find(e => e.id === config.selectedEditor)
		: null;

	// Handle editor action
	const handleEditorAction = useCallback(
		async (action: 'auto' | 'manual' | 'skip') => {
			if (!currentEditor || !config.selectedScope) return;
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
				const instructions = getManualInstructions(
					currentEditor,
					config.selectedScope,
					projectRoot,
				);
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
				result = await writeMcpConfig(
					currentEditor,
					config.selectedScope,
					projectRoot,
				);
			}

			onStepChange('summary', {result});
			setIsProcessing(false);
		},
		[currentEditor, config.selectedScope, projectRoot, onStepChange, addOutput],
	);

	// Handle gitignore action (for project scope)
	const handleGitignore = useCallback(
		async (action: 'yes' | 'no') => {
			if (action === 'yes' && config.result?.configPath) {
				// Extract relative path for gitignore
				const relativePath = config.result.configPath.startsWith(projectRoot)
					? config.result.configPath.slice(projectRoot.length + 1)
					: config.result.configPath;

				const success = await addToGitignore(projectRoot, relativePath);
				if (success) {
					setGitignoreAdded(relativePath);
				}
			}
			setGitignoreHandled(true);
		},
		[config.result, projectRoot],
	);

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

	// Step: Single-select editor
	if (step === 'select') {
		// Build editor items with configuration status
		const editorItems = EDITORS.map(editor => {
			const scopes = configuredEditors.get(editor.id);
			const isConfiguredAnywhere = scopes?.global || scopes?.project;

			let label = editor.name;
			if (isConfiguredAnywhere) {
				const configuredAt = [];
				if (scopes?.global) configuredAt.push('global');
				if (scopes?.project) configuredAt.push('project');
				label += ` (configured: ${configuredAt.join(', ')})`;
			}

			return {
				label,
				value: editor.id,
			};
		});

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>MCP Setup Wizard</Text>
				<Box marginTop={1}>
					<Text>Select an AI coding tool to configure:</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={editorItems}
						onSelect={item => {
							const editor = EDITORS.find(e => e.id === item.value);
							if (!editor) return;

							if (needsScopeSelection(editor)) {
								// Editor supports both scopes - let user choose
								onStepChange('scope', {selectedEditor: item.value});
							} else if (editor.defaultScope === 'ui') {
								// UI-only editor (JetBrains) - skip to configure
								onStepChange('configure', {
									selectedEditor: item.value,
									selectedScope: null,
								});
							} else {
								// Single scope - use default
								onStepChange('configure', {
									selectedEditor: item.value,
									selectedScope: editor.supportsGlobal ? 'global' : 'project',
								});
							}
						}}
					/>
				</Box>
				<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
				<Box marginTop={1}>
					<Text dimColor>
						Manual setup:
						https://github.com/mdrideout/viberag?tab=readme-ov-file#manual-setup-instructions
					</Text>
				</Box>
			</Box>
		);
	}

	// Step: Scope selection (global vs project)
	if (step === 'scope' && currentEditor) {
		const scopes = configuredEditors.get(currentEditor.id);

		// Build scope items
		const scopeItems: SelectItem<'global' | 'project'>[] = [];

		if (currentEditor.supportsGlobal && currentEditor.defaultScope !== 'ui') {
			const isConfigured = scopes?.global;

			scopeItems.push({
				label: `Global (Recommended)${isConfigured ? ' - already configured' : ''}`,
				value: 'global',
			});
		}

		if (currentEditor.supportsProject) {
			const isConfigured = scopes?.project;
			scopeItems.push({
				label: `This project only${isConfigured ? ' - already configured' : ''}`,
				value: 'project',
			});
		}

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>{currentEditor.name} - Choose Scope</Text>
				<Box marginTop={1} flexDirection="column">
					<Text>
						<Text color="cyan">Global:</Text> Works across all projects
						(one-time setup)
					</Text>
					<Text>
						<Text color="cyan">Project:</Text> Only for this project
						(per-project setup)
					</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={scopeItems}
						onSelect={item => {
							onStepChange('configure', {selectedScope: item.value});
						}}
					/>
				</Box>
				<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
			</Box>
		);
	}

	// Step: Configure editor
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

		const scope = config.selectedScope;

		// Determine config path based on scope
		const configPath = scope
			? getConfigPath(currentEditor, scope, projectRoot)
			: null;

		// Determine if this is a manual-only configuration
		const isUiOnly = currentEditor.defaultScope === 'ui'; // JetBrains
		const isManualOnlyGlobal =
			scope === 'global' && isGlobalManualOnly(currentEditor); // VS Code, Roo Code

		// Choose action items based on config type
		type ActionValue = 'auto' | 'manual' | 'skip';
		let actionItems: SelectItem<ActionValue>[];
		if (isUiOnly || isManualOnlyGlobal) {
			actionItems = [
				{label: 'Show setup instructions', value: 'manual'},
				{label: 'Skip', value: 'skip'},
			];
		} else {
			actionItems = [
				{label: 'Auto-configure (Recommended)', value: 'auto'},
				{label: 'Show manual instructions', value: 'manual'},
				{label: 'Skip', value: 'skip'},
			];
		}

		// Determine display text
		let configDescription: string;
		if (isUiOnly) {
			configDescription = `${currentEditor.name} requires manual configuration in IDE settings.`;
		} else if (isManualOnlyGlobal) {
			configDescription =
				currentEditor.globalUiInstructions ??
				'Manual global configuration required.';
		} else if (configPath) {
			configDescription = `Configure ${scope === 'global' ? 'globally' : 'for this project'} at:\n${configPath}`;
		} else {
			configDescription = 'Configuration path not available.';
		}

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold>{currentEditor.name} MCP Setup</Text>
				<Box marginTop={1}>
					<Text>{configDescription}</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={actionItems}
						onSelect={item => {
							handleEditorAction(item.value);
						}}
					/>
				</Box>
				<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
			</Box>
		);
	}

	// Step: Summary
	if (step === 'summary' && config.result) {
		const result = config.result;
		const editor = EDITORS.find(e => e.id === result.editor);
		const scope = config.selectedScope;

		// Check if we need to show gitignore prompt (project scope only)
		const isProjectScope = scope === 'project';
		const needsGitignorePrompt =
			isProjectScope &&
			result.success &&
			(result.method === 'file-created' || result.method === 'file-merged') &&
			!gitignoreHandled;

		if (needsGitignorePrompt) {
			return (
				<Box
					flexDirection="column"
					borderStyle="round"
					paddingX={2}
					paddingY={1}
				>
					<Text bold color="yellow">
						Add MCP config to .gitignore?
					</Text>
					<Box marginTop={1} flexDirection="column">
						<Text>Project-local MCP config file was created:</Text>
						<Text dimColor> {result.configPath}</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>
							MCP configs are typically machine-specific and should not be
							committed.
						</Text>
					</Box>
					<Box marginTop={1}>
						<SelectInput
							items={[
								{label: 'Yes, add to .gitignore (Recommended)', value: 'yes'},
								{label: 'No, keep in version control', value: 'no'},
							]}
							onSelect={item => handleGitignore(item.value as 'yes' | 'no')}
						/>
					</Box>
				</Box>
			);
		}

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="green">
					MCP Setup Complete
				</Text>
				<Box marginTop={1} flexDirection="column">
					{result.success ? (
						result.method === 'instructions-shown' ? (
							<Text>
								<Text color="blue">ℹ</Text> {editor?.name ?? result.editor}
								<Text dimColor> Instructions shown above</Text>
							</Text>
						) : (
							<Text>
								<Text color="green">✓</Text> {editor?.name ?? result.editor}
								<Text dimColor>
									{' '}
									{result.method === 'file-created'
										? `Created ${result.configPath}`
										: `Updated ${result.configPath}`}
								</Text>
							</Text>
						)
					) : (
						<Text>
							<Text color="gray">-</Text> {editor?.name ?? result.editor}
							<Text dimColor> {result.error ?? 'Skipped'}</Text>
						</Text>
					)}
				</Box>
				{gitignoreAdded && (
					<Box marginTop={1}>
						<Text color="green">✓</Text>
						<Text dimColor> Added to .gitignore: {gitignoreAdded}</Text>
					</Box>
				)}
				{result.success && result.method !== 'instructions-shown' && editor && (
					<Box marginTop={1} flexDirection="column">
						<Text bold>Verify setup:</Text>
						<Text>
							<Text color="cyan">{editor.name}:</Text>{' '}
							{editor.verificationSteps[0]}
						</Text>
					</Box>
				)}
				{result.success && result.method !== 'instructions-shown' && (
					<Box marginTop={1} flexDirection="column">
						<Text bold>Next steps:</Text>
						<Text>1. Restart your editor to load the MCP server</Text>
						<Text>
							2. Enable the MCP server in your editor if required
						</Text>
						<Text>3. Verify using the steps above</Text>
						<Text>4. Test codebase_search with a code query</Text>
					</Box>
				)}
				{result.success &&
					result.method !== 'instructions-shown' &&
					editor?.postSetupInstructions &&
					editor.postSetupInstructions.length > 0 && (
						<Box marginTop={1} flexDirection="column">
							<Text bold color="yellow">
								Required for {editor.name}:
							</Text>
							{editor.postSetupInstructions.map((instruction, i) => (
								<Text key={i} dimColor>
									• {instruction}
								</Text>
							))}
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
								selectedEditor: config.selectedEditor ?? null,
								selectedScope: config.selectedScope ?? null,
								result: config.result ?? null,
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
