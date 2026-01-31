/**
 * Clean Wizard Component
 *
 * Interactive wizard for cleaning up VibeRAG from a project,
 * including MCP server configurations.
 */

import React, {useState, useEffect, useCallback} from 'react';
import {Box, Text, useInput} from 'ink';
import SelectInput from 'ink-select-input';
import {DaemonClient} from '../../client/index.js';
import {EDITORS, getConfigPath} from '../data/mcp-editors.js';
import {
	findConfiguredEditors,
	removeViberagConfig,
	type McpRemovalResult,
	type ConfiguredEditorInfo,
} from '../commands/mcp-setup.js';
import {getRunDir} from '../../daemon/lib/constants.js';

type CleanStep =
	| 'confirm'
	| 'mcp-cleanup'
	| 'global-cleanup'
	| 'processing'
	| 'summary';

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

const GLOBAL_CLEANUP_ITEMS: SelectItem<'yes' | 'no'>[] = [
	{label: 'Yes, remove from global configs too', value: 'yes'},
	{label: 'No, keep global configurations (Recommended)', value: 'no'},
];

export function CleanWizard({
	projectRoot,
	viberagDir,
	onComplete,
	onCancel,
	addOutput,
}: Props): React.ReactElement {
	const [step, setStep] = useState<CleanStep>('confirm');
	const [projectScopeConfigs, setProjectScopeConfigs] = useState<
		ConfiguredEditorInfo[]
	>([]);
	const [globalScopeConfigs, setGlobalScopeConfigs] = useState<
		ConfiguredEditorInfo[]
	>([]);
	const [mcpResults, setMcpResults] = useState<McpRemovalResult[]>([]);
	const [viberagRemoved, setViberagRemoved] = useState(false);
	const [cleanProjectMcp, setCleanProjectMcp] = useState(false);
	const [cleanedGlobalConfigs, setCleanedGlobalConfigs] = useState(false);

	// Handle Escape to cancel
	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			onCancel();
		}
	});

	// Find configured editors on mount
	useEffect(() => {
		findConfiguredEditors(projectRoot).then(({projectScope, globalScope}) => {
			setProjectScopeConfigs(projectScope);
			setGlobalScopeConfigs(globalScope);
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
			if (projectScopeConfigs.length > 0) {
				setStep('mcp-cleanup');
			} else if (globalScopeConfigs.length > 0) {
				// No project configs but have global configs
				setStep('global-cleanup');
			} else {
				// No MCP configs to clean, go straight to processing
				setStep('processing');
				performCleanup(false, false);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps -- performCleanup is stable
		[projectScopeConfigs, globalScopeConfigs, onCancel],
	);

	// Perform the actual cleanup
	const performCleanup = useCallback(
		async (cleanProjectMcpArg: boolean, cleanGlobalMcp: boolean) => {
			const fs = await import('node:fs/promises');

			// Shutdown daemon first (prevents stale DB handles / sockets)
			const client = new DaemonClient({
				projectRoot,
				autoStart: false,
			});
			try {
				if (await client.isRunning()) {
					await client.connect();
					await client.shutdown('clean');
					// Give the daemon a moment to exit
					await new Promise(r => setTimeout(r, 500));
				}
			} catch {
				// Ignore errors - daemon may not be running
			} finally {
				await client.disconnect();
			}

			// Remove global per-project data directory
			try {
				await fs.rm(viberagDir, {recursive: true, force: true});
				setViberagRemoved(true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);

				// Check if directory just doesn't exist (not critical)
				const isNotFound =
					error instanceof Error &&
					'code' in error &&
					(error as NodeJS.ErrnoException).code === 'ENOENT';

				if (isNotFound) {
					// Directory doesn't exist - that's fine, consider it removed
					setViberagRemoved(true);
				} else {
					// Critical failure (permission denied, etc.) - stop cleanup
					addOutput('system', `Failed to remove ${viberagDir}: ${message}`);
					addOutput('system', 'Stopping cleanup due to critical failure.');
					setStep('summary');
					return;
				}
			}

			// Remove runtime files (socket/pid/lock)
			try {
				await fs.rm(getRunDir(projectRoot), {recursive: true, force: true});
			} catch {
				// Ignore
			}

			const results: McpRemovalResult[] = [];

			// Clean project MCP configs if requested
			if (cleanProjectMcpArg) {
				for (const {editor, scope} of projectScopeConfigs) {
					const result = await removeViberagConfig(editor, scope, projectRoot);
					results.push(result);
				}
			}

			// Clean global MCP configs if requested
			if (cleanGlobalMcp) {
				setCleanedGlobalConfigs(true);
				for (const {editor, scope} of globalScopeConfigs) {
					const result = await removeViberagConfig(editor, scope, projectRoot);
					results.push(result);
				}
			}

			setMcpResults(results);
			setStep('summary');
		},
		[
			viberagDir,
			projectScopeConfigs,
			globalScopeConfigs,
			projectRoot,
			addOutput,
		],
	);

	// Handle MCP cleanup choice
	const handleMcpCleanup = useCallback(
		(action: 'yes' | 'no') => {
			const shouldCleanProject = action === 'yes';
			setCleanProjectMcp(shouldCleanProject);

			// If there are global configs, ask about those next
			if (globalScopeConfigs.length > 0) {
				setStep('global-cleanup');
			} else {
				setStep('processing');
				performCleanup(shouldCleanProject, false);
			}
		},
		[globalScopeConfigs, performCleanup],
	);

	// Handle Global cleanup choice
	const handleGlobalCleanup = useCallback(
		(action: 'yes' | 'no') => {
			setStep('processing');
			performCleanup(cleanProjectMcp, action === 'yes');
		},
		[cleanProjectMcp, performCleanup],
	);

	// Helper to get display path for a configured editor
	const getDisplayPath = (info: ConfiguredEditorInfo): string => {
		const path = getConfigPath(info.editor, info.scope, projectRoot);
		return path ?? info.editor.projectConfigPath ?? 'unknown';
	};

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
					{projectScopeConfigs.length > 0 && (
						<Text dimColor>
							{' '}
							• MCP configs (
							{projectScopeConfigs.map(c => c.editor.name).join(', ')})
						</Text>
					)}
				</Box>
				{globalScopeConfigs.length > 0 && (
					<Box marginTop={1}>
						<Text color="blue">
							Global MCP configs (
							{globalScopeConfigs.map(c => c.editor.name).join(', ')}){'\n'}will
							be addressed in a separate step.
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
					<Text>Found VibeRAG in these project MCP configs:</Text>
					{projectScopeConfigs.map(info => (
						<Text key={`${info.editor.id}-${info.scope}`} dimColor>
							{' '}
							• {info.editor.name} ({getDisplayPath(info)})
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

	// Step: Global Cleanup choice
	if (step === 'global-cleanup') {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text bold color="yellow">
					Remove from Global MCP configs?
				</Text>
				<Box marginTop={1}>
					<Text color="yellow">
						Note: Other projects using this config will need to run /mcp-setup
						again.
					</Text>
				</Box>
				<Box marginTop={1} flexDirection="column">
					<Text>Found VibeRAG in these global configs:</Text>
					{globalScopeConfigs.map(info => (
						<Text key={`${info.editor.id}-${info.scope}`} dimColor>
							{' '}
							• {info.editor.name} ({getDisplayPath(info)})
						</Text>
					))}
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={GLOBAL_CLEANUP_ITEMS}
						onSelect={item => handleGlobalCleanup(item.value)}
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
				{globalScopeConfigs.length > 0 && !cleanedGlobalConfigs && (
					<Box marginTop={1} flexDirection="column">
						<Text bold color="blue">
							Manual cleanup needed:
						</Text>
						{globalScopeConfigs.map(info => (
							<Text key={`${info.editor.id}-${info.scope}`} dimColor>
								• {info.editor.name}: Remove "viberag" from{' '}
								{getDisplayPath(info)}
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
