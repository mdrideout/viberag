/**
 * Clean Wizard Component
 *
 * Interactive wizard for cleaning up VibeRAG from a project,
 * including MCP server configurations.
 */

import React, {useState, useEffect, useCallback} from 'react';
import {Box, Text, useInput} from 'ink';
import SelectInput from 'ink-select-input';
import {EDITORS, type EditorConfig} from '../data/mcp-editors.js';
import {
	findConfiguredEditors,
	removeViberagConfig,
	type McpRemovalResult,
} from '../commands/mcp-setup.js';

type CleanStep = 'confirm' | 'mcp-cleanup' | 'processing' | 'summary';

type Props = {
	projectRoot: string;
	viberagDir: string;
	onComplete: () => void;
	onCancel: () => void;
	/** For outputting status messages */
	addOutput: (type: 'system' | 'user', content: string) => void;
};

type SelectItem<T> = {
	label: string;
	value: T;
};

const CONFIRM_ITEMS: SelectItem<'continue' | 'cancel'>[] = [
	{label: 'Yes, remove everything', value: 'continue'},
	{label: 'Cancel', value: 'cancel'},
];

const MCP_CLEANUP_ITEMS: SelectItem<'yes' | 'no'>[] = [
	{label: 'Yes, remove from MCP configs too (Recommended)', value: 'yes'},
	{label: 'No, keep MCP configurations', value: 'no'},
];

export function CleanWizard({
	projectRoot,
	viberagDir,
	onComplete,
	onCancel,
	addOutput,
}: Props): React.ReactElement {
	const [step, setStep] = useState<CleanStep>('confirm');
	const [projectScopeEditors, setProjectScopeEditors] = useState<
		EditorConfig[]
	>([]);
	const [globalScopeEditors, setGlobalScopeEditors] = useState<EditorConfig[]>(
		[],
	);
	const [mcpResults, setMcpResults] = useState<McpRemovalResult[]>([]);
	const [viberagRemoved, setViberagRemoved] = useState(false);

	// Handle Escape to cancel
	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			onCancel();
		}
	});

	// Find configured editors on mount
	useEffect(() => {
		findConfiguredEditors(projectRoot).then(({projectScope, globalScope}) => {
			setProjectScopeEditors(projectScope);
			setGlobalScopeEditors(globalScope);
		});
	}, [projectRoot]);

	// Handle confirmation
	const handleConfirm = useCallback(
		(action: 'continue' | 'cancel') => {
			if (action === 'cancel') {
				onCancel();
				return;
			}

			// If there are project-scope MCP configs, ask about cleanup
			if (projectScopeEditors.length > 0) {
				setStep('mcp-cleanup');
			} else {
				// No MCP configs to clean, go straight to processing
				setStep('processing');
				performCleanup(false);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps -- performCleanup is stable
		[projectScopeEditors, onCancel],
	);

	// Perform the actual cleanup
	const performCleanup = useCallback(
		async (cleanMcp: boolean) => {
			const fs = await import('node:fs/promises');

			// Remove .viberag directory
			try {
				await fs.rm(viberagDir, {recursive: true, force: true});
				setViberagRemoved(true);
			} catch (error) {
				addOutput(
					'system',
					`Failed to remove ${viberagDir}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			// Clean MCP configs if requested
			if (cleanMcp) {
				const results: McpRemovalResult[] = [];
				for (const editor of projectScopeEditors) {
					const result = await removeViberagConfig(editor, projectRoot);
					results.push(result);
				}
				setMcpResults(results);
			}

			setStep('summary');
		},
		[viberagDir, projectScopeEditors, projectRoot, addOutput],
	);

	// Handle MCP cleanup choice
	const handleMcpCleanup = useCallback(
		(action: 'yes' | 'no') => {
			setStep('processing');
			performCleanup(action === 'yes');
		},
		[performCleanup],
	);

	// Step: Confirm
	if (step === 'confirm') {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="yellow">
					Clean VibeRAG
				</Text>
				<Box marginTop={1} flexDirection="column">
					<Text>This will remove:</Text>
					<Text dimColor> • {viberagDir}/ (index and config)</Text>
					{projectScopeEditors.length > 0 && (
						<Text dimColor>
							{' '}
							• MCP configs ({projectScopeEditors.map(e => e.name).join(', ')})
						</Text>
					)}
				</Box>
				{globalScopeEditors.length > 0 && (
					<Box marginTop={1}>
						<Text color="blue">
							Note: Global MCP configs (
							{globalScopeEditors.map(e => e.name).join(', ')}){'\n'}will NOT be
							modified. Remove manually if needed.
						</Text>
					</Box>
				)}
				<Box marginTop={1}>
					<SelectInput
						items={CONFIRM_ITEMS}
						onSelect={item => handleConfirm(item.value)}
					/>
				</Box>
				<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
			</Box>
		);
	}

	// Step: MCP Cleanup choice
	if (step === 'mcp-cleanup') {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="yellow">
					Remove from MCP configs?
				</Text>
				<Box marginTop={1} flexDirection="column">
					<Text>Found viberag in these project MCP configs:</Text>
					{projectScopeEditors.map(editor => (
						<Text key={editor.id} dimColor>
							{' '}
							• {editor.name} ({editor.configPath})
						</Text>
					))}
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={MCP_CLEANUP_ITEMS}
						onSelect={item => handleMcpCleanup(item.value)}
					/>
				</Box>
				<Text dimColor>↑/↓ navigate, Enter select, Esc cancel</Text>
			</Box>
		);
	}

	// Step: Processing
	if (step === 'processing') {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="yellow">
					Cleaning...
				</Text>
				<Box marginTop={1}>
					<Text>Removing VibeRAG from project...</Text>
				</Box>
			</Box>
		);
	}

	// Step: Summary
	if (step === 'summary') {
		const successfulRemovals = mcpResults.filter(r => r.success);

		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="green">
					Clean Complete
				</Text>
				<Box marginTop={1} flexDirection="column">
					{viberagRemoved && (
						<Text>
							<Text color="green">✓</Text> Removed {viberagDir}/
						</Text>
					)}
					{successfulRemovals.map(r => {
						const editor = EDITORS.find(e => e.id === r.editor);
						return (
							<Text key={r.editor}>
								<Text color="green">✓</Text> {editor?.name ?? r.editor}
								<Text dimColor> Updated {r.configPath}</Text>
							</Text>
						);
					})}
				</Box>
				{globalScopeEditors.length > 0 && (
					<Box marginTop={1} flexDirection="column">
						<Text bold color="blue">
							Manual cleanup needed:
						</Text>
						{globalScopeEditors.map(editor => (
							<Text key={editor.id} dimColor>
								• {editor.name}: Remove "viberag" from {editor.configPath}
							</Text>
						))}
					</Box>
				)}
				<Box marginTop={1}>
					<Text dimColor>Run /init to reinitialize VibeRAG.</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={[{label: 'Done', value: 'done'}]}
						onSelect={() => onComplete()}
					/>
				</Box>
			</Box>
		);
	}

	// Fallback
	return (
		<Box flexDirection="column">
			<Text color="red">Unknown wizard step</Text>
		</Box>
	);
}

export default CleanWizard;
