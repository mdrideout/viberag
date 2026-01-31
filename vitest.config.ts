import {defineConfig} from 'vitest/config';

/**
 * Vitest configuration with multiple projects.
 *
 * Splits tests into two projects:
 * - fast: CLI tests, merkle tests, grammar smoke tests (no embeddings)
 * - daemon: Daemon E2E tests (require embedding model)
 *
 * This allows:
 * - Fast tests to run in parallel with threads (8 workers)
 * - RAG tests to run sequentially in forks (1 worker, shared model cache)
 */
export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/dist/**'],
		environment: 'node',
		globals: true,
		passWithNoTests: true,
		setupFiles: ['source/test-setup.ts'],
		projects: [
			{
				extends: true,
				test: {
					name: 'fast',
					include: [
						'source/cli/__tests__/**/*.test.ts',
						'source/mcp/__tests__/**/*.test.ts',
						'source/daemon/__tests__/api-utils.test.ts',
						'source/daemon/__tests__/merkle.test.ts',
						'source/daemon/__tests__/grammar-smoke.test.ts',
					],
					pool: 'threads',
					maxWorkers: 8,
					minWorkers: 1,
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
			{
				extends: true,
				test: {
					name: 'daemon',
					include: [
						'source/daemon/__tests__/indexing.test.ts',
						'source/daemon/__tests__/search-*.test.ts',
						'source/daemon/__tests__/multi-language.test.ts',
						'source/daemon/__tests__/metadata-extraction.test.ts',
					],
					pool: 'forks',
					maxWorkers: 1,
					minWorkers: 1,
					testTimeout: 300_000,
					hookTimeout: 300_000,
				},
			},
		],
	},
});
