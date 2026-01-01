import React, {useState, useEffect, useCallback} from 'react';
import {createRequire} from 'node:module';
import {Box, Text, useStdout} from 'ink';

// Common infrastructure
import TextInput from '../common/components/TextInput.js';
import StatusBar from '../common/components/StatusBar.js';
import StaticWithResize from '../common/components/StaticWithResize.js';
import {useCtrlC} from '../common/hooks/useCtrlC.js';
import {useCommandHistory} from '../common/hooks/useCommandHistory.js';
import {useKittyKeyboard} from '../common/hooks/useKittyKeyboard.js';
import type {
	OutputItem,
	AppStatus,
	IndexDisplayStats,
	WizardMode,
	InitWizardConfig,
	McpSetupWizardConfig,
	McpSetupStep,
	CommandInfo,
} from '../common/types.js';

// CLI-specific components and commands
import WelcomeBanner from './components/WelcomeBanner.js';
import SearchResultsDisplay from './components/SearchResultsDisplay.js';
import InitWizard from './components/InitWizard.js';
import McpSetupWizard from './components/McpSetupWizard.js';
import CleanWizard from './components/CleanWizard.js';
import {useRagCommands} from './commands/useRagCommands.js';
import {
	checkInitialized,
	loadIndexStats,
	runInit,
	runIndex,
	formatIndexStats,
} from './commands/handlers.js';
import {getViberagDir} from '../rag/constants.js';
import type {SearchResultsData} from '../common/types.js';

const require = createRequire(import.meta.url);
// Path is relative from dist/ after compilation
const {version} = require('../../package.json') as {version: string};

// Available slash commands for autocomplete with descriptions
const COMMANDS: CommandInfo[] = [
	{command: '/help', description: 'Show available commands'},
	{command: '/clear', description: 'Clear the screen'},
	{command: '/terminal-setup', description: 'Configure Shift+Enter for VS Code'},
	{command: '/init', description: 'Initialize Viberag (provider wizard)'},
	{command: '/index', description: 'Index the codebase'},
	{command: '/reindex', description: 'Force full reindex'},
	{command: '/search', description: 'Search codebase semantically'},
	{command: '/status', description: 'Show index statistics'},
	{command: '/mcp-setup', description: 'Configure MCP for AI tools'},
	{command: '/clean', description: 'Remove Viberag from project'},
	{command: '/quit', description: 'Exit the application'},
];

// Module-level counter for unique IDs
let nextId = 0;

