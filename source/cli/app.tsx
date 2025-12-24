import React, {useState} from 'react';
import {Box, useStdout} from 'ink';
import TextInput from './components/TextInput.js';
import StatusBar from './components/StatusBar.js';
import OutputArea from './components/OutputArea.js';
import {useCtrlC} from './hooks/useCtrlC.js';
import {useCommands} from './hooks/useCommands.js';
import type {OutputItem} from './types.js';

export default function App() {
	const {stdout} = useStdout();
	const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
	const [statusMessage, setStatusMessage] = useState<string>('');

	// Get terminal dimensions
	const terminalHeight = stdout?.rows ?? 24;

	const addOutput = (type: 'user' | 'system', content: string) => {
		setOutputItems(prev => [
			...prev,
			{
				id: Date.now().toString(),
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
		onClear: () => setOutputItems([]),
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
  - Press Escape to clear input`,
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

		if (isCommand(text)) {
			executeCommand(text);
		} else {
			addOutput('user', text);
			// Placeholder for actual processing - just echo for now
			addOutput('system', `Echo: ${text}`);
		}
	};

	return (
		<Box flexDirection="column" height={terminalHeight}>
			{/* Output area takes remaining space */}
			<OutputArea items={outputItems} />

			{/* Status bar - fixed height */}
			<StatusBar message={statusMessage} />

			{/* Input area - auto-grows */}
			<TextInput onSubmit={handleSubmit} onCtrlC={handleCtrlC} />
		</Box>
	);
}
