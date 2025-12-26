import {homedir, platform} from 'node:os';
import {join, dirname} from 'node:path';
import {readFile, writeFile, mkdir, access, constants} from 'node:fs/promises';

const EDITORS = [
	{name: 'VS Code', folder: 'Code'},
	{name: 'VS Code Insiders', folder: 'Code - Insiders'},
	{name: 'Cursor', folder: 'Cursor'},
	{name: 'Windsurf', folder: 'Windsurf'},
	{name: 'VSCodium', folder: 'VSCodium'},
];

// ESC + LF - actual control character bytes
// \u001B = ESC (0x1B), \u000A = LF (0x0A)
const KEYBINDING = {
	key: 'shift+enter',
	command: 'workbench.action.terminal.sendSequence',
	args: {text: '\u001B\u000A'},
	when: 'terminalFocus',
};

type TerminalType = 'vscode' | 'iterm' | 'kitty' | 'wezterm' | 'apple_terminal' | 'unknown';

function detectTerminal(): TerminalType {
	const termProgram = process.env['TERM_PROGRAM'];
	const term = process.env['TERM'];

	if (termProgram === 'vscode') return 'vscode';
	if (termProgram === 'iTerm.app') return 'iterm';
	if (termProgram === 'Apple_Terminal') return 'apple_terminal';
	if (termProgram === 'WezTerm') return 'wezterm';
	if (term?.includes('kitty')) return 'kitty';

	return 'unknown';
}

function getKeybindingsPath(folder: string): string {
	const home = homedir();
	switch (platform()) {
		case 'darwin':
			return join(home, 'Library/Application Support', folder, 'User/keybindings.json');
		case 'win32':
			return join(process.env['APPDATA'] ?? home, folder, 'User/keybindings.json');
		default:
			return join(home, '.config', folder, 'User/keybindings.json');
	}
}

async function setupVSCodeEditors(): Promise<string> {
	const configured: string[] = [];

	for (const editor of EDITORS) {
		const path = getKeybindingsPath(editor.folder);
		const userDir = dirname(path);

		try {
			await access(userDir, constants.F_OK);
		} catch {
			continue;
		}

		let keybindings: unknown[] = [];
		try {
			const content = await readFile(path, 'utf-8');
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				keybindings = parsed;
			}
		} catch {
			await mkdir(dirname(path), {recursive: true});
		}

		keybindings = keybindings.filter((b: unknown) => {
			if (typeof b !== 'object' || b === null) return true;
			const kb = b as Record<string, unknown>;
			return !(
				kb['key'] === 'shift+enter' &&
				kb['command'] === 'workbench.action.terminal.sendSequence'
			);
		});

		keybindings.push(KEYBINDING);
		await writeFile(path, JSON.stringify(keybindings, null, 2));
		configured.push(editor.name);
	}

	if (configured.length === 0) {
		return '';
	}

	return `Configured Shift+Enter for: ${configured.join(', ')}\n\nRestart your terminal to apply.`;
}

export async function setupTerminal(): Promise<string> {
	const terminal = detectTerminal();

	switch (terminal) {
		case 'vscode':
			return setupVSCodeEditors();

		case 'iterm':
			return `iTerm2 detected.

To enable Shift+Enter for newlines:

1. Open iTerm2 → Settings (⌘,) → Profiles
2. Select your profile → Keys tab → General sub-tab
3. Under "Report modifiers using CSI u", select "Yes"
4. Restart iTerm2

Once enabled, Shift+Enter and Alt+Enter will insert newlines.

Alternative methods that work now:
- \\ + Enter (backslash then Enter)
- Ctrl+J`;

		case 'kitty':
			return `Kitty detected - Shift+Enter should work natively.

If not working, try:
- \\ + Enter (backslash then Enter)
- Ctrl+J`;

		case 'wezterm':
			return `WezTerm detected - Shift+Enter should work natively.

If not working, try:
- \\ + Enter (backslash then Enter)
- Ctrl+J`;

		case 'apple_terminal':
			return `macOS Terminal detected.

Shift+Enter is not supported in Terminal.app.

Use these methods instead:
- \\ + Enter (backslash then Enter)
- Ctrl+J
- Option+Enter

Consider using iTerm2 or running in VS Code for Shift+Enter support.`;

		default: {
			// Try VS Code editors anyway
			const vsResult = await setupVSCodeEditors();
			if (vsResult) {
				return vsResult;
			}
			return `Unknown terminal (TERM_PROGRAM=${process.env['TERM_PROGRAM'] ?? 'unset'}).

Try these methods:
- \\ + Enter (backslash then Enter)
- Ctrl+J
- Option+Enter

Run /terminal-setup in VS Code to configure Shift+Enter.`;
		}
	}
}

// Keep old export for backward compatibility during transition
export {setupTerminal as setupVSCodeTerminal};
