#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';

const cli = meow(
	`
	Usage
	  $ viberag

	Options
	  --help     Show help
	  --version  Show version

	Commands
	  /help   Show available commands
	  /clear  Clear the screen
	  /quit   Exit the application
`,
	{
		importMeta: import.meta,
		flags: {},
	},
);

// Suppress unused variable warning
void cli;

render(<App />, {
	exitOnCtrlC: false, // We handle Ctrl+C ourselves
});
