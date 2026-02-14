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

const DURATION_SECONDS = Number(
	process.env['VIBERAG_WATCH_STRESS_SECONDS'] ?? '60',
);
const WRITER_COUNT = Number(
	process.env['VIBERAG_WATCH_STRESS_WRITERS'] ?? '48',
);
const FILE_COUNT = Number(process.env['VIBERAG_WATCH_STRESS_FILES'] ?? '96');
const WRITE_INTERVAL_MS = Number(
	process.env['VIBERAG_WATCH_STRESS_WRITE_INTERVAL_MS'] ?? '0',
);
const SAMPLE_MS = Number(
	process.env['VIBERAG_WATCH_STRESS_SAMPLE_MS'] ?? '500',
);
const CONTENT_KB = Number(
	process.env['VIBERAG_WATCH_STRESS_CONTENT_KB'] ?? '2',
);
const COOLDOWN_SECONDS = Number(
	process.env['VIBERAG_WATCH_STRESS_COOLDOWN_SECONDS'] ?? '10',
);
const CLEANUP_SETTLE_SECONDS = Number(
	process.env['VIBERAG_WATCH_STRESS_CLEANUP_SETTLE_SECONDS'] ?? '8',
);
const MAX_RSS_MB = Number(
	process.env['VIBERAG_WATCH_STRESS_MAX_RSS_MB'] ?? '10240',
);
const SOFT_RSS_MB = Number(
	process.env['VIBERAG_WATCH_STRESS_SOFT_RSS_MB'] ??
		Math.floor(MAX_RSS_MB * 0.8),
);
const GUARD_KILL = process.env['VIBERAG_WATCH_STRESS_GUARD_KILL'] !== '0';
const CLEAN_START = process.env['VIBERAG_WATCH_STRESS_CLEAN_START'] !== '0';
const TARGET_DIR_REL =
	process.env['VIBERAG_WATCH_STRESS_TARGET_DIR'] ??
	'source/daemon/__watch_stress_probe';
const TARGET_DIR = path.resolve(REPO_ROOT, TARGET_DIR_REL);
const OUTPUT_DIR = process.env['VIBERAG_WATCH_STRESS_OUTPUT_DIR']
	? path.resolve(process.env['VIBERAG_WATCH_STRESS_OUTPUT_DIR'])
	: path.join(REPO_ROOT, 'scripts/memory/out');

if (!Number.isFinite(DURATION_SECONDS) || DURATION_SECONDS <= 0) {
	throw new Error('VIBERAG_WATCH_STRESS_SECONDS must be > 0');
}
if (!Number.isFinite(WRITER_COUNT) || WRITER_COUNT <= 0) {
	throw new Error('VIBERAG_WATCH_STRESS_WRITERS must be > 0');
}
if (!Number.isFinite(FILE_COUNT) || FILE_COUNT <= 0) {
	throw new Error('VIBERAG_WATCH_STRESS_FILES must be > 0');
}
if (!Number.isFinite(WRITE_INTERVAL_MS) || WRITE_INTERVAL_MS < 0) {
	throw new Error('VIBERAG_WATCH_STRESS_WRITE_INTERVAL_MS must be >= 0');
}
if (!Number.isFinite(SAMPLE_MS) || SAMPLE_MS < 100) {
	throw new Error('VIBERAG_WATCH_STRESS_SAMPLE_MS must be >= 100');
}
if (!Number.isFinite(CONTENT_KB) || CONTENT_KB < 0.25) {
	throw new Error('VIBERAG_WATCH_STRESS_CONTENT_KB must be >= 0.25');
}
if (!Number.isFinite(COOLDOWN_SECONDS) || COOLDOWN_SECONDS < 0) {
	throw new Error('VIBERAG_WATCH_STRESS_COOLDOWN_SECONDS must be >= 0');
}
if (!Number.isFinite(CLEANUP_SETTLE_SECONDS) || CLEANUP_SETTLE_SECONDS < 0) {
	throw new Error('VIBERAG_WATCH_STRESS_CLEANUP_SETTLE_SECONDS must be >= 0');
}
if (!Number.isFinite(MAX_RSS_MB) || MAX_RSS_MB <= 0) {
	throw new Error('VIBERAG_WATCH_STRESS_MAX_RSS_MB must be > 0');
}
if (
	!Number.isFinite(SOFT_RSS_MB) ||
	SOFT_RSS_MB <= 0 ||
	SOFT_RSS_MB > MAX_RSS_MB
) {
	throw new Error(
		'VIBERAG_WATCH_STRESS_SOFT_RSS_MB must be > 0 and <= VIBERAG_WATCH_STRESS_MAX_RSS_MB',
	);
}

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

