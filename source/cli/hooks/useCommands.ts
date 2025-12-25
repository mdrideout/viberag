import {useCallback} from 'react';
import {useApp} from 'ink';

type CommandHandlers = {
	onClear: () => void;
	onHelp: () => void;
	onTerminalSetup: () => void;
	onNewlineHelp: () => void;
	onUnknown: (command: string) => void;
};

export function useCommands({
	onClear,
	onHelp,
	onTerminalSetup,
	onNewlineHelp,
	onUnknown,
}: CommandHandlers) {
	const {exit} = useApp();

	const isCommand = useCallback((text: string): boolean => {
		return text.trim().startsWith('/');
	}, []);

	const executeCommand = useCallback(
		(text: string) => {
			const command = text.trim().toLowerCase();

			switch (command) {
				case '/help':
					onHelp();
					break;
				case '/clear':
					onClear();
					break;
				case '/terminal-setup':
					onTerminalSetup();
					break;
				case '/newline-help':
					onNewlineHelp();
					break;
				case '/quit':
				case '/exit':
				case '/q':
					exit();
					break;
				default:
					onUnknown(command);
					break;
			}
		},
		[exit, onClear, onHelp, onTerminalSetup, onNewlineHelp, onUnknown],
	);

	return {isCommand, executeCommand};
}
