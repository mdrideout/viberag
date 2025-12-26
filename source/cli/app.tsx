import React, {useState, useEffect} from 'react';
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
} from '../common/types.js';

// CLI-specific components and commands
import WelcomeBanner from './components/WelcomeBanner.js';
import {useRagCommands} from './commands/useRagCommands.js';
import {checkInitialized, loadIndexStats} from './commands/handlers.js';

const require = createRequire(import.meta.url);
// Path is relative from dist/ after compilation
const {version} = require('../../package.json') as {version: string};

// Available slash commands for autocomplete
const COMMANDS = [
	'/help',
	'/clear',
	'/terminal-setup',
	'/init',
	'/index',
	'/reindex',
	'/search',
	'/status',
	'/quit',
	'/exit',
	'/q',
];

// Module-level counter for unique IDs
let nextId = 0;

export default function App() {
	const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
	const [appStatus, setAppStatus] = useState<AppStatus>({state: 'ready'});
	// undefined = not loaded yet, null = loaded but no manifest, {...} = loaded with stats
	const [indexStats, setIndexStats] = useState<IndexDisplayStats | null | undefined>(undefined);
	const [isInitialized, setIsInitialized] = useState<boolean | undefined>(
		undefined,
	);
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

	// Handle Ctrl+C with status message callback
	const {handleCtrlC} = useCtrlC({
		onFirstPress: () =>
			setAppStatus({state: 'warning', message: 'Press Ctrl+C again to quit'}),
		onStatusClear: () => setAppStatus({state: 'ready'}),
	});

	// Command handling (all logic consolidated in useRagCommands)
	const {isCommand, executeCommand} = useRagCommands({
		addOutput,
		setAppStatus,
		setIndexStats,
		setIsInitialized,
		projectRoot,
		stdout,
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

			{/* Input area */}
			<TextInput
				onSubmit={handleSubmit}
				onCtrlC={handleCtrlC}
				commands={COMMANDS}
				navigateHistoryUp={navigateUp}
				navigateHistoryDown={navigateDown}
				resetHistoryIndex={resetIndex}
			/>
		</Box>
	);
}
