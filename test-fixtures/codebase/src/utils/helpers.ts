/**
 * General helper utility functions.
 * Common operations used throughout the application.
 */

/**
 * Capitalize the first letter of a string.
 */
export function capitalize(str: string): string {
	if (!str) return '';
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Debounce a function call.
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
	fn: T,
	delay: number,
): (...args: Parameters<T>) => void {
	let timeoutId: ReturnType<typeof setTimeout>;
	return (...args: Parameters<T>) => {
		clearTimeout(timeoutId);
		timeoutId = setTimeout(() => fn(...args), delay);
	};
}

/**
 * Deep clone an object.
 */
export function deepClone<T>(obj: T): T {
	return JSON.parse(JSON.stringify(obj));
}

/**
 * Check if value is empty (null, undefined, empty string, empty array).
 */
export function isEmpty(value: unknown): boolean {
	if (value == null) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	return false;
}
