/**
 * Deeply nested utility file for testing 4-level directory nesting.
 * Contains specialized deep utility functions.
 */

/**
 * Flatten a deeply nested array.
 */
export function flattenDeep<T>(arr: unknown[]): T[] {
	return arr.reduce<T[]>((acc, val) => {
		if (Array.isArray(val)) {
			return acc.concat(flattenDeep<T>(val));
		}
		return acc.concat(val as T);
	}, []);
}

/**
 * Get value from deeply nested object path.
 */
export function getDeepValue(
	obj: Record<string, unknown>,
	path: string,
): unknown {
	return path.split('.').reduce<unknown>((current, key) => {
		if (current && typeof current === 'object') {
			return (current as Record<string, unknown>)[key];
		}
		return undefined;
	}, obj);
}

/**
 * Set value at deeply nested object path.
 */
export function setDeepValue(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const keys = path.split('.');
	const lastKey = keys.pop()!;
	const target = keys.reduce<Record<string, unknown>>((current, key) => {
		if (!(key in current)) {
			current[key] = {};
		}
		return current[key] as Record<string, unknown>;
	}, obj);
	target[lastKey] = value;
}
