/**
 * Shared library utilities.
 * Common functions used across multiple projects.
 */

/**
 * Generate a unique ID.
 */
export function generateId(): string {
	return Math.random().toString(36).substring(2, 15);
}

/**
 * Format a date for display.
 */
export function formatDate(date: Date): string {
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
}

/**
 * Sleep for a specified duration.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 */
export async function retry<T>(
	fn: () => Promise<T>,
	maxAttempts: number = 3,
	baseDelay: number = 1000,
): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;
			if (attempt < maxAttempts - 1) {
				await sleep(baseDelay * Math.pow(2, attempt));
			}
		}
	}

	throw lastError;
}
