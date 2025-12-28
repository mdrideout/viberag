/**
 * User API endpoints for testing export detection and search.
 *
 * This module contains exported and non-exported functions
 * to test the is_exported metadata field.
 */

interface User {
	id: string;
	name: string;
	email: string;
}

interface UserData {
	name: string;
	email: string;
}

/**
 * Get a user by their ID.
 * This is an exported async function with JSDoc.
 */
export async function getUser(id: string): Promise<User> {
	validateId(id);
	return {
		id,
		name: 'Test User',
		email: 'test@example.com',
	};
}

/**
 * Validate a user ID format.
 * This is a non-exported helper function.
 */
function validateId(id: string): boolean {
	if (!id || id.length === 0) {
		throw new Error('Invalid ID');
	}
	return true;
}

/**
 * Create a new user.
 * Another exported function for testing.
 */
export async function createUser(data: UserData): Promise<User> {
	return {
		id: generateId(),
		name: data.name,
		email: data.email,
	};
}

/**
 * Generate a unique ID.
 * Non-exported utility function.
 */
function generateId(): string {
	return Math.random().toString(36).substring(2);
}

/**
 * Delete a user by ID.
 * Exported function.
 */
export async function deleteUser(id: string): Promise<void> {
	validateId(id);
	// Deletion logic would go here
}
