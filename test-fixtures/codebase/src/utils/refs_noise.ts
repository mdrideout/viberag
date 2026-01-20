/**
 * Fixture for refs extraction:
 *
 * The token "FooBarNoiseToken" appears only in:
 * - a string literal
 * - a comment
 *
 * It should not be indexed into v2_refs unless we intentionally enable
 * string_literal refs (we currently do not).
 */
export function refsNoiseFixture() {
	const msg = 'FooBarNoiseToken';
	// FooBarNoiseToken
	return msg;
}
