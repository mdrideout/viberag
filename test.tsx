import React from 'react';
import test from 'ava';
import {render} from 'ink-testing-library';
import OutputArea from './dist/components/OutputArea.js';
import StatusBar from './dist/components/StatusBar.js';

test('OutputArea shows welcome message when empty', t => {
	const {lastFrame} = render(<OutputArea items={[]} />);
	const frame = lastFrame();
	t.true(frame?.includes('Welcome to VibeRAG'));
});

test('OutputArea shows user messages', t => {
	const items = [{id: '1', type: 'user' as const, content: 'Hello world'}];
	const {lastFrame} = render(<OutputArea items={items} />);
	const frame = lastFrame();
	t.true(frame?.includes('Hello world'));
});

test('OutputArea shows system messages', t => {
	const items = [{id: '1', type: 'system' as const, content: 'Echo: test'}];
	const {lastFrame} = render(<OutputArea items={items} />);
	const frame = lastFrame();
	t.true(frame?.includes('Echo: test'));
});

test('StatusBar shows message when provided', t => {
	const {lastFrame} = render(
		<StatusBar message="Press Ctrl+C again to quit" />,
	);
	const frame = lastFrame();
	t.true(frame?.includes('Press Ctrl+C again to quit'));
});

test('StatusBar renders nothing when no message', t => {
	const {lastFrame} = render(<StatusBar message="" />);
	const frame = lastFrame();
	t.is(frame, '');
});
