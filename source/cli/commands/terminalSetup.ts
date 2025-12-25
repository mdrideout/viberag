import {homedir, platform} from 'node:os';
import {join, dirname} from 'node:path';
import {readFile, writeFile, mkdir} from 'node:fs/promises';

const VSCODE_KEYBINDING = {
	key: 'shift+enter',
	command: 'workbench.action.terminal.sendSequence',
	args: {text: '\u001b\r'},
	when: 'terminalFocus',
};

function getKeybindingsPath(): string {
	const home = homedir();
	switch (platform()) {
		case 'darwin':
			return join(
				home,
				'Library/Application Support/Code/User/keybindings.json',
			);
		case 'win32':
			return join(
				process.env['APPDATA'] ?? home,
				'Code/User/keybindings.json',
			);
		default: // Linux
			return join(home, '.config/Code/User/keybindings.json');
	}
}

export async function setupVSCodeTerminal(): Promise<string> {
	const keybindingsPath = getKeybindingsPath();

	let existing: unknown[] = [];
	try {
		const content = await readFile(keybindingsPath, 'utf-8');
		existing = JSON.parse(content);
		if (!Array.isArray(existing)) {
			existing = [];
		}
	} catch {
		// File doesn't exist or invalid JSON, start fresh
		await mkdir(dirname(keybindingsPath), {recursive: true});
	}

	// Check for existing shift+enter binding with same command
	const hasBinding = existing.some((b: unknown) => {
		if (typeof b !== 'object' || b === null) return false;
		const binding = b as Record<string, unknown>;
		return (
			binding['key'] === 'shift+enter' &&
			binding['command'] === 'workbench.action.terminal.sendSequence' &&
			binding['when'] === 'terminalFocus'
		);
	});

	if (hasBinding) {
		return 'VS Code already configured for Shift+Enter. No changes made.';
	}

	existing.push(VSCODE_KEYBINDING);
	await writeFile(keybindingsPath, JSON.stringify(existing, null, 2));

	return `Added Shift+Enter keybinding to:\n${keybindingsPath}\n\nRestart VS Code terminal to apply.`;
}
