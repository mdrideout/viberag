import React, {useState, useEffect} from 'react';
import {createRequire} from 'node:module';
import {Box, Static, Text, useStdout} from 'ink';

// Common infrastructure
import {
	TextInput,
	StatusBar,
	useCtrlC,
	useCommandHistory,
	useKittyKeyboard,
	type OutputItem,
} from '../common/index.js';

// CLI-specific components and commands
import {WelcomeBanner} from './components/index.js';
import {useRagCommands} from './commands/useRagCommands.js';
import {checkInitialized} from './commands/handlers.js';

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
	const [statusMessage, setStatusMessage] = useState<string>('');
	const [isInitialized, setIsInitialized] = useState<boolean | undefined>(
		undefined,
	);
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

	// Command handling (all logic consolidated in useRagCommands)
	const {isCommand, executeCommand} = useRagCommands({
		addOutput,
		setStatusMessage,
		setIsInitialized,
		projectRoot,
		stdout,
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

	// Prepend welcome banner as first static item (only after init status is known)
	const staticItems = [
		...(isInitialized !== undefined
			? [{id: 'welcome', type: 'welcome' as const, content: ''}]
			: []),
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
								<WelcomeBanner
									version={version}
									cwd={process.cwd()}
									isInitialized={isInitialized}
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
