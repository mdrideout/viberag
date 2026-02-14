#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const RUNS = Number(process.env['VIBERAG_MEM_RUNS'] ?? '3');
const ITERATIONS = Number(process.env['VIBERAG_MEM_ITERATIONS'] ?? '200');

const {Chunker} = await import(path.join(REPO_ROOT, 'dist/daemon/lib/chunker/index.js'));
const {IndexingServiceV2} = await import(
	path.join(REPO_ROOT, 'dist/daemon/services/v2/indexing.js')
);
const {createConfigForProvider, saveConfig} = await import(
	path.join(REPO_ROOT, 'dist/daemon/lib/config.js')
);

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
			const seed = ((text.length + index * 7) % 97) / 100;
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

function memory(label) {
	const usage = process.memoryUsage();
	const sample = {
		label,
		time: new Date().toISOString(),
		rssMB: mb(usage.rss),
		heapUsedMB: mb(usage.heapUsed),
		externalMB: mb(usage.external),
		arrayBuffersMB: mb(usage.arrayBuffers),
	};
	console.log(JSON.stringify(sample));
	return sample;
}

function forceGc() {
	if (typeof global.gc !== 'function') {
		return;
	}
	global.gc();
	global.gc();
}

async function createSyntheticProject() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viberag-memory-profile-'));
	const projectRoot = path.join(root, 'project');
	const homeRoot = path.join(root, 'home');
	process.env['VIBERAG_HOME'] = homeRoot;

	await fs.mkdir(projectRoot, {recursive: true});
	await fs.mkdir(homeRoot, {recursive: true});
	await fs.cp(path.join(REPO_ROOT, 'source'), path.join(projectRoot, 'source'), {
		recursive: true,
	});

	const config = createConfigForProvider('gemini');
	config.watch = {...config.watch, enabled: false};
	config.extensions = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
	await saveConfig(projectRoot, config);

	return {projectRoot, homeRoot, dimensions: config.embeddingDimensions};
}

async function runChunkerScenario(projectRoot) {
	console.log(JSON.stringify({section: 'chunker'}));
	const filePath = path.join(projectRoot, 'source/daemon/lib/chunker/index.ts');
	const source = await fs.readFile(filePath, 'utf8');

	const chunker = new Chunker();
	await chunker.initialize();

	forceGc();
	memory('chunker.before');

	for (let i = 0; i < RUNS; i += 1) {
		for (let j = 0; j < ITERATIONS; j += 1) {
			chunker.analyzeFile(filePath, source, {
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
		memory(`chunker.iter${i}`);
	}

	chunker.close();
	forceGc();
	memory('chunker.afterClose');
}

async function runIndexScenario(projectRoot, dimensions) {
	console.log(JSON.stringify({section: 'indexing'}));
	for (let i = 0; i < RUNS; i += 1) {
		forceGc();
		memory(`index.before.${i}`);

		const indexer = new IndexingServiceV2(projectRoot, {
			embeddings: new DummyEmbeddingProvider(dimensions),
		});
		const started = Date.now();
		const stats = await indexer.index({force: true});
		memory(`index.after.${i}`);
		indexer.close();

		forceGc();
		memory(`index.afterClose.${i}`);
		console.log(
			JSON.stringify({
				label: `index.stats.${i}`,
				durationMs: Date.now() - started,
				filesIndexed: stats.filesIndexed,
				symbolRowsUpserted: stats.symbolRowsUpserted,
				chunkRowsUpserted: stats.chunkRowsUpserted,
				embeddingsComputed: stats.embeddingsComputed,
			})
		);
	}
}

if (typeof global.gc !== 'function') {
	console.error(
		'[memory-profile] Run with --expose-gc for reliable post-GC comparisons.',
	);
}

const setup = await createSyntheticProject();
console.log(JSON.stringify({label: 'setup', ...setup, runs: RUNS, iterations: ITERATIONS}));

await runChunkerScenario(setup.projectRoot);
await runIndexScenario(setup.projectRoot, setup.dimensions);

forceGc();
memory('done');
