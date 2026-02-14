#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execFile = promisify(execFileCb);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DAEMON_ENTRY = path.join(REPO_ROOT, 'dist/daemon/index.js');
const OUTPUT_DIR = path.join(REPO_ROOT, 'scripts/memory/out');

const QUERY =
	process.env['VIBERAG_ISOLATE_QUERY'] ??
	'indexing memory lifecycle ownership contract cleanup';
const K = Math.max(
	1,
	Math.min(100, Number(process.env['VIBERAG_ISOLATE_K'] ?? '100')),
);
const EXPLAIN = process.env['VIBERAG_ISOLATE_EXPLAIN'] !== '0';
const REQUEST_TIMEOUT_MS = Number(
	process.env['VIBERAG_ISOLATE_REQUEST_TIMEOUT_MS'] ?? '30000',
);
const POST_SAMPLE_DELAY_MS = Number(
	process.env['VIBERAG_ISOLATE_POST_SAMPLE_DELAY_MS'] ?? '1500',
);
const VMAP_TRIGGER_MB = Number(
	process.env['VIBERAG_ISOLATE_VMMAP_TRIGGER_MB'] ?? '1500',
);
const INTENTS = (
	process.env['VIBERAG_ISOLATE_INTENTS'] ??
	'definition,concept,usage,exact_text,similar_code,auto'
)
	.split(',')
	.map(intent => intent.trim())
	.filter(Boolean);

if (INTENTS.length === 0) {
	throw new Error('VIBERAG_ISOLATE_INTENTS produced an empty intent list.');
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
	return new Date().toISOString();
}

