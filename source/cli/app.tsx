import React, {useEffect, useCallback} from 'react';
import {createRequire} from 'node:module';
import {Box, Text, useStdout} from 'ink';
import {Provider} from 'react-redux';
import {store} from './store/store.js';
import {useAppDispatch, useAppSelector} from './store/hooks.js';
import {WizardActions} from './store/wizard/slice.js';
import {
	selectActiveWizard,
	selectInitStep,
	selectMcpStep,
	selectInitConfig,
	selectMcpConfig,
	selectIsReinit,
	selectShowMcpPrompt,
	selectExistingApiKeyId,
	selectExistingProvider,
} from './store/wizard/selectors.js';
import {AppActions} from './store/app/slice.js';
import {
	selectIsInitialized,
	selectIndexStats,
	selectAppStatus,
	selectOutputItems,
	selectStartupLoaded,
} from './store/app/selectors.js';

// Common infrastructure
import TextInput from '../common/components/TextInput.js';
import StatusBar from './components/StatusBar.js';
import StaticWithResize from '../common/components/StaticWithResize.js';
import {useCtrlC} from '../common/hooks/useCtrlC.js';
import {useCommandHistory} from '../common/hooks/useCommandHistory.js';
import {useKittyKeyboard} from '../common/hooks/useKittyKeyboard.js';
import type {
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
import {useCommands} from './commands/useCommands.js';
import {DaemonStatusProvider} from './contexts/DaemonStatusContext.js';
import {
	checkInitialized,
	loadIndexStats,
	runInit,
	runIndex,
	formatIndexStats,
} from './commands/handlers.js';
import {getViberagDir} from '../daemon/lib/constants.js';
import {loadConfig} from '../daemon/lib/config.js';
import {checkNpmForUpdate} from '../daemon/lib/update-check.js';
import {checkV2IndexCompatibility} from '../daemon/services/v2/manifest.js';
import type {SearchResultsData} from '../common/types.js';

const require = createRequire(import.meta.url);
// Path is relative from dist/ after compilation
const {version} = require('../../package.json') as {version: string};

// Available slash commands for autocomplete with descriptions
const COMMANDS: CommandInfo[] = [
	{command: '/help', description: 'Show available commands'},
	{command: '/clear', description: 'Clear the screen'},
	{
		command: '/terminal-setup',
		description: 'Configure Shift+Enter for VS Code',
	},
	{command: '/init', description: 'Initialize Viberag (provider wizard)'},
	{command: '/index', description: 'Index the codebase'},
	{command: '/reindex', description: 'Force full reindex'},
	{command: '/search', description: 'Search codebase semantically'},
	{command: '/status', description: 'Show daemon and index status'},
	{command: '/cancel', description: 'Cancel indexing or warmup'},
	{command: '/mcp-setup', description: 'Configure MCP for AI tools'},
	{command: '/clean', description: 'Remove Viberag from project'},
	{command: '/quit', description: 'Exit the application'},
];

/**
 * Inner app content that uses Redux hooks.
 * Must be rendered inside Provider.
 */
function AppContent() {
	const dispatch = useAppDispatch();

	// Redux wizard state
	const activeWizard = useAppSelector(selectActiveWizard);
	const initStep = useAppSelector(selectInitStep);
	const mcpStep = useAppSelector(selectMcpStep);
	const initConfig = useAppSelector(selectInitConfig);
	const mcpConfig = useAppSelector(selectMcpConfig);
	const isReinit = useAppSelector(selectIsReinit);
	const showMcpPrompt = useAppSelector(selectShowMcpPrompt);
	const existingApiKeyId = useAppSelector(selectExistingApiKeyId);
	const existingProvider = useAppSelector(selectExistingProvider);

	// Redux app state (migrated from useState)
	const isInitialized = useAppSelector(selectIsInitialized);
	const indexStats = useAppSelector(selectIndexStats);
	const appStatus = useAppSelector(selectAppStatus);
	const outputItems = useAppSelector(selectOutputItems);
	const startupLoaded = useAppSelector(selectStartupLoaded);

	const {stdout} = useStdout();

	// Enable Kitty keyboard protocol for Shift+Enter support in iTerm2/Kitty/WezTerm
	useKittyKeyboard();

	// Get project root (current working directory)
	const projectRoot = process.cwd();

	// Check initialization status and load stats on mount
	useEffect(() => {
		checkInitialized(projectRoot).then(async initialized => {
			dispatch(AppActions.setInitialized(initialized));
			// Load existing config for API key preservation during reinit
			if (initialized) {
				const config = await loadConfig(projectRoot);
				dispatch(
					WizardActions.setExistingConfig({
						apiKeyId: config.apiKeyRef?.keyId,
						provider: config.embeddingProvider,
					}),
				);
			}
		});
		loadIndexStats(projectRoot).then(stats =>
			dispatch(AppActions.setIndexStats(stats)),
		);
	}, [projectRoot, dispatch]);

	const addOutput = useCallback(
		(type: 'user' | 'system', content: string) => {
			dispatch(AppActions.addOutput({type, content}));
		},
		[dispatch],
	);

	const addSearchResults = useCallback(
		(data: SearchResultsData) => {
			dispatch(AppActions.addSearchResults(data));
		},
		[dispatch],
	);

	// Startup checks: updates + index compatibility (best-effort, non-blocking)
	useEffect(() => {
		const disabled =
			process.env['VIBERAG_SKIP_UPDATE_CHECK'] === '1' ||
			process.env['VIBERAG_SKIP_UPDATE_CHECK'] === 'true' ||
			process.env['NODE_ENV'] === 'test';

		if (!disabled) {
			checkNpmForUpdate({timeoutMs: 3000})
				.then(result => {
					if (result.status === 'update_available' && result.message) {
						addOutput('system', result.message);
					}
				})
				.catch(() => {});
		}

		checkV2IndexCompatibility(projectRoot)
			.then(result => {
				if (
					(result.status === 'needs_reindex' ||
						result.status === 'corrupt_manifest') &&
					result.message
				) {
					addOutput('system', result.message);
				}
			})
			.catch(() => {});
	}, [projectRoot, addOutput]);

	// Command history
	const {addToHistory, navigateUp, navigateDown, resetIndex} =
		useCommandHistory();

	// Start the init wizard
	const startInitWizard = useCallback(
		(isReinit: boolean) => {
			dispatch(
				WizardActions.startInit({
					isReinit,
					existingApiKeyId: existingApiKeyId ?? undefined,
					existingProvider: existingProvider ?? undefined,
				}),
			);
		},
		[dispatch, existingApiKeyId, existingProvider],
	);

	// Start the MCP setup wizard
	const startMcpSetupWizard = useCallback(
		(showPrompt: boolean = false) => {
			dispatch(WizardActions.startMcpSetup({showPrompt}));
		},
		[dispatch],
	);

	// Start the clean wizard
	const startCleanWizard = useCallback(() => {
		dispatch(WizardActions.startClean());
	}, [dispatch]);

	// Handle clean wizard completion
	const handleCleanWizardComplete = useCallback(() => {
		dispatch(WizardActions.close());
		// Reset app state to uninitialized after cleaning
		dispatch(AppActions.resetInitialized());
	}, [dispatch]);

	// Handle init wizard step changes
	const handleInitWizardStep = useCallback(
		(step: number, data?: Partial<InitWizardConfig>) => {
			dispatch(WizardActions.setInitStep({step, config: data}));
		},
		[dispatch],
	);

	// Handle MCP wizard step changes
	const handleMcpWizardStep = useCallback(
		(step: McpSetupStep, data?: Partial<McpSetupWizardConfig>) => {
			dispatch(WizardActions.setMcpStep({step, config: data}));
		},
		[dispatch],
	);

	// Handle init wizard completion
	const handleInitWizardComplete = useCallback(
		async (config: InitWizardConfig) => {
			// Close wizard first, then run init after a tick to ensure proper re-render
			dispatch(WizardActions.close());

			// Wait for next tick so wizard unmounts before we add output
			await new Promise(resolve => setTimeout(resolve, 50));

			addOutput('system', 'Initializing Viberag...');
			dispatch(AppActions.setWorking('Initializing...'));

			try {
				const result = await runInit(
					projectRoot,
					isInitialized ?? false,
					config,
					message => dispatch(AppActions.setWorking(message)),
				);
				addOutput('system', result);
				dispatch(AppActions.setInitialized(true));

				// Automatically start indexing after init
				addOutput('system', 'Indexing codebase...');
				// Progress is synced via DaemonStatusContext polling

				const stats = await runIndex(projectRoot, true);
				if (stats) {
					addOutput('system', formatIndexStats(stats));
				} else {
					addOutput('system', 'Index complete.');
				}

				// Reload stats after indexing
				const newStats = await loadIndexStats(projectRoot);
				dispatch(AppActions.setIndexStats(newStats));

				// Prompt for MCP setup after init completes
				await new Promise(resolve => setTimeout(resolve, 100));
				startMcpSetupWizard(true); // showPrompt = true for post-init flow
			} catch (err) {
				addOutput(
					'system',
					`Init failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				dispatch(AppActions.setReady());
			}
		},
		[projectRoot, isInitialized, startMcpSetupWizard, dispatch, addOutput],
	);

	// Handle MCP wizard completion
	const handleMcpWizardComplete = useCallback(
		(_config: McpSetupWizardConfig) => {
			dispatch(WizardActions.close());
			// Results are already shown in the wizard summary
		},
		[dispatch],
	);

	// Handle wizard cancellation
	const handleWizardCancel = useCallback(() => {
		const wasInit = activeWizard === 'init';
		dispatch(WizardActions.close());
		if (wasInit) {
			addOutput('system', 'Initialization cancelled.');
		}
		// MCP wizard cancel just closes silently
	}, [dispatch, activeWizard, addOutput]);

	// Handle Ctrl+C with status message callback
	const {handleCtrlC} = useCtrlC({
		onFirstPress: () =>
			dispatch(AppActions.setWarning('Press Ctrl+C again to quit')),
		onStatusClear: () => dispatch(AppActions.setReady()),
	});

	// Command handling (all logic consolidated in useRagCommands)
	const {isCommand, executeCommand} = useCommands({
		addOutput,
		addSearchResults,
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
	// startupLoaded is computed via Redux selector
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
			{activeWizard === 'init' ? (
				<InitWizard
					step={initStep}
					config={initConfig}
					isReinit={isReinit}
					existingApiKeyId={existingApiKeyId ?? undefined}
					existingProvider={existingProvider ?? undefined}
					onStepChange={handleInitWizardStep}
					onComplete={handleInitWizardComplete}
					onCancel={handleWizardCancel}
				/>
			) : activeWizard === 'mcp-setup' ? (
				<McpSetupWizard
					step={mcpStep}
					config={mcpConfig}
					projectRoot={projectRoot}
					showPrompt={showMcpPrompt}
					onStepChange={handleMcpWizardStep}
					onComplete={handleMcpWizardComplete}
					onCancel={handleWizardCancel}
					addOutput={addOutput}
				/>
			) : activeWizard === 'clean' ? (
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

/**
 * Main App component with Redux Provider and DaemonStatusProvider.
 */
export default function App() {
	const projectRoot = process.cwd();

	return (
		<Provider store={store}>
			<DaemonStatusProvider projectRoot={projectRoot}>
				<AppContent />
			</DaemonStatusProvider>
		</Provider>
	);
}
