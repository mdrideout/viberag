import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['source/**/*.test.{ts,tsx}'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		environment: 'node',
		globals: true,
		passWithNoTests: true,
		// E2E tests need long timeouts for:
		// - First run: model download (~321MB fp16 ONNX, can take 2-5 min on slow connections)
		// - Subsequent runs: model is cached, tests run in seconds
		testTimeout: 300_000, // 5 minutes per test
		hookTimeout: 300_000, // 5 minutes for beforeEach (model init)
		// Run tests sequentially to avoid model initialization overhead
		pool: 'forks',
		maxWorkers: 1,
	},
});
