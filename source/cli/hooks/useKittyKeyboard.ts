import {useEffect} from 'react';
import {useStdout} from 'ink';

// Kitty keyboard protocol escape sequences
// https://sw.kovidgoyal.net/kitty/keyboard-protocol/
const KITTY_ENABLE = '\x1b[>1u'; // Enable progressive enhancement mode 1
const KITTY_DISABLE = '\x1b[<u'; // Pop/disable keyboard mode

/**
 * Enables the Kitty keyboard protocol on mount and disables it on unmount.
 *
 * When enabled, terminals that support the protocol (iTerm2, Kitty, WezTerm)
 * will send CSI u encoded key sequences that include modifier information.
 * For example, Shift+Enter sends \x1b[13;2u instead of plain \r.
 *
 * Terminals that don't support the protocol simply ignore the escape sequence.
 */
export function useKittyKeyboard() {
	const {stdout} = useStdout();

	useEffect(() => {
		// Enable Kitty keyboard protocol on mount
		stdout.write(KITTY_ENABLE);

		// Disable on unmount
		return () => {
			stdout.write(KITTY_DISABLE);
		};
	}, [stdout]);
}
