/**
 * Tests for API utility retry behavior.
 */

import {describe, it, expect, afterEach, vi} from 'vitest';
import {withRetry, MAX_ATTEMPTS} from '../providers/api-utils.js';

describe('withRetry', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('stops after max attempts and returns the last error', async () => {
		vi.useFakeTimers();
		let attempts = 0;

		const promise = withRetry(async () => {
			attempts += 1;
			throw new Error('boom');
		});

		await vi.runAllTimersAsync();
		await expect(promise).rejects.toThrow('boom');
		expect(attempts).toBe(MAX_ATTEMPTS);
	});
});
