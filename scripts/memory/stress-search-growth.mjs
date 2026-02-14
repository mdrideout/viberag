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

const DURATION_SECONDS = Number(process.env['VIBERAG_STRESS_SECONDS'] ?? '60');
const PARALLELISM = Number(process.env['VIBERAG_STRESS_PARALLELISM'] ?? '24');
const SAMPLE_MS = Number(process.env['VIBERAG_STRESS_SAMPLE_MS'] ?? '500');
const REQUESTED_RESULT_K = Number(process.env['VIBERAG_STRESS_K'] ?? '96');
const RESULT_K = Math.max(1, Math.min(100, REQUESTED_RESULT_K));
const COOLDOWN_SECONDS = Number(
	process.env['VIBERAG_STRESS_COOLDOWN_SECONDS'] ?? '10',
);
const INDEX_CHURN_SECONDS = Number(
	process.env['VIBERAG_STRESS_INDEX_CHURN_SECONDS'] ?? '0',
);
const INDEX_FORCE = process.env['VIBERAG_STRESS_INDEX_FORCE'] === '1';
const MAX_RSS_MB = Number(process.env['VIBERAG_STRESS_MAX_RSS_MB'] ?? '10240');
const SOFT_RSS_MB = Number(
	process.env['VIBERAG_STRESS_SOFT_RSS_MB'] ?? Math.floor(MAX_RSS_MB * 0.8),
);
const MAX_IN_FLIGHT = Math.max(
	1,
	Math.min(
		PARALLELISM,
		Number(process.env['VIBERAG_STRESS_MAX_IN_FLIGHT'] ?? '8'),
	),
);
const RAMP_STEP_MS = Number(
	process.env['VIBERAG_STRESS_RAMP_STEP_MS'] ?? '500',
);
const GUARD_KILL = process.env['VIBERAG_STRESS_GUARD_KILL'] !== '0';
const OUTPUT_DIR = process.env['VIBERAG_STRESS_OUTPUT_DIR']
	? path.resolve(process.env['VIBERAG_STRESS_OUTPUT_DIR'])
	: path.join(REPO_ROOT, 'scripts/memory/out');

if (!Number.isFinite(DURATION_SECONDS) || DURATION_SECONDS <= 0) {
	throw new Error('VIBERAG_STRESS_SECONDS must be > 0');
}
if (!Number.isFinite(PARALLELISM) || PARALLELISM <= 0) {
	throw new Error('VIBERAG_STRESS_PARALLELISM must be > 0');
}
if (!Number.isFinite(SAMPLE_MS) || SAMPLE_MS < 100) {
	throw new Error('VIBERAG_STRESS_SAMPLE_MS must be >= 100');
}
if (!Number.isFinite(MAX_RSS_MB) || MAX_RSS_MB <= 0) {
	throw new Error('VIBERAG_STRESS_MAX_RSS_MB must be > 0');
}
if (
	!Number.isFinite(SOFT_RSS_MB) ||
	SOFT_RSS_MB <= 0 ||
	SOFT_RSS_MB > MAX_RSS_MB
) {
	throw new Error(
		'VIBERAG_STRESS_SOFT_RSS_MB must be > 0 and <= VIBERAG_STRESS_MAX_RSS_MB',
	);
}
if (!Number.isFinite(MAX_IN_FLIGHT) || MAX_IN_FLIGHT <= 0) {
	throw new Error('VIBERAG_STRESS_MAX_IN_FLIGHT must be > 0');
}
if (!Number.isFinite(RAMP_STEP_MS) || RAMP_STEP_MS < 100) {
	throw new Error('VIBERAG_STRESS_RAMP_STEP_MS must be >= 100');
}

const QUERY_POOL = [
	'indexing memory lifecycle ownership contract cleanup',
	'lancedb upsert pipeline flush batch rollback idempotent',
	'chunker parse tree wasm parser close release resources',
	'search engine warmup embeddings cache memory pressure',
	'watcher pending changes indexing throttling backpressure',
	'daemon status rss heap external telemetry sentry threshold',
	'merkle tree hashing file change detection incremental',
	'find_references symbol usage expansion surrounding code',
	'exact_text throwIfAborted error path cleanup finally',
	'semantic search hybrid vector fts ranking explain',
	'storage close table handles connection lifecycle',
	'indexAsync status cancel operation indexing phase',
	'grammar smoke parser initialization teardown',
	'embedding provider batch retry limits slot state',
	'project manifest persistence resume startup checks',
	'memory regression test chunker repeated analyzeFile',
	'indexing memory regression repeated force runs',
	'request_id telemetry operation boundaries mcp source',
	'reindex required schema compatibility manifest version',
	'daemon owner state machine transitions indexing warmup',
];

