import {describe, it, expect} from 'vitest';
import {sanitizeForTelemetry} from '../lib/telemetry/sanitize.js';

describe('sanitizeForTelemetry', () => {
	it('summarizes code/snippet fields', () => {
		const input = {
			snippet: 'const x = 1;\nconsole.log(x);\n',
			code_text: 'function foo() { return 123; }\n',
			docstring: 'This is a docstring.\nIt might contain examples.\n',
		};

		const out = sanitizeForTelemetry(input, {mode: 'default'}) as Record<
			string,
			unknown
		>;

		for (const key of ['snippet', 'code_text', 'docstring'] as const) {
			const value = out[key] as Record<string, unknown>;
			expect(typeof value).toBe('object');
			expect(value).toHaveProperty('sha256');
			expect(value).toHaveProperty('byte_count');
			expect(value).toHaveProperty('line_count');
		}
	});

	it('summarizes arrays under content keys (e.g. lines)', () => {
		const out = sanitizeForTelemetry(
			{lines: ['secret line 1', 'secret line 2']},
			{mode: 'default'},
		) as Record<string, unknown>;

		expect(Array.isArray(out['lines'])).toBe(false);
		expect(out['lines']).toHaveProperty('sha256');
	});

	it('redacts common secrets in query (default mode)', () => {
		const out = sanitizeForTelemetry(
			{query: 'email test@example.com sk-abcdefghijklmnopqrstuvwxyz'},
			{mode: 'default'},
		) as Record<string, unknown>;

		expect(out['query']).toContain('[REDACTED_EMAIL]');
		expect(out['query']).toContain('[REDACTED_SECRET]');
	});

	it('hashes query and file paths in stripped mode', () => {
		const out = sanitizeForTelemetry(
			{
				query: 'hello world',
				file_path: '/tmp/project/src/index.ts',
			},
			{mode: 'stripped'},
		) as Record<string, unknown>;

		expect(out['query']).toHaveProperty('sha256');
		expect(out['query']).toHaveProperty('length');

		expect(out['file_path']).toHaveProperty('sha256');
		expect(out['file_path']).toHaveProperty('length');
		expect(out['file_path']).toHaveProperty('ext', '.ts');
	});
});
