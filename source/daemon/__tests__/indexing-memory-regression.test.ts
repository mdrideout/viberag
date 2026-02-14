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
	afterCycles: MemorySnapshot[];
	afterCleanup: MemorySnapshot;
};

describe('Index/search memory regression', () => {
	it('keeps memory bounded across repeated index and search lifecycle churn', () => {
		const script = `
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createConfigForProvider, saveConfig} from './source/daemon/lib/config.ts';
import {getRunDir, getViberagDir} from './source/daemon/lib/constants.ts';
import {IndexingServiceV2} from './source/daemon/services/v2/indexing.ts';
import {SearchEngineV2} from './source/daemon/services/v2/search/engine.ts';

const CYCLES = 4;

class DummyEmbeddingProvider {
	constructor(dimensions) {
		this.dimensions = dimensions;
		this.initialized = false;
	}

	async initialize() {
		this.initialized = true;
	}

	async embed(texts) {
		if (!this.initialized) {
			await this.initialize();
		}
		return texts.map((text, index) => {
			const seed = ((text.length + index * 13) % 101) / 100;
			const out = new Array(this.dimensions);
			for (let i = 0; i < out.length; i += 1) out[i] = seed;
			return out;
		});
	}

	async embedSingle(text) {
		const [vector] = await this.embed([text]);
		return vector;
	}

	close() {
		this.initialized = false;
	}
}

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

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-index-mem-'));
const projectRoot = path.join(tempRoot, 'project');
await fs.mkdir(projectRoot, {recursive: true});
await fs.cp(path.join(process.cwd(), 'test-fixtures/codebase'), projectRoot, {
	recursive: true,
});

const config = createConfigForProvider('gemini');
config.watch = {...config.watch, enabled: false};
await saveConfig(projectRoot, config);

const afterCycles = [];

forceGc();
const before = snapshot();

for (let cycle = 0; cycle < CYCLES; cycle += 1) {
	const indexer = new IndexingServiceV2(projectRoot, {
		embeddings: new DummyEmbeddingProvider(config.embeddingDimensions),
	});
	await indexer.index({force: true});
	indexer.close();

	const search = new SearchEngineV2(projectRoot);
	await search.search('HttpClient', {
		intent: 'definition',
		k: 25,
		explain: false,
	});
	await search.search('fetchData', {
		intent: 'usage',
		k: 50,
		explain: false,
	});
	await search.search('add_two_numbers', {
		intent: 'exact_text',
		k: 25,
		explain: false,
	});
	search.close();

	forceGc();
	afterCycles.push(snapshot());
}

const projectDataDir = getViberagDir(projectRoot);
const runDir = getRunDir(projectRoot);
await fs.rm(projectDataDir, {recursive: true, force: true});
await fs.rm(runDir, {recursive: true, force: true});
await fs.rm(tempRoot, {recursive: true, force: true});

forceGc();
const afterCleanup = snapshot();

console.log(JSON.stringify({before, afterCycles, afterCleanup}));
`;

		const stdout = execFileSync(
			process.execPath,
			['--expose-gc', '--loader', 'ts-node/esm', '-e', script],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				maxBuffer: 30 * 1024 * 1024,
			},
		);

		const lines = stdout
			.trim()
			.split('\n')
			.filter(line => line.trim().length > 0);
		const payload = JSON.parse(lines[lines.length - 1]!) as MemoryResult;
		expect(payload.afterCycles.length).toBeGreaterThan(1);

		const firstCycle = payload.afterCycles[0]!;
		const lastCycle = payload.afterCycles[payload.afterCycles.length - 1]!;
		const rssGrowth = lastCycle.rssMB - firstCycle.rssMB;
		const externalGrowth = lastCycle.externalMB - firstCycle.externalMB;
		const cleanupResidualRss = payload.afterCleanup.rssMB - firstCycle.rssMB;
		const cleanupResidualExternal =
			payload.afterCleanup.externalMB - firstCycle.externalMB;

		// After warmup costs, lifecycle churn should not trend upward without bound.
		expect(rssGrowth).toBeLessThan(320);
		expect(externalGrowth).toBeLessThan(140);
		expect(cleanupResidualRss).toBeLessThan(260);
		expect(cleanupResidualExternal).toBeLessThan(120);
	});
});
