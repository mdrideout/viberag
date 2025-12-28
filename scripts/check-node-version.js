#!/usr/bin/env node
/* global console, process */

/**
 * Check Node.js version compatibility.
 * Native tree-sitter bindings require Node.js 20-23 (Node 24+ has compatibility issues).
 */

const [major] = process.versions.node.split('.').map(Number);

const STANDALONE_MSG = `
   Alternatively, download the standalone executable (no Node.js required):
   https://github.com/mattrideout/viberag/releases/latest
`;

if (major < 20) {
	console.error(
		'\x1b[31m%s\x1b[0m',
		'Error: viberag requires Node.js 20 or later.',
	);
	console.error(`   Current version: ${process.version}`);
	console.error('   Please upgrade: https://nodejs.org/');
	console.error(STANDALONE_MSG);
	process.exit(1);
}

if (major >= 24) {
	console.error(
		'\x1b[33m%s\x1b[0m',
		'Warning: Node.js 24+ is not yet supported for native tree-sitter bindings.',
	);
	console.error(`   Current version: ${process.version}`);
	console.error('   Recommended: Node.js 22 LTS');
	console.error('   Run: nvm install 22 && nvm use 22');
	console.error(STANDALONE_MSG);
	// Don't exit - let them try, but warn
}
