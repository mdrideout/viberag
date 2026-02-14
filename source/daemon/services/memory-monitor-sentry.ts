import crypto from 'node:crypto';
import type {DaemonState} from '../state.js';
import type {WatcherStatus} from './watcher.js';
import type {MemoryMonitorReport} from './memory-monitor.js';
import type {
	SentryCaptureContext,
	SentryEventLevel,
} from '../lib/telemetry/sentry.js';

const BYTES_PER_MB = 1024 * 1024;

function toMB(bytes: number): number {
	return Number((bytes / BYTES_PER_MB).toFixed(1));
}

function sha256Hex(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex');
}

export interface MemoryMonitorProcessSnapshot {
	pid: number;
	uptimeSec: number;
	nodeVersion: string;
	platform: string;
	arch: string;
	resourceUsage: NodeJS.ResourceUsage;
}

export interface BuildMemoryMonitorSentryEventArgs {
	report: MemoryMonitorReport;
	state: DaemonState;
	watcherStatus: WatcherStatus;
	projectRoot: string;
	nowMs?: number;
	processSnapshot?: MemoryMonitorProcessSnapshot;
}

export interface MemoryMonitorSentryEvent {
	message: string;
	level: SentryEventLevel;
	fingerprint: string[];
	tags: Record<string, string>;
	contexts: Record<string, Record<string, unknown>>;
	extra: Record<string, unknown>;
	triggerSummary: string;
	rssMB: number;
}

function buildDefaultProcessSnapshot(): MemoryMonitorProcessSnapshot {
	return {
		pid: process.pid,
		uptimeSec: Math.round(process.uptime()),
		nodeVersion: process.version,
		platform: process.platform,
		arch: process.arch,
		resourceUsage: process.resourceUsage(),
	};
}

