/**
 * CLI command handling hook.
 * Consolidates all command routing and handler implementations.
 */

import {useCallback} from 'react';
import {useApp} from 'ink';
import {
	runIndex,
	formatIndexStats,
	runSearch,
	formatSearchResults,
	getStatus,
	runInit,
	loadIndexStats,
	type IndexDisplayStats,
} from './handlers.js';
import {setupVSCodeTerminal} from '../../common/commands/terminalSetup.js';
import type {AppStatus} from '../../common/types.js';

type RagCommandContext = {
	addOutput: (type: 'user' | 'system', content: string) => void;
	setAppStatus: (status: AppStatus) => void;
	setIndexStats: (stats: IndexDisplayStats | null) => void;
	setIsInitialized: (val: boolean) => void;
	projectRoot: string;
	stdout: NodeJS.WriteStream;
};

export function useRagCommands({
	addOutput,
	setAppStatus,
	setIndexStats,
	setIsInitialized,
	projectRoot,
	stdout,
}: RagCommandContext) {
	const {exit} = useApp();

	// Command handlers
	const handleHelp = useCallback(() => {
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
	}, [addOutput]);

	const handleClear = useCallback(() => {
		// Clear screen (\x1B[2J), clear scrollback buffer (\x1B[3J), move cursor home (\x1B[H)
		stdout.write('\x1B[2J\x1B[3J\x1B[H');
	}, [stdout]);

	const handleTerminalSetup = useCallback(() => {
		setupVSCodeTerminal()
			.then(result => addOutput('system', result))
			.catch(err => addOutput('system', `Error: ${err.message}`));
	}, [addOutput]);

	const handleInit = useCallback(
		(force: boolean) => {
			const action = force ? 'Reinitializing' : 'Initializing';
			addOutput('system', `${action} Viberag...`);
			setAppStatus({state: 'warning', message: `${action}...`});

			runInit(projectRoot, force)
				.then(async result => {
					addOutput('system', result);
					// Reload stats (will be null after force init)
					const newStats = await loadIndexStats(projectRoot);
					setIndexStats(newStats);
					setAppStatus({state: 'ready'});
					setIsInitialized(true);
				})
				.catch(err => {
					addOutput('system', `Init failed: ${err.message}`);
					setAppStatus({state: 'ready'});
				});
		},
		[projectRoot, addOutput, setAppStatus, setIndexStats, setIsInitialized],
	);

	const handleIndex = useCallback(
		(force: boolean) => {
			const action = force ? 'Reindexing' : 'Indexing';
			addOutput('system', `${action} codebase...`);
			setAppStatus({state: 'indexing', current: 0, total: 0, stage: action});

			runIndex(projectRoot, force, (current, total, stage) =>
				setAppStatus({state: 'indexing', current, total, stage}),
			)
				.then(async stats => {
					addOutput('system', formatIndexStats(stats));
					// Reload stats after indexing
					const newStats = await loadIndexStats(projectRoot);
					setIndexStats(newStats);
					setAppStatus({state: 'ready'});
				})
				.catch(err => {
					addOutput('system', `Index failed: ${err.message}`);
					setAppStatus({state: 'ready'});
				});
		},
		[projectRoot, addOutput, setAppStatus, setIndexStats],
	);

	const handleSearch = useCallback(
		(query: string) => {
			addOutput('system', `Searching for "${query}"...`);
			setAppStatus({state: 'searching'});

			runSearch(projectRoot, query)
				.then(results => {
					addOutput('system', formatSearchResults(results));
					setAppStatus({state: 'ready'});
				})
				.catch(err => {
					addOutput('system', `Search failed: ${err.message}`);
					setAppStatus({state: 'ready'});
				});
		},
		[projectRoot, addOutput, setAppStatus],
	);

	const handleStatus = useCallback(() => {
		getStatus(projectRoot)
			.then(status => addOutput('system', status))
			.catch(err => addOutput('system', `Status failed: ${err.message}`));
	}, [projectRoot, addOutput]);

	const handleUnknown = useCallback(
		(command: string) => {
			addOutput(
				'system',
				`Unknown command: ${command}. Type /help for available commands.`,
			);
		},
		[addOutput],
	);

	// Command detection
	const isCommand = useCallback((text: string): boolean => {
		return text.trim().startsWith('/');
	}, []);

	// Command routing
	const executeCommand = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			const command = trimmed.toLowerCase();

			// Handle commands with arguments
			if (command.startsWith('/search ')) {
				const query = trimmed.slice('/search '.length).trim();
				if (query) {
					handleSearch(query);
				} else {
					handleUnknown('/search (missing query)');
				}
				return;
			}

			switch (command) {
				case '/help':
					handleHelp();
					break;
				case '/clear':
					handleClear();
					break;
				case '/terminal-setup':
					handleTerminalSetup();
					break;
				case '/init':
					handleInit(false);
					break;
				case '/init --force':
					handleInit(true);
					break;
				case '/index':
					handleIndex(false);
					break;
				case '/reindex':
					handleIndex(true);
					break;
				case '/status':
					handleStatus();
					break;
				case '/quit':
				case '/exit':
				case '/q':
					exit();
					break;
				default:
					handleUnknown(command);
					break;
			}
		},
		[
			exit,
			handleHelp,
			handleClear,
			handleTerminalSetup,
			handleInit,
			handleIndex,
			handleSearch,
			handleStatus,
			handleUnknown,
		],
	);

	return {isCommand, executeCommand};
}
