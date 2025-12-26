import React, {useState, useEffect} from 'react';
import {createRequire} from 'node:module';
import {Box, Static, Text, useStdout} from 'ink';
import TextInput from './components/TextInput.js';
import StatusBar from './components/StatusBar.js';
import WelcomeBanner from './components/WelcomeBanner.js';
import {useCtrlC} from './hooks/useCtrlC.js';
import {useCommands} from './hooks/useCommands.js';
import {useCommandHistory} from './hooks/useCommandHistory.js';
import {useKittyKeyboard} from './hooks/useKittyKeyboard.js';
import {setupVSCodeTerminal} from './commands/terminalSetup.js';
import {
	runIndex,
	formatIndexStats,
	runSearch,
	formatSearchResults,
	getStatus,
	runInit,
	checkInitialized,
} from './commands/rag.js';
import type {OutputItem} from './types.js';

const require = createRequire(import.meta.url);
// Path is relative from dist/ after compilation
const {version} = require('../package.json') as {version: string};

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
	const [statusMessage, setStatusMessage] = useState<string>('');
	const [isInitialized, setIsInitialized] = useState<boolean | undefined>(undefined);
	const {stdout} = useStdout();

	// Enable Kitty keyboard protocol for Shift+Enter support in iTerm2/Kitty/WezTerm
	useKittyKeyboard();

	// Get project root (current working directory)
	const projectRoot = process.cwd();

	// Check initialization status on mount
	useEffect(() => {
		checkInitialized(projectRoot).then(setIsInitialized);
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
		onFirstPress: () => setStatusMessage('Press Ctrl+C again to quit'),
		onStatusClear: () => setStatusMessage(''),
	});

	// Slash command handling
	const {isCommand, executeCommand} = useCommands({
		onClear: () => {
			// Clear screen (\x1B[2J), clear scrollback buffer (\x1B[3J), move cursor home (\x1B[H)
			stdout.write('\x1B[2J\x1B[3J\x1B[H');
		},
		onHelp: () => {
			addOutput(
				'system',
				`Commands:
  /help           - Show this help
  /clear          - Clear the screen
  /terminal-setup - Configure terminal for Shift+Enter
  /init           - Initialize Viberag in this directory
  /init --force   - Reinitialize (reset config)
  /index          - Index the codebase
  /reindex        - Force full reindex
  /search <query> - Search the codebase
  /status         - Show index status
  /quit           - Exit

Multi-line input:
  Shift+Enter     - iTerm2, Kitty, WezTerm (automatic)
  Shift+Enter     - VS Code (requires /terminal-setup)
  Option+Enter    - Most terminals
  Ctrl+J          - All terminals
  \\ then Enter    - All terminals

Tips:
  Ctrl+C          - Clear input (twice to quit)
  Escape          - Clear input
  Up/Down         - Command history`,
			);
		},
		onTerminalSetup: () => {
			setupVSCodeTerminal()
				.then(result => addOutput('system', result))
				.catch(err => addOutput('system', `Error: ${err.message}`));
		},
		onInit: (force: boolean) => {
			const action = force ? 'Reinitializing' : 'Initializing';
			addOutput('system', `${action} Viberag...`);
			setStatusMessage(`${action}...`);

			runInit(projectRoot, force)
				.then(result => {
					addOutput('system', result);
					setStatusMessage('');
					setIsInitialized(true);
				})
				.catch(err => {
					addOutput('system', `Init failed: ${err.message}`);
					setStatusMessage('');
				});
		},
		onIndex: (force: boolean) => {
			const action = force ? 'Reindexing' : 'Indexing';
			addOutput('system', `${action} codebase...`);
			setStatusMessage(`${action}...`);

			runIndex(projectRoot, force, msg => setStatusMessage(msg))
				.then(stats => {
					addOutput('system', formatIndexStats(stats));
					setStatusMessage('');
				})
				.catch(err => {
					addOutput('system', `Index failed: ${err.message}`);
					setStatusMessage('');
				});
		},
		onSearch: (query: string) => {
			addOutput('system', `Searching for "${query}"...`);
			setStatusMessage('Searching...');

			runSearch(projectRoot, query)
				.then(results => {
					addOutput('system', formatSearchResults(results));
					setStatusMessage('');
				})
				.catch(err => {
					addOutput('system', `Search failed: ${err.message}`);
					setStatusMessage('');
				});
		},
		onStatus: () => {
			getStatus(projectRoot)
				.then(status => addOutput('system', status))
				.catch(err => addOutput('system', `Status failed: ${err.message}`));
		},
		onUnknown: command => {
			addOutput(
				'system',
				`Unknown command: ${command}. Type /help for available commands.`,
			);
		},
	});

	const handleSubmit = (text: string) => {
		if (!text.trim()) return;

		// Add to history
		addToHistory(text);

		if (isCommand(text)) {
			executeCommand(text);
		} else {
			addOutput('user', text);
			// Placeholder for actual processing - just echo for now
			addOutput('system', `Echo: ${text}`);
		}
	};

	// Prepend welcome banner as first static item
	const staticItems = [
		{id: 'welcome', type: 'welcome' as const, content: ''},
		...outputItems,
	];

	return (
		<Box flexDirection="column">
			{/* Static renders messages once, they scroll up via terminal scrollback */}
			<Static items={staticItems}>
				{item => {
					if (item.type === 'welcome') {
						return (
							<Box key={item.id} marginBottom={1}>
								<WelcomeBanner version={version} cwd={process.cwd()} isInitialized={isInitialized} />
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
			</Static>

			{/* Dynamic content stays at current cursor position */}
			<StatusBar message={statusMessage} />

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
