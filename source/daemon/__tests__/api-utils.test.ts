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

		const expectation = expect(promise).rejects.toThrow('boom');
		await vi.runAllTimersAsync();
		await expectation;
		expect(attempts).toBe(MAX_ATTEMPTS);
	});

	it('does not retry on context length errors', async () => {
		let attempts = 0;
		const promise = withRetry(async () => {
			attempts += 1;
			throw new Error("This model's maximum context length is 8192 tokens");
		});

		await expect(promise).rejects.toThrow('maximum context length');
		expect(attempts).toBe(1);
	});

	it('does not retry on Mistral token limit errors', async () => {
		let attempts = 0;
		const promise = withRetry(async () => {
			attempts += 1;
			throw new Error(
				'Input id 1 has 57558 tokens, exceeding max 8192 tokens.',
			);
		});

		await expect(promise).rejects.toThrow('exceeding max');
		expect(attempts).toBe(1);
	});

	it('does not retry on Gemini token limit errors', async () => {
		let attempts = 0;
		const promise = withRetry(async () => {
			attempts += 1;
			throw new Error(
				'The input token count (1632254) exceeds the maximum number of tokens allowed (1048576).',
			);
		});

		await expect(promise).rejects.toThrow('maximum number of tokens');
		expect(attempts).toBe(1);
	});

	it('aborts immediately when signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort('test reason');

		const promise = withRetry(
			async () => 'ok',
			undefined,
			undefined,
			undefined,
			undefined,
			controller.signal,
		);

		await expect(promise).rejects.toThrow('test reason');
	});
});
