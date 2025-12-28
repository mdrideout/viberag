/**
 * Module with mixed exports for testing is_exported field.
 *
 * Contains both exported and non-exported classes and functions
 * to verify export detection works correctly.
 */

interface User {
	id: string;
	name: string;
}

/**
 * Exported class with methods.
 * The class itself should be marked as exported.
 */
export class UserService {
	private cache: Map<string, User> = new Map();

	/**
	 * Get a user from the service.
	 * Method of exported class.
	 */
	async getUser(id: string): Promise<User | undefined> {
		return this.cache.get(id);
	}

	/**
	 * Save a user to the service.
	 * Another method.
	 */
	async saveUser(user: User): Promise<void> {
		this.cache.set(user.id, user);
	}
}

/**
 * Non-exported helper function.
 * Should have is_exported = false.
 */
function internalHelper(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Exported standalone function.
 * Should have is_exported = true.
 */
export function publicUtil(input: string): string {
	return internalHelper(input);
}

/**
 * Another exported function with documentation.
 */
export function formatUserName(user: User): string {
	return `${user.name} (${user.id})`;
}

/**
 * Non-exported class for internal use.
 * Should have is_exported = false.
 */
class PrivateCache {
	private data: Map<string, unknown> = new Map();

	get(key: string): unknown {
		return this.data.get(key);
	}

	set(key: string, value: unknown): void {
		this.data.set(key, value);
	}
}

/**
 * Non-exported constant.
 */
const INTERNAL_CONFIG = {
	maxRetries: 3,
	timeout: 5000,
};

/**
 * Exported constant.
 */
export const DEFAULT_USER: User = {
	id: 'default',
	name: 'Default User',
};

/**
 * Non-exported async function.
 */
async function fetchInternal(url: string): Promise<unknown> {
	// Internal fetch implementation
	return {url};
}

/**
 * Exported async function.
 */
export async function fetchPublic(url: string): Promise<unknown> {
	return fetchInternal(url);
}