export default function App() {
	const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
	const [appStatus, setAppStatus] = useState<AppStatus>({state: 'ready'});
	// undefined = not loaded yet, null = loaded but no manifest, {...} = loaded with stats
	const [indexStats, setIndexStats] = useState<
		IndexDisplayStats | null | undefined
	>(undefined);
	const [isInitialized, setIsInitialized] = useState<boolean | undefined>(
		undefined,
	);
	const [wizardMode, setWizardMode] = useState<WizardMode>({active: false});
	const {stdout} = useStdout();

	// Enable Kitty keyboard protocol for Shift+Enter support in iTerm2/Kitty/WezTerm
	useKittyKeyboard();

	// Get project root (current working directory)
	const projectRoot = process.cwd();

	// Check initialization status and load stats on mount
	useEffect(() => {
		checkInitialized(projectRoot).then(setIsInitialized);
		loadIndexStats(projectRoot).then(setIndexStats);
	}, [projectRoot]);

	// Command history
	const {addToHistory, navigateUp, navigateDown, resetIndex} =
		useCommandHistory();

	const addOutput = (type: 'user' | 'system', content: string) => {
		const id = String(nextId++);
		setOutputItems(prev => [
			...prev,
			{
				id,
				type,
				content,
			},
		]);
	};

	const addSearchResults = (data: SearchResultsData) => {
		const id = String(nextId++);
		setOutputItems(prev => [
			...prev,
			{
				id,
				type: 'search-results' as const,
				data,
			},
		]);
	};

	// Start the init wizard
	const startInitWizard = useCallback((isReinit: boolean) => {
		setWizardMode({active: true, type: 'init', step: 0, config: {}, isReinit});
	}, []);

	// Start the MCP setup wizard
	const startMcpSetupWizard = useCallback((showPrompt: boolean = false) => {
		setWizardMode({
			active: true,
			type: 'mcp-setup',
			step: showPrompt ? 'prompt' : 'select',
			config: {},
			showPrompt,
		});
	}, []);

	// Start the clean wizard
	const startCleanWizard = useCallback(() => {
		setWizardMode({active: true, type: 'clean'});
	}, []);

	// Handle clean wizard completion
	const handleCleanWizardComplete = useCallback(() => {
		setWizardMode({active: false});
		// Reset app state to uninitialized after cleaning
		setIndexStats(null);
		setIsInitialized(false);
	}, []);

	// Handle init wizard step changes
	const handleInitWizardStep = useCallback(
		(step: number, data?: Partial<InitWizardConfig>) => {
			setWizardMode(prev =>
				prev.active && prev.type === 'init'
					? {...prev, step, config: {...prev.config, ...data}}
					: prev,
			);
		},
		[],
	);

	// Handle MCP wizard step changes
	const handleMcpWizardStep = useCallback(
		(step: McpSetupStep, data?: Partial<McpSetupWizardConfig>) => {
			setWizardMode(prev =>
				prev.active && prev.type === 'mcp-setup'
					? {...prev, step, config: {...prev.config, ...data}}
					: prev,
			);
		},
		[],
	);

	// Handle init wizard completion
	const handleInitWizardComplete = useCallback(
		async (config: InitWizardConfig) => {
			// Close wizard first, then run init after a tick to ensure proper re-render
			setWizardMode({active: false});

			// Wait for next tick so wizard unmounts before we add output
			await new Promise(resolve => setTimeout(resolve, 50));

			addOutput('system', 'Initializing Viberag...');
			setAppStatus({state: 'warning', message: 'Initializing...'});

			try {
				const result = await runInit(
					projectRoot,
					isInitialized ?? false,
					config,
				);
				addOutput('system', result);
				setIsInitialized(true);

				// Automatically start indexing after init
				addOutput('system', 'Indexing codebase...');
				setAppStatus({
					state: 'indexing',
					current: 0,
					total: 0,
					stage: 'Indexing',
				});

				const stats = await runIndex(
					projectRoot,
					true,
					(current, total, stage) =>
						setAppStatus({state: 'indexing', current, total, stage}),
				);
				addOutput('system', formatIndexStats(stats));

				// Reload stats after indexing
				const newStats = await loadIndexStats(projectRoot);
				setIndexStats(newStats);
				setAppStatus({state: 'ready'});

				// Prompt for MCP setup after init completes
				await new Promise(resolve => setTimeout(resolve, 100));
				startMcpSetupWizard(true); // showPrompt = true for post-init flow
			} catch (err) {
				addOutput(
					'system',
					`Init failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				setAppStatus({state: 'ready'});
			}
		},
		[projectRoot, isInitialized, startMcpSetupWizard],
	);

	// Handle MCP wizard completion
	const handleMcpWizardComplete = useCallback(
		(_config: McpSetupWizardConfig) => {
			setWizardMode({active: false});
			// Results are already shown in the wizard summary
		},
		[],
	);

	// Handle wizard cancellation
	const handleWizardCancel = useCallback(() => {
		const wasInit = wizardMode.active && wizardMode.type === 'init';
		setWizardMode({active: false});
		if (wasInit) {
			addOutput('system', 'Initialization cancelled.');
		}
		// MCP wizard cancel just closes silently
	}, [wizardMode]);

	// Handle Ctrl+C with status message callback
	const {handleCtrlC} = useCtrlC({
		onFirstPress: () =>
			setAppStatus({state: 'warning', message: 'Press Ctrl+C again to quit'}),
		onStatusClear: () => setAppStatus({state: 'ready'}),
	});

	// Command handling (all logic consolidated in useRagCommands)
	const {isCommand, executeCommand} = useRagCommands({
		addOutput,
		addSearchResults,
		setAppStatus,
		setIndexStats,
		projectRoot,
		stdout,
		startInitWizard,
		startMcpSetupWizard,
		startCleanWizard,
		isInitialized: isInitialized ?? false,
	});

	const handleSubmit = (text: string) => {
		if (!text.trim()) return;

		// Add to history
		addToHistory(text);

		// Always show user input
		addOutput('user', text);

		if (isCommand(text)) {
			executeCommand(text);
		} else {
			// Placeholder for actual processing - just echo for now
			addOutput('system', `Echo: ${text}`);
		}
	};

	// Prepend welcome banner as first static item (only after BOTH init status AND stats are loaded)
	// This prevents race condition where banner shows stale "Run /index" while stats are loading
	const startupLoaded = isInitialized !== undefined && indexStats !== undefined;
	const staticItems = [
		...(startupLoaded
			? [{id: 'welcome', type: 'welcome' as const, content: ''}]
			: []),
		...outputItems,
	];

	return (
		<Box flexDirection="column">
			{/* StaticWithResize handles terminal resize by clearing and forcing re-render */}
			<StaticWithResize items={staticItems}>
				{item => {
					if (item.type === 'welcome') {
						return (
							<Box key={item.id} marginBottom={1}>
								<WelcomeBanner
									version={version}
									cwd={process.cwd()}
									isInitialized={isInitialized}
									indexStats={indexStats}
								/>
							</Box>
						);
					}
					if (item.type === 'search-results') {
						return (
							<Box key={item.id} paddingX={1} marginBottom={1}>
								<SearchResultsDisplay data={item.data} />
							</Box>
						);
					}
					return (
						<Box key={item.id} paddingX={1} marginBottom={1}>
							{item.type === 'user' ? (
								<Text color="cyan">&gt; {item.content}</Text>
							) : (
								<Text>{item.content}</Text>
							)}
						</Box>
					);
				}}
			</StaticWithResize>

			{/* Status bar with left (status) and right (stats) */}
			<StatusBar status={appStatus} stats={indexStats} />

			{/* Input area - show wizard or text input */}
			{wizardMode.active && wizardMode.type === 'init' ? (
				<InitWizard
					step={wizardMode.step}
					config={wizardMode.config}
					isReinit={wizardMode.isReinit}
					onStepChange={handleInitWizardStep}
					onComplete={handleInitWizardComplete}
					onCancel={handleWizardCancel}
				/>
			) : wizardMode.active && wizardMode.type === 'mcp-setup' ? (
				<McpSetupWizard
					step={wizardMode.step}
					config={wizardMode.config}
					projectRoot={projectRoot}
					showPrompt={wizardMode.showPrompt}
					onStepChange={handleMcpWizardStep}
					onComplete={handleMcpWizardComplete}
					onCancel={handleWizardCancel}
					addOutput={addOutput}
				/>
			) : wizardMode.active && wizardMode.type === 'clean' ? (
				<CleanWizard
					projectRoot={projectRoot}
					viberagDir={getViberagDir(projectRoot)}
					onComplete={handleCleanWizardComplete}
					onCancel={handleWizardCancel}
					addOutput={addOutput}
				/>
			) : (
				<TextInput
					onSubmit={handleSubmit}
					onCtrlC={handleCtrlC}
					commands={COMMANDS}
					navigateHistoryUp={navigateUp}
					navigateHistoryDown={navigateDown}
					resetHistoryIndex={resetIndex}
				/>
			)}
		</Box>
	);
}
