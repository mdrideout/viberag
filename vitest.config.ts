import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['source/**/*.test.{ts,tsx}'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		environment: 'node',
		globals: true,
		passWithNoTests: true,
	},
});
