import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

type MemorySnapshot = {
	rssMB: number;
	heapUsedMB: number;
	externalMB: number;
	arrayBuffersMB: number;
};

type MemoryResult = {
	before: MemorySnapshot;
	after: MemorySnapshot;
	afterClose: MemorySnapshot;
};

describe('Chunker memory regression', () => {
	it('does not show unbounded native memory growth across repeated analyze calls', () => {
		const script = `
import fs from 'node:fs/promises';
import {Chunker} from './source/daemon/lib/chunker/index.ts';

const SAMPLE_PATH = './source/daemon/lib/chunker/index.ts';
const ITERATIONS = 300;

function mb(value) {
	return Number((value / (1024 * 1024)).toFixed(1));
}

function snapshot() {
	const usage = process.memoryUsage();
	return {
		rssMB: mb(usage.rss),
		heapUsedMB: mb(usage.heapUsed),
		externalMB: mb(usage.external),
		arrayBuffersMB: mb(usage.arrayBuffers),
	};
}

function forceGc() {
	if (typeof global.gc === 'function') {
		global.gc();
		global.gc();
	}
}

const source = await fs.readFile(SAMPLE_PATH, 'utf8');
const chunker = new Chunker();
await chunker.initialize();

forceGc();
const before = snapshot();

for (let i = 0; i < ITERATIONS; i += 1) {
	chunker.analyzeFile(SAMPLE_PATH, source, {
		chunkMaxSize: 2000,
		definitionMaxChunkSize: Number.MAX_SAFE_INTEGER,
		refs: {
			identifier_mode: 'symbolish',
			max_occurrences_per_token: 0,
			include_string_literals: false,
		},
	});
}

forceGc();
const after = snapshot();

chunker.close();
forceGc();
const afterClose = snapshot();

console.log(JSON.stringify({before, after, afterClose}));
`;

		const stdout = execFileSync(
			process.execPath,
			['--expose-gc', '--loader', 'ts-node/esm', '-e', script],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				maxBuffer: 20 * 1024 * 1024,
			},
		);

		const lines = stdout
			.trim()
			.split('\n')
			.filter(line => line.trim().length > 0);
		const payload = JSON.parse(lines[lines.length - 1]!) as MemoryResult;
		const externalGrowth = payload.after.externalMB - payload.before.externalMB;
		const rssGrowth = payload.after.rssMB - payload.before.rssMB;
		const residualExternal =
			payload.afterClose.externalMB - payload.before.externalMB;

		// Native memory should plateau, not grow without bound.
		expect(externalGrowth).toBeLessThan(80);
		expect(rssGrowth).toBeLessThan(220);
		expect(residualExternal).toBeLessThan(80);
	});
});
