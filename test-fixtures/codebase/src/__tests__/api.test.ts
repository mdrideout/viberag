/**
 * API test file for testing path exclusion filters.
 *
 * This file should be excludable via path_not_contains: ["__tests__"]
 */

import {getUser, createUser, deleteUser} from '../api/endpoints';

describe('User API', () => {
	describe('getUser', () => {
		it('returns a user by ID', async () => {
			const user = await getUser('123');
			expect(user).toBeDefined();
			expect(user.id).toBe('123');
		});

		it('throws on invalid ID', async () => {
			await expect(getUser('')).rejects.toThrow('Invalid ID');
		});
	});

	describe('createUser', () => {
		it('creates a new user', async () => {
			const user = await createUser({
				name: 'Test',
				email: 'test@example.com',
			});
			expect(user).toBeDefined();
			expect(user.name).toBe('Test');
		});
	});

	describe('deleteUser', () => {
		it('deletes a user by ID', async () => {
			await expect(deleteUser('123')).resolves.not.toThrow();
		});
	});
});

/**
 * Helper function used only in tests.
 * Should not appear in production code searches.
 */
function createTestUser(): {name: string; email: string} {
	return {
		name: 'Test User',
		email: 'test@test.com',
	};
}
