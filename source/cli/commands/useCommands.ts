/**
 * CLI command handling hook.
 * Consolidates all command routing and handler implementations.
 */

import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {useCallback} from 'react';
import {useApp} from 'ink';
import {
	runIndex,
	formatIndexStats,
	runSearch,
	getStatus,
	loadIndexStats,
	cancelActivity,
	runEval,
	formatEvalReport,
} from './handlers.js';
import {setupVSCodeTerminal} from '../../common/commands/terminalSetup.js';
import type {SearchResultsData} from '../../common/types.js';
import {useAppDispatch} from '../store/hooks.js';
import {AppActions} from '../store/app/slice.js';
import {DaemonClient} from '../../client/index.js';
import type {TelemetryClient} from '../../daemon/lib/telemetry/client.js';
import {VIBERAG_PRIVACY_POLICY} from '../../daemon/lib/telemetry/privacy-policy.js';
import {
	loadUserSettings,
	parseTelemetryMode,
	resolveEffectiveTelemetryMode,
	setTelemetryMode,
} from '../../daemon/lib/user-settings.js';
import {
	captureException,
	flushSentry,
} from '../../daemon/lib/telemetry/sentry.js';

type CommandContext = {
	addOutput: (type: 'user' | 'system', content: string) => void;
	addSearchResults: (data: SearchResultsData) => void;
	projectRoot: string;
	stdout: NodeJS.WriteStream;
	startInitWizard: (isReinit: boolean) => void;
	startMcpSetupWizard: (showPrompt?: boolean) => void;
	startCleanWizard: () => void;
	isInitialized: boolean;
	telemetry: TelemetryClient;
	shutdownTelemetry: () => Promise<void>;
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
	telemetry,
	shutdownTelemetry,
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
  /eval           - Run evaluation harness
  /status         - Show index status
  /cancel [target] - Cancel indexing or warmup (targets: indexing, warmup)
  /mcp-setup      - Configure MCP server for AI coding tools
  /telemetry [mode] - Set telemetry (disabled|stripped|default)
  /privacy-policy - Show privacy policy for telemetry
  /clean          - Remove VibeRAG from project (delete project data)
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
					const message = err instanceof Error ? err.message : String(err);
					if (message.toLowerCase().includes('cancel')) {
						addOutput('system', 'Index cancelled.');
					} else {
						addOutput('system', `Index failed: ${message}`);
					}
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
					addSearchResults(results);
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

	const handleEval = useCallback(() => {
		addOutput('system', 'Running eval harness...');
		dispatch(AppActions.setWorking('Running eval harness...'));

		runEval(projectRoot)
			.then(report => {
				addOutput('system', formatEvalReport(report));
				dispatch(AppActions.setReady());
			})
			.catch(err => {
				const message = err instanceof Error ? err.message : String(err);
				addOutput('system', `Eval failed: ${message}`);
				dispatch(AppActions.setReady());
			});
	}, [projectRoot, addOutput, dispatch]);

	const handleCancel = useCallback(
		(target?: string) => {
			cancelActivity(projectRoot, target)
				.then(message => addOutput('system', message))
				.catch(err => addOutput('system', `Cancel failed: ${err.message}`));
		},
		[projectRoot, addOutput],
	);

	const handleMcpSetup = useCallback(() => {
		startMcpSetupWizard(false); // showPrompt = false for direct /mcp-setup command
	}, [startMcpSetupWizard]);

	const handleClean = useCallback(() => {
		startCleanWizard();
	}, [startCleanWizard]);

	const handleTelemetry = useCallback(
		(arg?: string) => {
			const requested = arg?.trim();

			const showCurrent = async () => {
				const settings = await loadUserSettings();
				const effective = resolveEffectiveTelemetryMode(settings);
				const source =
					effective.source === 'env'
						? 'VIBERAG_TELEMETRY env var'
						: 'global settings file';

				addOutput(
					'system',
					`Telemetry mode: ${effective.mode} (from ${source})\n\nModes:\n  disabled - no telemetry or error reporting\n  stripped - privacy-preserving telemetry (no query text)\n  default  - includes query text (best-effort redaction)\n\nSet with:\n  /telemetry disabled|stripped|default\n\nThis setting is global (applies to CLI, daemon, and MCP).`,
				);

				await telemetry.captureOperation({
					operation_kind: 'cli_command',
					name: '/telemetry',
					projectRoot,
					input: {action: 'show', effective_mode: effective.mode},
					output: null,
					success: true,
					duration_ms: 0,
				});
			};

			const setMode = async (mode: string) => {
				const parsed = parseTelemetryMode(mode);
				if (!parsed) {
					addOutput(
						'system',
						`Invalid telemetry mode: ${mode}\n\nUsage:\n  /telemetry disabled|stripped|default`,
					);
					return;
				}

				await setTelemetryMode(parsed);
				addOutput(
					'system',
					`Telemetry mode set to: ${parsed}\n\nThis setting is global (applies to CLI, daemon, and MCP).\nIf the daemon is already running, it may take a few seconds to pick up the change.`,
				);

				await telemetry.captureOperation({
					operation_kind: 'cli_command',
					name: '/telemetry',
					projectRoot,
					input: {action: 'set', mode: parsed},
					output: null,
					success: true,
					duration_ms: 0,
				});
			};

			void (async () => {
				if (!requested) {
					await showCurrent();
					return;
				}
				await setMode(requested);
			})().catch(err => {
				addOutput('system', `Telemetry error: ${err.message}`);
			});
		},
		[addOutput, projectRoot, telemetry],
	);

	const handlePrivacyPolicy = useCallback(() => {
		addOutput('system', VIBERAG_PRIVACY_POLICY);
		telemetry.capture({
			event: 'viberag_privacy_policy_viewed',
			properties: {service: 'cli'},
		});
	}, [addOutput, telemetry]);

	const handleTestException = useCallback(
		(arg?: string) => {
			void (async () => {
				const testId = crypto.randomUUID();
				const settings = await loadUserSettings();
				const effective = resolveEffectiveTelemetryMode(settings);

				if (effective.mode === 'disabled') {
					addOutput(
						'system',
						`Telemetry is disabled, so error reporting is also disabled.\n\nSet with:\n  /telemetry default\n\nThen re-run:\n  /test-exception`,
					);
					return;
				}

				addOutput(
					'system',
					`Triggering test exceptions (test_id=${testId}).\nThis is an undocumented command.`,
				);

				// CLI exception (captured, not fatal)
				const cliError = new Error(
					`VibeRAG test exception (cli)${arg ? `: ${arg}` : ''}`,
				);
				captureException(cliError, {
					tags: {service: 'cli', test_exception: 'true'},
					extra: {test_id: testId},
				});
				await flushSentry(2000);

				// Daemon exception (captured inside daemon handler)
				if (isInitialized) {
					const client = new DaemonClient(projectRoot);
					try {
						await client.testException(`test_id=${testId}`);
					} catch {
						// Expected: daemon throws
					} finally {
						await client.disconnect();
					}
				} else {
					addOutput(
						'system',
						'Skipping daemon test exception (project not initialized).',
					);
				}

				// MCP exception (one-shot process)
				const modulePath = fileURLToPath(import.meta.url);
				const mcpScriptPath = path.resolve(
					path.dirname(modulePath),
					'../../mcp/index.js',
				);

				const env = {
					...process.env,
					VIBERAG_TEST_EXCEPTION: '1',
					VIBERAG_TEST_EXCEPTION_ID: testId,
				};

				const spawnAndWait = (command: string, args: string[]) =>
					new Promise<number | null>((resolve, reject) => {
						const child = spawn(command, args, {
							cwd: projectRoot,
							env,
							stdio: 'ignore',
							windowsHide: true,
						});
						child.on('error', reject);
						child.on('exit', code => resolve(code));
					});

				try {
					await fs.access(mcpScriptPath);
					const exitCode = await spawnAndWait(process.execPath, [
						mcpScriptPath,
					]);
					addOutput(
						'system',
						`MCP test exception process exited (code ${exitCode ?? 'unknown'}).`,
					);
				} catch {
					try {
						const exitCode = await spawnAndWait('npx', ['viberag-mcp']);
						addOutput(
							'system',
							`MCP test exception process exited (code ${exitCode ?? 'unknown'}).`,
						);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						addOutput(
							'system',
							`Failed to run MCP test exception process: ${message}\n\nTry manually:\n  VIBERAG_TEST_EXCEPTION=1 npx viberag-mcp`,
						);
					}
				}

				addOutput(
					'system',
					`Done. Check Sentry for events tagged test_exception=true (test_id=${testId}).`,
				);
			})().catch(err => {
				const message = err instanceof Error ? err.message : String(err);
				addOutput('system', `Test exception command failed: ${message}`);
			});
		},
		[addOutput, isInitialized, projectRoot],
	);

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
			if (command.startsWith('/cancel')) {
				const target = trimmed.slice('/cancel'.length).trim();
				handleCancel(target || undefined);
				return;
			}
			if (command.startsWith('/telemetry')) {
				const arg = trimmed.slice('/telemetry'.length).trim();
				handleTelemetry(arg || undefined);
				return;
			}
			if (command.startsWith('/test-exception')) {
				const arg = trimmed.slice('/test-exception'.length).trim();
				handleTestException(arg || undefined);
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
				case '/eval':
					handleEval();
					break;
				case '/mcp-setup':
					handleMcpSetup();
					break;
				case '/privacy-policy':
					handlePrivacyPolicy();
					break;
				case '/clean':
				case '/uninstall':
					handleClean();
					break;
				case '/quit':
				case '/exit':
				case '/q':
					void shutdownTelemetry()
						.catch(() => {})
						.finally(() => exit());
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
			handleEval,
			handleCancel,
			handleMcpSetup,
			handleTelemetry,
			handlePrivacyPolicy,
			handleTestException,
			shutdownTelemetry,
			handleClean,
			handleUnknown,
		],
	);

	return {isCommand, executeCommand};
}
