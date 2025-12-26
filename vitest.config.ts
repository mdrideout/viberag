import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['source/**/*.test.{ts,tsx}'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		environment: 'node',
		globals: true,
		passWithNoTests: true,
		// E2E tests with real embeddings need longer timeouts
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// Run tests sequentially to avoid model initialization overhead
		pool: 'forks',
		maxWorkers: 1,
	},
});
