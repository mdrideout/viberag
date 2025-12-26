import {useCallback} from 'react';
import {useApp} from 'ink';

type CommandHandlers = {
	onClear: () => void;
	onHelp: () => void;
	onTerminalSetup: () => void;
	onIndex: (force: boolean) => void;
	onSearch: (query: string) => void;
	onStatus: () => void;
	onUnknown: (command: string) => void;
};

export function useCommands({
	onClear,
	onHelp,
	onTerminalSetup,
	onIndex,
	onSearch,
	onStatus,
	onUnknown,
}: CommandHandlers) {
	const {exit} = useApp();

	const isCommand = useCallback((text: string): boolean => {
		return text.trim().startsWith('/');
	}, []);

	const executeCommand = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			const command = trimmed.toLowerCase();

			// Handle commands with arguments
			if (command.startsWith('/search ')) {
				const query = trimmed.slice('/search '.length).trim();
				if (query) {
					onSearch(query);
				} else {
					onUnknown('/search (missing query)');
				}
				return;
			}

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
				case '/index':
					onIndex(false);
					break;
				case '/reindex':
					onIndex(true);
					break;
				case '/status':
					onStatus();
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
		[exit, onClear, onHelp, onTerminalSetup, onIndex, onSearch, onStatus, onUnknown],
	);

	return {isCommand, executeCommand};
}