const INTENTS = ['concept', 'usage', 'definition', 'exact_text', 'auto'];

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
	return new Date().toISOString();
}

function compactError(error) {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}
	return String(error);
}

function mbFromKb(value) {
	return Number((value / 1024).toFixed(1));
}

async function withTimeout(promise, timeoutMs, label) {
	const timeout = new Promise((_, reject) => {
		setTimeout(
			() => reject(new Error(`timeout:${label}:${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]);
}

async function findDaemonProcess() {
	const {stdout} = await execFile('ps', [
		'-axo',
		'pid=,rss=,vsz=,%cpu=,%mem=,state=,etime=,command=',
	]);
	const lines = stdout.split('\n');
	for (const line of lines) {
		if (!line.includes(DAEMON_ENTRY)) {
			continue;
		}
		const match = line.match(
			/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(.+)$/,
		);
		if (!match) {
			continue;
		}
		return {
			pid: Number(match[1]),
			rssMB: mbFromKb(Number(match[2])),
			vszMB: mbFromKb(Number(match[3])),
			cpuPercent: Number(match[4]),
			memPercent: Number(match[5]),
			state: match[6],
			etime: match[7],
		};
	}
	return null;
}

function addErrorBucket(state, error) {
	const key = compactError(error).slice(0, 220);
	const current = state.errorBuckets.get(key) ?? 0;
	state.errorBuckets.set(key, current + 1);
}

function topErrorBuckets(state, limit = 10) {
	return [...state.errorBuckets.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([error, count]) => ({error, count}));
}

function summarizeSamples(samples) {
	const observed = samples
		.map(sample => sample.observedRssMB)
		.filter(Number.isFinite);
	const statusRss = samples
		.map(sample => sample.rssMBStatus)
		.filter(Number.isFinite);
	const psRss = samples.map(sample => sample.rssMBPs).filter(Number.isFinite);
	if (observed.length === 0) {
		return null;
	}
	return {
		observedStartMB: observed[0],
		observedEndMB: observed.at(-1),
		observedPeakMB: Math.max(...observed),
		observedGrowthMB: Number((observed.at(-1) - observed[0]).toFixed(1)),
		statusPeakMB: statusRss.length > 0 ? Math.max(...statusRss) : null,
		psPeakMB: psRss.length > 0 ? Math.max(...psRss) : null,
	};
}

const {DaemonClient} = await import(
	path.join(REPO_ROOT, 'dist/client/index.js')
);
const client = new DaemonClient({
	projectRoot: REPO_ROOT,
	autoStart: true,
	connectTimeout: 30_000,
	clientSource: 'mcp',
});

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputFile = path.join(OUTPUT_DIR, `stress-search-growth-${runId}.jsonl`);

const state = {
	stop: false,
	stopReason: null,
	completed: 0,
	failed: 0,
	inFlight: 0,
	currentInFlightLimit: 1,
	maxObservedInFlight: 0,
	indexRequests: 0,
	totalLatencyMs: 0,
	maxLatencyMs: 0,
	lastError: null,
	lastObservedRssMB: null,
	lastSeenPid: null,
	errorBuckets: new Map(),
	guardTriggered: false,
	guardTriggeredAt: null,
	guardObservedRssMB: null,
	guardKind: null,
	guardCancelError: null,
	guardShutdownError: null,
	guardKillError: null,
};

const samples = [];

async function writeRow(row) {
	await fs.appendFile(outputFile, `${JSON.stringify(row)}\n`, 'utf8');
}

async function triggerGuard(kind, row) {
	if (state.guardTriggered) {
		return;
	}
	state.guardTriggered = true;
	state.guardTriggeredAt = row.ts;
	state.guardObservedRssMB = row.observedRssMB;
	state.guardKind = kind;
	state.stop = true;
	state.stopReason = `${kind}_guard`;
	row.guardTriggered = true;
	row.guardKind = kind;

	try {
		await withTimeout(
			client.cancel({
				target: 'all',
				reason: `${kind} guard triggered at ${row.observedRssMB}MB`,
			}),
			1200,
			'cancel',
		);
	} catch (error) {
		state.guardCancelError = compactError(error);
		addErrorBucket(state, error);
	}

	try {
		await withTimeout(
			client.shutdown(`${kind} memory guard requested shutdown`),
			1200,
			'shutdown',
		);
	} catch (error) {
		state.guardShutdownError = compactError(error);
		addErrorBucket(state, error);
	}

	if (GUARD_KILL && Number.isInteger(state.lastSeenPid)) {
		try {
			process.kill(state.lastSeenPid, 'SIGTERM');
		} catch (error) {
			state.guardKillError = compactError(error);
			addErrorBucket(state, error);
		}
	}
}

async function sample(label, elapsedSec) {
	let status = null;
	let statusError = null;
	try {
		status = await client.status();
	} catch (error) {
		statusError = compactError(error);
		addErrorBucket(state, error);
	}

	let psSample = null;
	let psError = null;
	try {
		psSample = await findDaemonProcess();
	} catch (error) {
		psError = compactError(error);
		addErrorBucket(state, error);
	}

	const slots = Array.isArray(status?.slots) ? status.slots : [];
	const failures = Array.isArray(status?.failures) ? status.failures : [];
	const row = {
		ts: nowIso(),
		label,
		elapsedSec,
		pid: psSample?.pid ?? null,
		rssMBPs: psSample?.rssMB ?? null,
		vszMBPs: psSample?.vszMB ?? null,
		cpuPercentPs: psSample?.cpuPercent ?? null,
		memPercentPs: psSample?.memPercent ?? null,
		processStatePs: psSample?.state ?? null,
		processEtimePs: psSample?.etime ?? null,
		rssMBStatus: status?.memory?.rssMB ?? null,
		heapUsedMB: status?.memory?.heapUsedMB ?? null,
		externalMB: status?.memory?.externalMB ?? null,
		arrayBuffersMB: status?.memory?.arrayBuffersMB ?? null,
		indexingStatus: status?.indexing?.status ?? null,
		indexingPhase: status?.indexing?.phase ?? null,
		indexingStage: status?.indexing?.stage ?? null,
		indexingCurrent: status?.indexing?.current ?? null,
		indexingTotal: status?.indexing?.total ?? null,
		warmupStatus: status?.warmupStatus ?? null,
		slotsTotal: slots.length,
		slotsBusy: slots.filter(slot => slot.state !== 'idle').length,
		slotsRateLimited: slots.filter(slot => slot.state === 'rate-limited')
			.length,
		failuresCount: failures.length,
		completedSearches: state.completed,
		failedSearches: state.failed,
		inFlightSearches: state.inFlight,
		inFlightLimit: state.currentInFlightLimit,
		indexRequests: state.indexRequests,
		lastError: state.lastError,
		statusError,
		psError,
	};

	if (Number.isInteger(psSample?.pid)) {
		state.lastSeenPid = psSample.pid;
	}

	const observedCandidates = [row.rssMBPs, row.rssMBStatus].filter(
		Number.isFinite,
	);
	row.observedRssMB =
		observedCandidates.length > 0
			? Number(Math.max(...observedCandidates).toFixed(1))
			: null;
	if (Number.isFinite(row.observedRssMB)) {
		state.lastObservedRssMB = row.observedRssMB;
	}

	if (!state.guardTriggered && Number.isFinite(row.observedRssMB)) {
		if (row.observedRssMB >= MAX_RSS_MB) {
			await triggerGuard('hard', row);
		} else if (row.observedRssMB >= SOFT_RSS_MB) {
			await triggerGuard('soft', row);
		}
	}

	samples.push(row);
	await writeRow(row);
	console.log(JSON.stringify(row));
}

async function runRamp(deadlineMs) {
	while (
		!state.stop &&
		Date.now() < deadlineMs &&
		state.currentInFlightLimit < MAX_IN_FLIGHT
	) {
		await sleep(RAMP_STEP_MS);
		if (state.stop) {
			break;
		}
		state.currentInFlightLimit = Math.min(
			MAX_IN_FLIGHT,
			state.currentInFlightLimit + 1,
		);
	}
}

async function runWorker(workerId, deadlineMs) {
	let iteration = 0;
	while (!state.stop && Date.now() < deadlineMs) {
		while (
			!state.stop &&
			Date.now() < deadlineMs &&
			state.inFlight >= state.currentInFlightLimit
		) {
			await sleep(10);
		}
		if (state.stop || Date.now() >= deadlineMs) {
			break;
		}

		const intent = INTENTS[(workerId + iteration) % INTENTS.length];
		const base = QUERY_POOL[(workerId + iteration) % QUERY_POOL.length];
		const query = `${base} worker:${workerId} iter:${iteration} nonce:${Date.now().toString(36)}`;
		const started = Date.now();

		state.inFlight += 1;
		state.maxObservedInFlight = Math.max(
			state.maxObservedInFlight,
			state.inFlight,
		);
		try {
			await client.search(query, {
				intent,
				k: RESULT_K,
				explain: true,
			});
			const latency = Date.now() - started;
			state.completed += 1;
			state.totalLatencyMs += latency;
			state.maxLatencyMs = Math.max(state.maxLatencyMs, latency);
		} catch (error) {
			state.failed += 1;
			state.lastError = compactError(error);
			addErrorBucket(state, error);
			await sleep(25);
		} finally {
			state.inFlight = Math.max(0, state.inFlight - 1);
		}
		iteration += 1;
	}
}

async function runIndexChurn(deadlineMs) {
	if (!Number.isFinite(INDEX_CHURN_SECONDS) || INDEX_CHURN_SECONDS <= 0) {
		return;
	}
	const intervalMs = INDEX_CHURN_SECONDS * 1000;
	while (!state.stop && Date.now() < deadlineMs) {
		await sleep(intervalMs);
		if (state.stop || Date.now() >= deadlineMs) {
			break;
		}
		try {
			await client.indexAsync({force: INDEX_FORCE});
			state.indexRequests += 1;
		} catch (error) {
			state.lastError = compactError(error);
			addErrorBucket(state, error);
		}
	}
}

await fs.mkdir(OUTPUT_DIR, {recursive: true});
await fs.writeFile(outputFile, '', 'utf8');
await client.connect();

const startedAt = Date.now();
const deadlineMs = startedAt + DURATION_SECONDS * 1000;

const header = {
	ts: nowIso(),
	label: 'run.start',
	durationSeconds: DURATION_SECONDS,
	parallelism: PARALLELISM,
	sampleMs: SAMPLE_MS,
	requestedResultK: REQUESTED_RESULT_K,
	resultK: RESULT_K,
	maxRssMB: MAX_RSS_MB,
	softRssMB: SOFT_RSS_MB,
	maxInFlight: MAX_IN_FLIGHT,
	rampStepMs: RAMP_STEP_MS,
	guardKill: GUARD_KILL,
	cooldownSeconds: COOLDOWN_SECONDS,
	indexChurnSeconds: INDEX_CHURN_SECONDS,
	indexForce: INDEX_FORCE,
	outputFile,
};
await writeRow(header);
console.log(JSON.stringify(header));

if (REQUESTED_RESULT_K !== RESULT_K) {
	console.log(
		JSON.stringify({
			ts: nowIso(),
			label: 'run.note',
			note: `clamped resultK from ${REQUESTED_RESULT_K} to ${RESULT_K} (daemon max is 100)`,
		}),
	);
}

await sample('baseline', 0);

const ramp = runRamp(deadlineMs);
const workers = Array.from({length: PARALLELISM}, (_, workerId) =>
	runWorker(workerId, deadlineMs),
);
const churn = runIndexChurn(deadlineMs);

while (Date.now() < deadlineMs && !state.stop) {
	await sleep(SAMPLE_MS);
	const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
	await sample('active', elapsedSec);
}

if (!state.stopReason) {
	state.stopReason = 'duration_complete';
}
state.stop = true;

const workerSettled = await Promise.race([
	Promise.allSettled([...workers, churn, ramp]).then(() => true),
	sleep(20_000).then(() => false),
]);

await sample(
	'post.active',
	Number(((Date.now() - startedAt) / 1000).toFixed(1)),
);

if (COOLDOWN_SECONDS > 0 && !state.guardTriggered) {
	const cooldownEnd = Date.now() + COOLDOWN_SECONDS * 1000;
	while (Date.now() < cooldownEnd) {
		await sleep(SAMPLE_MS);
		const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
		await sample('cooldown', elapsedSec);
	}
}

const avgLatencyMs =
	state.completed > 0
		? Number((state.totalLatencyMs / state.completed).toFixed(1))
		: 0;

const summary = {
	ts: nowIso(),
	label: 'run.summary',
	durationSeconds: DURATION_SECONDS,
	parallelism: PARALLELISM,
	completedSearches: state.completed,
	failedSearches: state.failed,
	indexRequests: state.indexRequests,
	avgLatencyMs,
	maxLatencyMs: state.maxLatencyMs,
	lastError: state.lastError,
	stopReason: state.stopReason,
	workersSettled: workerSettled,
	inFlightAtEnd: state.inFlight,
	maxObservedInFlight: state.maxObservedInFlight,
	guardTriggered: state.guardTriggered,
	guardKind: state.guardKind,
	guardTriggeredAt: state.guardTriggeredAt,
	guardObservedRssMB: state.guardObservedRssMB,
	guardCancelError: state.guardCancelError,
	guardShutdownError: state.guardShutdownError,
	guardKillError: state.guardKillError,
	errorBuckets: topErrorBuckets(state, 10),
	memory: summarizeSamples(samples),
	outputFile,
};
await writeRow(summary);
console.log(JSON.stringify(summary));

await client.disconnect().catch(() => {});
