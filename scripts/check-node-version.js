#!/usr/bin/env node
/* global console, process */

/**
 * Check Node.js version compatibility.
 * Native tree-sitter bindings require Node.js 18-23 (Node 24+ needs C++20 support).
 */

const [major] = process.versions.node.split('.').map(Number);

if (major < 18) {
	console.error(
		'\x1b[31m%s\x1b[0m',
		'⚠️  Error: viberag requires Node.js 18 or later.',
	);
	console.error(`   Current version: ${process.version}`);
	console.error('   Please upgrade: https://nodejs.org/');
	process.exit(1);
}

if (major >= 24) {
	console.error(
		'\x1b[33m%s\x1b[0m',
		'⚠️  Warning: Node.js 24+ is not yet supported for native tree-sitter bindings.',
	);
	console.error(`   Current version: ${process.version}`);
	console.error('   Recommended: Node.js 20 LTS or 22');
	console.error('   Run: nvm use 20');
	console.error('');
	console.error('   Native compilation may fail. Consider using Node 20 LTS.');
	// Don't exit - let them try, but warn
}
