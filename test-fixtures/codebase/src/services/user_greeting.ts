/**
 * Fixture for refs extraction: call inside a template literal substitution.
 */
import {DEFAULT_USER, formatUserName} from '../../exported';

export function greetUser() {
	return `Hello ${formatUserName(DEFAULT_USER)}`;
}