async function listDaemonRows() {
	const {stdout} = await execFile('ps', [
		'-axo',
		'pid=,rss=,vsz=,%cpu=,%mem=,state=,etime=,command=',
	]);
	const rows = [];
	for (const line of stdout.split('\n')) {
		if (!line.includes(DAEMON_ENTRY)) {
			continue;
		}
		const match = line.match(
			/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(.+)$/,
		);
		if (!match) {
			continue;
		}
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

async function findDaemonProcess() {
	const rows = await listDaemonRows();
	return rows[0] ?? null;
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

function addErrorBucket(state, error) {
	const key = compactError(error).slice(0, 220);
	state.errorBuckets.set(key, (state.errorBuckets.get(key) ?? 0) + 1);
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
	const pendingChanges = samples
		.map(sample => sample.watcherPendingChanges)
		.filter(Number.isFinite);

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
		pendingPeak: pendingChanges.length > 0 ? Math.max(...pendingChanges) : null,
	};
}

const {DaemonClient} = await import(
	path.join(REPO_ROOT, 'dist/client/index.js')
);
const client = new DaemonClient({
	projectRoot: REPO_ROOT,
	autoStart: true,
	connectTimeout: 30_000,
	clientSource: 'unknown',
});

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputFile = path.join(OUTPUT_DIR, `watch-reindex-stress-${runId}.jsonl`);

const state = {
	stop: false,
	stopReason: null,
	writesAttempted: 0,
	writesSucceeded: 0,
	writesFailed: 0,
	activeWriters: 0,
	maxActiveWriters: 0,
	guardTriggered: false,
	guardKind: null,
	guardTriggeredAt: null,
	guardObservedRssMB: null,
	guardCancelError: null,
	guardShutdownError: null,
	guardKillError: null,
	lastSeenPid: null,
	lastObservedRssMB: null,
	lastIndexUpdate: null,
	indexUpdatesObserved: 0,
	maxPendingChanges: 0,
	indexingBusySamples: 0,
	lastError: null,
	errorBuckets: new Map(),
};

const samples = [];
const targetContentBytes = Math.max(256, Math.round(CONTENT_KB * 1024));
const fillerSeed = 'x'.repeat(Math.max(0, targetContentBytes));

async function writeRow(row) {
	await fs.appendFile(outputFile, `${JSON.stringify(row)}\n`, 'utf8');
}

async function triggerGuard(kind, row) {
	if (state.guardTriggered) {
		return;
	}
	state.guardTriggered = true;
	state.guardKind = kind;
	state.guardTriggeredAt = row.ts;
	state.guardObservedRssMB = row.observedRssMB;
	state.stopReason = `${kind}_guard`;
	state.stop = true;
	row.guardTriggered = true;
	row.guardKind = kind;

	try {
		await withTimeout(
			client.cancel({
				target: 'all',
				reason: `${kind} watch stress guard triggered at ${row.observedRssMB}MB`,
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
			client.shutdown(`${kind} watch stress guard requested shutdown`),
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

	const lastIndexUpdate = status?.watcherStatus?.lastIndexUpdate ?? null;
	if (typeof lastIndexUpdate === 'string' && lastIndexUpdate.length > 0) {
		if (lastIndexUpdate !== state.lastIndexUpdate) {
			state.indexUpdatesObserved += 1;
		}
		state.lastIndexUpdate = lastIndexUpdate;
	}

	const pendingChanges = status?.watcherStatus?.pendingChanges ?? null;
	if (Number.isFinite(pendingChanges)) {
		state.maxPendingChanges = Math.max(state.maxPendingChanges, pendingChanges);
	}

	const indexingStatus = status?.indexing?.status ?? null;
	if (
		indexingStatus === 'initializing' ||
		indexingStatus === 'indexing' ||
		indexingStatus === 'cancelling'
	) {
		state.indexingBusySamples += 1;
	}

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
		heapUsedMBStatus: status?.memory?.heapUsedMB ?? null,
		externalMBStatus: status?.memory?.externalMB ?? null,
		arrayBuffersMBStatus: status?.memory?.arrayBuffersMB ?? null,
		watcherWatching: status?.watcherStatus?.watching ?? null,
		watcherFilesWatched: status?.watcherStatus?.filesWatched ?? null,
		watcherPendingChanges: pendingChanges,
		watcherLastIndexUpdate: lastIndexUpdate,
		watcherIndexUpToDate: status?.watcherStatus?.indexUpToDate ?? null,
		watcherLastError: status?.watcherStatus?.lastError ?? null,
		watcherAutoIndexPausedUntil:
			status?.watcherStatus?.autoIndexPausedUntil ?? null,
		indexingStatus,
		indexingPhase: status?.indexing?.phase ?? null,
		indexingStage: status?.indexing?.stage ?? null,
		indexingCurrent: status?.indexing?.current ?? null,
		indexingTotal: status?.indexing?.total ?? null,
		indexingLastCompleted: status?.indexing?.lastCompleted ?? null,
		indexingLastFilesIndexed: status?.indexing?.lastStats?.filesIndexed ?? null,
		indexingLastChunkRowsUpserted:
			status?.indexing?.lastStats?.chunkRowsUpserted ?? null,
		indexingLastChunkRowsDeleted:
			status?.indexing?.lastStats?.chunkRowsDeleted ?? null,
		indexUpdatesObserved: state.indexUpdatesObserved,
		writesAttempted: state.writesAttempted,
		writesSucceeded: state.writesSucceeded,
		writesFailed: state.writesFailed,
		activeWriters: state.activeWriters,
		maxActiveWriters: state.maxActiveWriters,
		statusError,
		psError,
		lastError: state.lastError,
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

function buildFileContent(fileIndex, writerId, iteration) {
	const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const head = [
		'// Auto-generated watcher reindex stress probe. Safe to delete.',
		`export const WATCH_STRESS_FILE_${fileIndex} = ${iteration};`,
		`export const WATCH_STRESS_WRITER_${fileIndex} = ${writerId};`,
		`export const WATCH_STRESS_STAMP_${fileIndex} = '${stamp}';`,
	].join('\n');
	const baseBytes = Buffer.byteLength(head, 'utf8') + 8;
	const fillerLength = Math.max(0, targetContentBytes - baseBytes);
	const filler = fillerSeed.slice(0, fillerLength);
	return `${head}\n/*${filler}*/\n`;
}

async function runWriter(writerId, filePaths, deadlineMs) {
	let iteration = 0;
	state.activeWriters += 1;
	state.maxActiveWriters = Math.max(
		state.maxActiveWriters,
		state.activeWriters,
	);
	try {
		while (!state.stop && Date.now() < deadlineMs) {
			const fileIndex = (writerId + iteration) % filePaths.length;
			const filePath = filePaths[fileIndex];
			state.writesAttempted += 1;

			try {
				await fs.writeFile(
					filePath,
					buildFileContent(fileIndex, writerId, iteration),
					'utf8',
				);
				state.writesSucceeded += 1;
			} catch (error) {
				state.writesFailed += 1;
				state.lastError = compactError(error);
				addErrorBucket(state, error);
				await sleep(5);
			}

			iteration += 1;
			if (WRITE_INTERVAL_MS > 0) {
				await sleep(WRITE_INTERVAL_MS);
			}
		}
	} finally {
		state.activeWriters = Math.max(0, state.activeWriters - 1);
	}
}

async function waitForWatcherReady(maxMs = 30_000) {
	const started = Date.now();
	while (Date.now() - started < maxMs) {
		try {
			const status = await client.status();
			if (status?.watcherStatus?.watching) {
				return status;
			}
		} catch {}
		await sleep(200);
	}
	throw new Error('watcher did not become active before timeout');
}

let restartInfo = null;
let cleanupError = null;
let cleanupSucceeded = false;

try {
	await fs.mkdir(OUTPUT_DIR, {recursive: true});
	await fs.writeFile(outputFile, '', 'utf8');

	if (CLEAN_START) {
		restartInfo = await killDaemonProcesses();
	}

	await fs.rm(TARGET_DIR, {recursive: true, force: true});
	await fs.mkdir(TARGET_DIR, {recursive: true});
	const probeFiles = Array.from({length: FILE_COUNT}, (_, index) =>
		path.join(TARGET_DIR, `probe-${index}.ts`),
	);
	await Promise.all(
		probeFiles.map((filePath, index) =>
			fs.writeFile(filePath, buildFileContent(index, -1, 0), 'utf8'),
		),
	);

	await withTimeout(client.connect(), 30_000, 'connect');
	const readyStatus = await withTimeout(
		waitForWatcherReady(),
		30_000,
		'watcher',
	);
	state.lastIndexUpdate = readyStatus?.watcherStatus?.lastIndexUpdate ?? null;

	const startedAt = Date.now();
	const deadlineMs = startedAt + DURATION_SECONDS * 1000;

	const header = {
		ts: nowIso(),
		label: 'run.start',
		durationSeconds: DURATION_SECONDS,
		writerCount: WRITER_COUNT,
		fileCount: FILE_COUNT,
		writeIntervalMs: WRITE_INTERVAL_MS,
		sampleMs: SAMPLE_MS,
		contentKB: CONTENT_KB,
		maxRssMB: MAX_RSS_MB,
		softRssMB: SOFT_RSS_MB,
		guardKill: GUARD_KILL,
		cleanStart: CLEAN_START,
		targetDir: TARGET_DIR_REL,
		cooldownSeconds: COOLDOWN_SECONDS,
		cleanupSettleSeconds: CLEANUP_SETTLE_SECONDS,
		restartInfo,
		outputFile,
	};
	await writeRow(header);
	console.log(JSON.stringify(header));

	await sample('baseline', 0);

	const writers = Array.from({length: WRITER_COUNT}, (_, writerId) =>
		runWriter(writerId, probeFiles, deadlineMs),
	);

	while (Date.now() < deadlineMs && !state.stop) {
		await sleep(SAMPLE_MS);
		const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
		await sample('active', elapsedSec);
	}

	if (!state.stopReason) {
		state.stopReason = 'duration_complete';
	}
	state.stop = true;

	const writersSettled = await Promise.race([
		Promise.allSettled(writers).then(() => true),
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

	try {
		await fs.rm(TARGET_DIR, {recursive: true, force: true});
		cleanupSucceeded = true;
		await sample(
			'cleanup.delete',
			Number(((Date.now() - startedAt) / 1000).toFixed(1)),
		);
	} catch (error) {
		cleanupError = compactError(error);
	}

	if (CLEANUP_SETTLE_SECONDS > 0 && !state.guardTriggered) {
		const settleEnd = Date.now() + CLEANUP_SETTLE_SECONDS * 1000;
		while (Date.now() < settleEnd) {
			await sleep(SAMPLE_MS);
			const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
			await sample('cleanup.settle', elapsedSec);
		}
	}

	const writesPerSecond =
		DURATION_SECONDS > 0
			? Number((state.writesSucceeded / DURATION_SECONDS).toFixed(1))
			: null;

	const summary = {
		ts: nowIso(),
		label: 'run.summary',
		durationSeconds: DURATION_SECONDS,
		writerCount: WRITER_COUNT,
		fileCount: FILE_COUNT,
		writesAttempted: state.writesAttempted,
		writesSucceeded: state.writesSucceeded,
		writesFailed: state.writesFailed,
		writesPerSecond,
		indexUpdatesObserved: state.indexUpdatesObserved,
		maxPendingChanges: state.maxPendingChanges,
		indexingBusySamples: state.indexingBusySamples,
		stopReason: state.stopReason,
		writersSettled,
		guardTriggered: state.guardTriggered,
		guardKind: state.guardKind,
		guardTriggeredAt: state.guardTriggeredAt,
		guardObservedRssMB: state.guardObservedRssMB,
		guardCancelError: state.guardCancelError,
		guardShutdownError: state.guardShutdownError,
		guardKillError: state.guardKillError,
		cleanupSucceeded,
		cleanupError,
		lastError: state.lastError,
		errorBuckets: topErrorBuckets(state, 10),
		memory: summarizeSamples(samples),
		outputFile,
	};
	await writeRow(summary);
	console.log(JSON.stringify(summary));

	try {
		await withTimeout(
			client.shutdown('watch reindex stress script complete'),
			2000,
			'shutdown',
		);
	} catch (error) {
		const row = {
			ts: nowIso(),
			label: 'shutdown.error',
			error: compactError(error),
		};
		await writeRow(row);
		console.log(JSON.stringify(row));
	}
} finally {
	try {
		await fs.rm(TARGET_DIR, {recursive: true, force: true});
	} catch {}
	await client.disconnect().catch(() => {});
}
