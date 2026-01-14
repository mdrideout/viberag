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
	getStatus,
	loadIndexStats,
} from './handlers.js';
import {setupVSCodeTerminal} from '../../common/commands/terminalSetup.js';
import type {SearchResultsData} from '../../common/types.js';
import {useAppDispatch} from '../store/hooks.js';
import {AppActions} from '../store/app/slice.js';

type CommandContext = {
	addOutput: (type: 'user' | 'system', content: string) => void;
	addSearchResults: (data: SearchResultsData) => void;
	projectRoot: string;
	stdout: NodeJS.WriteStream;
	startInitWizard: (isReinit: boolean) => void;
	startMcpSetupWizard: (showPrompt?: boolean) => void;
	startCleanWizard: () => void;
	isInitialized: boolean;
};

export function useCommands({
	addOutput,
	addSearchResults,
	projectRoot,
	stdout,
	startInitWizard,
	startMcpSetupWizard,
	startCleanWizard,
	isInitialized,
}: CommandContext) {
	const dispatch = useAppDispatch();
	const {exit} = useApp();

	// Command handlers
	const handleHelp = useCallback(() => {
		addOutput(
			'system',
			`Commands:
  /help           - Show this help
  /clear          - Clear the screen
  /terminal-setup - Configure terminal for Shift+Enter
  /init           - Initialize Viberag (interactive wizard)
  /index          - Index the codebase
  /reindex        - Force full reindex
  /search <query> - Search the codebase
  /status         - Show index status
  /mcp-setup      - Configure MCP server for AI coding tools
  /clean          - Remove Viberag from project (delete .viberag/)
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
  Up/Down         - Command history

Manual MCP Setup:
  https://github.com/mdrideout/viberag?tab=readme-ov-file#manual-setup-instructions`,
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

	// Trigger init wizard
	const handleInit = useCallback(() => {
		startInitWizard(isInitialized);
	}, [startInitWizard, isInitialized]);

	const handleIndex = useCallback(
		(force: boolean) => {
			const action = force ? 'Reindexing' : 'Indexing';
			addOutput('system', `${action} codebase...`);
			// Progress is synced via DaemonStatusContext polling

			runIndex(projectRoot, force)
				.then(async stats => {
					if (stats) {
						addOutput('system', formatIndexStats(stats));
					} else {
						addOutput('system', 'Index complete.');
					}
					// Reload stats after indexing
					const newStats = await loadIndexStats(projectRoot);
					dispatch(AppActions.setIndexStats(newStats));
				})
				.catch(err => {
					addOutput('system', `Index failed: ${err.message}`);
				});
		},
		[projectRoot, addOutput, dispatch],
	);

	const handleSearch = useCallback(
		(query: string) => {
			addOutput('system', `Searching for "${query}"...`);
			dispatch(AppActions.setSearching());

			runSearch(projectRoot, query)
				.then(results => {
					// Use the component-based display with syntax highlighting
					addSearchResults({
						query: results.query,
						elapsedMs: results.elapsedMs,
						results: results.results.map(r => ({
							type: r.type,
							name: r.name,
							filepath: r.filepath,
							filename: r.filename,
							startLine: r.startLine,
							endLine: r.endLine,
							score: r.score,
							text: r.text,
						})),
					});
					dispatch(AppActions.setReady());
				})
				.catch(err => {
					addOutput('system', `Search failed: ${err.message}`);
					dispatch(AppActions.setReady());
				});
		},
		[projectRoot, addOutput, addSearchResults, dispatch],
	);

	const handleStatus = useCallback(() => {
		getStatus(projectRoot)
			.then(status => addOutput('system', status))
			.catch(err => addOutput('system', `Status failed: ${err.message}`));
	}, [projectRoot, addOutput]);

	const handleMcpSetup = useCallback(() => {
		startMcpSetupWizard(false); // showPrompt = false for direct /mcp-setup command
	}, [startMcpSetupWizard]);

	const handleClean = useCallback(() => {
		startCleanWizard();
	}, [startCleanWizard]);

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
					handleInit();
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
				case '/mcp-setup':
					handleMcpSetup();
					break;
				case '/clean':
				case '/uninstall':
					handleClean();
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
			handleMcpSetup,
			handleClean,
			handleUnknown,
		],
	);

	return {isCommand, executeCommand};
}