export function buildMemoryMonitorSentryEvent(
	args: BuildMemoryMonitorSentryEventArgs,
): MemoryMonitorSentryEvent {
	const nowMs = args.nowMs ?? Date.now();
	const processSnapshot = args.processSnapshot ?? buildDefaultProcessSnapshot();
	const {report, state, watcherStatus} = args;

	const lastProgressAtMs = state.indexing.lastProgressAt
		? new Date(state.indexing.lastProgressAt).getTime()
		: null;
	const indexingElapsedMs = state.indexing.startedAt
		? Math.max(0, nowMs - new Date(state.indexing.startedAt).getTime())
		: null;
	const secondsSinceProgress =
		lastProgressAtMs === null
			? null
			: Math.max(0, Math.round((nowMs - lastProgressAtMs) / 1000));
	const slotSummary = state.slots.reduce(
		(acc, slot) => {
			acc[slot.state] += 1;
			return acc;
		},
		{
			idle: 0,
			processing: 0,
			'rate-limited': 0,
		},
	);
	const triggerKinds = Array.from(
		new Set(report.triggers.map(trigger => trigger.kind)),
	).sort();
	const triggerSummary = triggerKinds.join(',');
	const triggerFingerprint = triggerKinds.join('+') || 'none';
	const rssMB = toMB(report.usage.rss);
	const rootHash = sha256Hex(args.projectRoot);

	return {
		message: 'Daemon memory monitor alert',
		level: 'error',
		fingerprint: ['viberag', 'daemon', 'memory-monitor', triggerFingerprint],
		tags: {
			service: 'daemon',
			event: 'memory_monitor_alert',
			trigger_threshold: triggerKinds.includes('threshold') ? 'true' : 'false',
			trigger_rapid_growth: triggerKinds.includes('rapid_growth')
				? 'true'
				: 'false',
			indexing_status: state.indexing.status,
			warmup_status: state.warmup.status,
		},
		contexts: {
			memory_usage: {
				rssMB,
				heapUsedMB: toMB(report.usage.heapUsed),
				heapTotalMB: toMB(report.usage.heapTotal),
				externalMB: toMB(report.usage.external),
				arrayBuffersMB: toMB(report.usage.arrayBuffers),
			},
			monitor: {
				triggerKinds: triggerSummary,
				thresholdMB: report.threshold.thresholdMB,
				recoveryMB: report.threshold.recoveryMB,
				growthThresholdMB: report.config.growthThresholdMB,
				growthWindowSec: report.config.growthWindowSec,
				minReportIntervalSec: report.config.minReportIntervalSec,
				maxReportsPerDay: report.config.maxReportsPerDay,
				sentToday: report.rateLimit.sentToday,
				lastReportedAt: report.rateLimit.lastReportedAt,
			},
			indexing: {
				status: state.indexing.status,
				phase: state.indexing.phase,
				stage: state.indexing.stage,
				current: state.indexing.current,
				total: state.indexing.total,
				unit: state.indexing.unit,
				chunksProcessed: state.indexing.chunksProcessed,
				elapsedMs: indexingElapsedMs,
				secondsSinceProgress,
			},
			warmup: {
				status: state.warmup.status,
				provider: state.warmup.provider,
				startedAt: state.warmup.startedAt,
				readyAt: state.warmup.readyAt,
				error: state.warmup.error,
			},
			process: {
				pid: processSnapshot.pid,
				uptimeSec: processSnapshot.uptimeSec,
				nodeVersion: processSnapshot.nodeVersion,
				platform: processSnapshot.platform,
				arch: processSnapshot.arch,
			},
		},
		extra: {
			observedAt: report.observedAt,
			triggers: report.triggers,
			monitor: {
				threshold: report.threshold,
				growth: report.growth,
				rateLimit: report.rateLimit,
				samples: report.samples,
				config: report.config,
			},
			process: {
				pid: processSnapshot.pid,
				uptimeSec: processSnapshot.uptimeSec,
				nodeVersion: processSnapshot.nodeVersion,
				platform: processSnapshot.platform,
				arch: processSnapshot.arch,
				resourceUsage: processSnapshot.resourceUsage,
			},
			project: {
				rootHash,
			},
			indexing: {
				status: state.indexing.status,
				phase: state.indexing.phase,
				stage: state.indexing.stage,
				current: state.indexing.current,
				total: state.indexing.total,
				unit: state.indexing.unit,
				chunksProcessed: state.indexing.chunksProcessed,
				throttleMessage: state.indexing.throttleMessage,
				error: state.indexing.error,
				startedAt: state.indexing.startedAt,
				lastProgressAt: state.indexing.lastProgressAt,
				elapsedMs: indexingElapsedMs,
				secondsSinceProgress,
				cancelRequestedAt: state.indexing.cancelRequestedAt,
				cancelledAt: state.indexing.cancelledAt,
				cancelReason: state.indexing.cancelReason,
			},
			warmup: {
				status: state.warmup.status,
				provider: state.warmup.provider,
				startedAt: state.warmup.startedAt,
				readyAt: state.warmup.readyAt,
				error: state.warmup.error,
				cancelRequestedAt: state.warmup.cancelRequestedAt,
				cancelledAt: state.warmup.cancelledAt,
				cancelReason: state.warmup.cancelReason,
			},
			watcher: {
				watching: watcherStatus.watching,
				filesWatched: watcherStatus.filesWatched,
				pendingChanges: watcherStatus.pendingChanges,
				pendingPathsSample: watcherStatus.pendingPaths
					.slice(0, 20)
					.map(path => ({
						sha256: sha256Hex(path),
						length: path.length,
					})),
				indexUpToDate: watcherStatus.indexUpToDate,
				lastIndexUpdate: watcherStatus.lastIndexUpdate,
				lastError: watcherStatus.lastError,
				autoIndexPausedUntil: watcherStatus.autoIndexPausedUntil,
				autoIndexPauseReason: watcherStatus.autoIndexPauseReason,
			},
			slots: {
				summary: slotSummary,
				active: state.slots
					.map((slot, index) => ({slot: index, ...slot}))
					.filter(
						slot =>
							slot.state === 'processing' || slot.state === 'rate-limited',
					)
					.slice(0, 20),
			},
			recentFailures: state.failures.slice(-10).map(failure => ({
				batchInfo: failure.batchInfo,
				error: failure.error,
				timestamp: failure.timestamp,
				chunkCount: failure.chunkCount,
				fileCount: failure.files.length,
				fileHashes: failure.files.slice(0, 20).map(filepath => ({
					sha256: sha256Hex(filepath),
					length: filepath.length,
				})),
			})),
		},
		triggerSummary,
		rssMB,
	};
}

export function toSentryCaptureContext(
	event: MemoryMonitorSentryEvent,
): SentryCaptureContext {
	return {
		level: event.level,
		fingerprint: event.fingerprint,
		tags: event.tags,
		contexts: event.contexts,
		extra: event.extra,
	};
}
