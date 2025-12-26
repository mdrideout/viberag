import React from 'react';
import test from 'ava';
import {render} from 'ink-testing-library';
import StatusBar from './dist/common/components/StatusBar.js';

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