function compactError(error) {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function mbFromKb(kb) {
	return Number((kb / 1024).toFixed(1));
}

async function withTimeout(promise, timeoutMs, label) {
	const timeout = new Promise((_, reject) => {
		setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	return Promise.race([promise, timeout]);
}

async function listDaemonRows() {
	const {stdout} = await execFile('ps', [
		'-axo',
		'pid=,rss=,vsz=,%cpu=,%mem=,state=,etime=,command=',
	]);
	const rows = [];
	for (const line of stdout.split('\n')) {
		if (!line.includes(DAEMON_ENTRY)) continue;
		const match = line.match(
			/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(.+)$/,
		);
		if (!match) continue;
		rows.push({
			pid: Number(match[1]),
			rssMB: mbFromKb(Number(match[2])),
			vszMB: mbFromKb(Number(match[3])),
			cpuPercent: Number(match[4]),
			memPercent: Number(match[5]),
			state: match[6],
			etime: match[7],
			command: match[8],
		});
	}
	return rows;
}

async function killDaemonProcesses() {
	const initial = await listDaemonRows();
	if (initial.length === 0) {
		await cleanupStaleRunArtifacts();
		return {killed: [], zombieLike: []};
	}

	const killed = [];
	for (const row of initial) {
		try {
			process.kill(row.pid, 'SIGTERM');
			killed.push({pid: row.pid, signal: 'SIGTERM'});
		} catch {}
	}
	await sleep(500);

	const afterTerm = await listDaemonRows();
	for (const row of afterTerm) {
		try {
			process.kill(row.pid, 'SIGKILL');
			killed.push({pid: row.pid, signal: 'SIGKILL'});
		} catch {}
	}
	await sleep(500);

	const stillThere = await listDaemonRows();
	if (stillThere.length === 0) {
		await cleanupStaleRunArtifacts();
	}
	return {killed, zombieLike: stillThere.map(row => row.pid)};
}

async function cleanupStaleRunArtifacts() {
	const {getDaemonLockPath, getDaemonPidPath, getDaemonSocketPath} =
		await import(path.join(REPO_ROOT, 'dist/daemon/lib/constants.js'));
	const stalePaths = [
		getDaemonLockPath(REPO_ROOT),
		getDaemonPidPath(REPO_ROOT),
		getDaemonSocketPath(REPO_ROOT),
	];
	for (const stalePath of stalePaths) {
		try {
			await fs.rm(stalePath, {force: true, recursive: true});
		} catch {}
	}
}

function summarizeResult(result) {
	if (!result || typeof result !== 'object') {
		return {bytes: 0, groups: null};
	}
	let bytes = 0;
	try {
		bytes = JSON.stringify(result).length;
	} catch {}

	const groups = result.groups ?? {};
	return {
		bytes,
		groups: {
			definitions: Array.isArray(groups.definitions)
				? groups.definitions.length
				: 0,
			files: Array.isArray(groups.files) ? groups.files.length : 0,
			blocks: Array.isArray(groups.blocks) ? groups.blocks.length : 0,
			usages: Array.isArray(groups.usages) ? groups.usages.length : 0,
		},
	};
}

async function captureVmmapSummary(pid) {
	try {
		const {stdout} = await withTimeout(
			execFile('vmmap', ['-summary', String(pid)]),
			5000,
			'vmmap',
		);
		const lines = stdout.split('\n');
		const picked = lines.filter(
			line =>
				line.includes('Physical footprint') ||
				line.includes('MALLOC') ||
				line.includes('VM_ALLOCATE') ||
				line.includes('MALLOC_NANO') ||
				line.includes('TOTAL'),
		);
		return picked.slice(0, 120);
	} catch (error) {
		return [`vmmap_error: ${compactError(error)}`];
	}
}

const {DaemonClient} = await import(
	path.join(REPO_ROOT, 'dist/client/index.js')
);

await fs.mkdir(OUTPUT_DIR, {recursive: true});
const runId = nowIso().replace(/[:.]/g, '-');
const outputFile = path.join(
	OUTPUT_DIR,
	`isolate-intent-growth-${runId}.jsonl`,
);

async function writeRow(row) {
	await fs.appendFile(outputFile, `${JSON.stringify(row)}\n`, 'utf8');
}

const header = {
	ts: nowIso(),
	label: 'run.start',
	query: QUERY,
	intents: INTENTS,
	k: K,
	explain: EXPLAIN,
	requestTimeoutMs: REQUEST_TIMEOUT_MS,
	postSampleDelayMs: POST_SAMPLE_DELAY_MS,
	vmmapTriggerMB: VMAP_TRIGGER_MB,
	outputFile,
};
console.log(JSON.stringify(header));
await writeRow(header);

const summary = [];

for (const intent of INTENTS) {
	const scenarioStart = Date.now();
	const cleanupBefore = await killDaemonProcesses();
	const client = new DaemonClient({
		projectRoot: REPO_ROOT,
		autoStart: true,
		connectTimeout: 30_000,
		clientSource: 'mcp',
	});

	let baselineStatus = null;
	let baselinePs = null;
	let searchOutcome = null;
	let postStatus = null;
	let postPs = null;
	let postDelayStatus = null;
	let vmmapSummary = null;
	let error = null;

	try {
		await withTimeout(client.connect(), 30_000, 'connect');
		baselineStatus = await client.status();
		baselinePs = (await listDaemonRows())[0] ?? null;

		const searchStarted = Date.now();
		try {
			const result = await withTimeout(
				client.search(QUERY, {intent, k: K, explain: EXPLAIN}),
				REQUEST_TIMEOUT_MS,
				`search:${intent}`,
			);
			searchOutcome = {
				ok: true,
				durationMs: Date.now() - searchStarted,
				...summarizeResult(result),
			};
		} catch (searchError) {
			searchOutcome = {
				ok: false,
				durationMs: Date.now() - searchStarted,
				error: compactError(searchError),
			};
		}

		try {
			postStatus = await client.status();
		} catch (statusError) {
			error = `post_status: ${compactError(statusError)}`;
		}
		postPs = (await listDaemonRows())[0] ?? null;

		await sleep(POST_SAMPLE_DELAY_MS);
		try {
			postDelayStatus = await client.status();
		} catch {}

		const observedPostRss = Math.max(
			postStatus?.memory?.rssMB ?? 0,
			postPs?.rssMB ?? 0,
		);
		if (observedPostRss >= VMAP_TRIGGER_MB && postPs?.pid) {
			vmmapSummary = await captureVmmapSummary(postPs.pid);
		}
	} catch (scenarioError) {
		error = compactError(scenarioError);
	} finally {
		await client.disconnect().catch(() => {});
	}

	const cleanupAfter = await killDaemonProcesses();
	const row = {
		ts: nowIso(),
		label: 'scenario.result',
		intent,
		durationMs: Date.now() - scenarioStart,
		baseline: {
			pid: baselinePs?.pid ?? null,
			rssMBPs: baselinePs?.rssMB ?? null,
			rssMBStatus: baselineStatus?.memory?.rssMB ?? null,
			heapUsedMBStatus: baselineStatus?.memory?.heapUsedMB ?? null,
			externalMBStatus: baselineStatus?.memory?.externalMB ?? null,
		},
		search: searchOutcome,
		post: {
			pid: postPs?.pid ?? null,
			rssMBPs: postPs?.rssMB ?? null,
			rssMBStatus: postStatus?.memory?.rssMB ?? null,
			heapUsedMBStatus: postStatus?.memory?.heapUsedMB ?? null,
			externalMBStatus: postStatus?.memory?.externalMB ?? null,
			indexingStatus: postStatus?.indexing?.status ?? null,
		},
		postDelayed: {
			rssMBStatus: postDelayStatus?.memory?.rssMB ?? null,
			heapUsedMBStatus: postDelayStatus?.memory?.heapUsedMB ?? null,
			externalMBStatus: postDelayStatus?.memory?.externalMB ?? null,
		},
		cleanupBefore,
		cleanupAfter,
		vmmapSummary,
		error,
	};

	summary.push(row);
	console.log(JSON.stringify(row));
	await writeRow(row);
}

const final = {
	ts: nowIso(),
	label: 'run.summary',
	outputFile,
	results: summary.map(row => {
		const start =
			Math.max(row.baseline.rssMBPs ?? 0, row.baseline.rssMBStatus ?? 0) || 0;
		const end = Math.max(row.post.rssMBPs ?? 0, row.post.rssMBStatus ?? 0) || 0;
		return {
			intent: row.intent,
			ok: row.search?.ok ?? false,
			searchDurationMs: row.search?.durationMs ?? null,
			searchError: row.search?.error ?? null,
			startMB: start,
			endMB: end,
			growthMB: Number((end - start).toFixed(1)),
		};
	}),
};
console.log(JSON.stringify(final));
await writeRow(final);
