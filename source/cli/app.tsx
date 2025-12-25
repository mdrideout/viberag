import React, {useState} from 'react';
import {createRequire} from 'node:module';
import {Box, Static, Text, useStdout} from 'ink';
import TextInput from './components/TextInput.js';
import StatusBar from './components/StatusBar.js';
import WelcomeBanner from './components/WelcomeBanner.js';
import {useCtrlC} from './hooks/useCtrlC.js';
import {useCommands} from './hooks/useCommands.js';
import {useCommandHistory} from './hooks/useCommandHistory.js';
import type {OutputItem} from './types.js';

const require = createRequire(import.meta.url);
// Path is relative from dist/ after compilation
const {version} = require('../package.json') as {version: string};

// Available slash commands for autocomplete
const COMMANDS = ['/help', '/clear', '/quit', '/exit', '/q'];

// Module-level counter for unique IDs
let nextId = 0;

export default function App() {
	const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
	const [statusMessage, setStatusMessage] = useState<string>('');
	const {stdout} = useStdout();

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
				`Available commands:
  /help  - Show this help message
  /clear - Clear the screen
  /quit  - Exit the application

Tips:
  - Press Enter to submit
  - Press Shift+Enter for a new line
  - Press Ctrl+C to clear input, or twice to quit
  - Press Escape to clear input
  - Up/Down arrows for command history`,
			);
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
								<WelcomeBanner version={version} cwd={process.cwd()} />
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
