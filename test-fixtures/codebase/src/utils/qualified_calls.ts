/**
 * Fixture for qualified call refs.
 *
 * For member calls we store both:
 * - base token: `doThing` / `getUser`
 * - qualified token: `inner.doThing` / `Endpoints.getUser`
 */
import * as Endpoints from '../api/endpoints';

const outer = {
	inner: {
		doThing() {
			return 123;
		},
	},
};

export function runQualifiedCalls() {
	outer.inner.doThing();
	Endpoints.getUser('123');
}
