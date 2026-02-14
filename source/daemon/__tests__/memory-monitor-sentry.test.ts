import {describe, expect, it} from 'vitest';
import type {DaemonState} from '../state.js';
import type {MemoryMonitorReport} from '../services/memory-monitor.js';
import type {WatcherStatus} from '../services/watcher.js';
import {
	buildMemoryMonitorSentryEvent,
	toSentryCaptureContext,
} from '../services/memory-monitor-sentry.js';

const MB = 1024 * 1024;

function createState(): DaemonState {
	return {
		warmup: {
			status: 'ready',
			provider: 'local',
			error: null,
			startedAt: '2026-02-14T10:00:00.000Z',
			readyAt: '2026-02-14T10:00:05.000Z',
			cancelRequestedAt: null,
			cancelledAt: null,
			cancelReason: null,
		},
		indexing: {
			status: 'indexing',
			phase: 'embed',
			current: 12,
			total: 100,
			unit: 'chunks',
			stage: 'Embedding chunks',
			chunksProcessed: 1200,
			throttleMessage: null,
			error: null,
			startedAt: '2026-02-14T10:01:00.000Z',
			lastCompleted: null,
			lastStats: null,
			lastProgressAt: '2026-02-14T10:01:10.000Z',
			cancelRequestedAt: null,
			cancelledAt: null,
			lastCancelled: null,
			cancelReason: null,
		},
		slots: [
			{state: 'idle', batchInfo: null, retryInfo: null},
			{state: 'processing', batchInfo: 'batch-12', retryInfo: null},
			{state: 'rate-limited', batchInfo: 'batch-11', retryInfo: 'retry in 2s'},
		],
		failures: [
			{
				batchInfo: 'batch-10',
				error: 'timeout',
				timestamp: '2026-02-14T10:00:59.000Z',
				files: ['src/a.ts', 'src/b.ts'],
				chunkCount: 44,
			},
		],
		watcher: {
			watching: true,
			filesWatched: 321,
			pendingChanges: 2,
			lastIndexUpdate: '2026-02-14T10:00:58.000Z',
			indexUpToDate: false,
			autoIndexPausedUntil: null,
			autoIndexPauseReason: null,
		},
	};
}

function createWatcherStatus(): WatcherStatus {
	return {
		watching: true,
		filesWatched: 321,
		pendingChanges: 2,
		pendingPaths: ['src/a.ts', 'src/b.ts'],
		lastIndexUpdate: '2026-02-14T10:00:58.000Z',
		indexUpToDate: false,
		lastError: null,
		autoIndexPausedUntil: null,
		autoIndexPauseReason: null,
	};
}

function createReport(
	triggers: MemoryMonitorReport['triggers'],
): MemoryMonitorReport {
	return {
		observedAt: '2026-02-14T10:01:12.000Z',
		observedAtMs: Date.parse('2026-02-14T10:01:12.000Z'),
		usage: {
			rss: 1536 * MB,
			heapUsed: 320 * MB,
			heapTotal: 640 * MB,
			external: 110 * MB,
			arrayBuffers: 12 * MB,
		},
		triggers,
		threshold: {
			active: true,
			thresholdMB: 1024,
			recoveryMB: 900,
			firstTriggeredAt: '2026-02-14T10:01:00.000Z',
		},
		growth: {
			windowSec: 10,
			sampleCount: 4,
			fromAt: '2026-02-14T10:01:02.000Z',
			toAt: '2026-02-14T10:01:12.000Z',
			fromRssMB: 450,
			toRssMB: 1536,
			minRssMB: 430,
			maxRssMB: 1536,
			growthMB: 1086,
			durationSec: 10,
		},
		rateLimit: {
			dayKey: '2026-02-14',
			sentToday: 2,
			maxReportsPerDay: 20,
			minReportIntervalSec: 10,
			lastReportedAt: '2026-02-14T10:00:50.000Z',
			suppressedByCooldown: 0,
			suppressedByDailyCap: 0,
		},
		samples: {
			retentionSec: 600,
			totalSampleCount: 12,
			recent: [
				{
					at: '2026-02-14T10:01:09.000Z',
					rssMB: 1200,
					heapUsedMB: 300,
					externalMB: 90,
				},
			],
		},
		config: {
			pollIntervalSec: 3,
			thresholdMB: 1024,
			recoveryMB: 900,
			growthThresholdMB: 1024,
			growthWindowSec: 10,
			minReportIntervalSec: 10,
			maxReportsPerDay: 20,
		},
	};
}

describe('buildMemoryMonitorSentryEvent', () => {
	it('uses stable message and fingerprint for threshold alerts', () => {
		const event = buildMemoryMonitorSentryEvent({
			report: createReport([
				{
					kind: 'threshold',
					rssMB: 1536,
					thresholdMB: 1024,
					firstTriggeredAt: '2026-02-14T10:01:00.000Z',
				},
			]),
			state: createState(),
			watcherStatus: createWatcherStatus(),
			projectRoot: '/tmp/project',
			nowMs: Date.parse('2026-02-14T10:01:12.000Z'),
			processSnapshot: {
				pid: 777,
				uptimeSec: 120,
				nodeVersion: 'v20.19.6',
				platform: 'darwin',
				arch: 'arm64',
				resourceUsage: process.resourceUsage(),
			},
		});

		expect(event.message).toBe('Daemon memory monitor alert');
		expect(event.level).toBe('error');
		expect(event.fingerprint).toEqual([
			'viberag',
			'daemon',
			'memory-monitor',
			'threshold',
		]);
		expect(event.tags['event']).toBe('memory_monitor_alert');
		expect(event.tags['trigger_threshold']).toBe('true');
		expect(event.tags['trigger_rapid_growth']).toBe('false');
		expect(event.triggerSummary).toBe('threshold');
		expect(event.rssMB).toBe(1536);
		expect(event.contexts['memory_usage']?.['rssMB']).toBe(1536);
		expect(event.extra['watcher']).toBeTypeOf('object');
		expect(event.extra['slots']).toBeTypeOf('object');
	});

	it('groups combined triggers deterministically', () => {
		const event = buildMemoryMonitorSentryEvent({
			report: createReport([
				{
					kind: 'rapid_growth',
					growthMB: 1086,
					growthThresholdMB: 1024,
					windowSec: 10,
					durationSec: 10,
					fromRssMB: 450,
					toRssMB: 1536,
					fromAt: '2026-02-14T10:01:02.000Z',
					toAt: '2026-02-14T10:01:12.000Z',
				},
				{
					kind: 'threshold',
					rssMB: 1536,
					thresholdMB: 1024,
					firstTriggeredAt: '2026-02-14T10:01:00.000Z',
				},
			]),
			state: createState(),
			watcherStatus: createWatcherStatus(),
			projectRoot: '/tmp/project',
			nowMs: Date.parse('2026-02-14T10:01:12.000Z'),
			processSnapshot: {
				pid: 777,
				uptimeSec: 120,
				nodeVersion: 'v20.19.6',
				platform: 'darwin',
				arch: 'arm64',
				resourceUsage: process.resourceUsage(),
			},
		});

		expect(event.fingerprint).toEqual([
			'viberag',
			'daemon',
			'memory-monitor',
			'rapid_growth+threshold',
		]);
		expect(event.triggerSummary).toBe('rapid_growth,threshold');
		expect(event.tags['trigger_threshold']).toBe('true');
		expect(event.tags['trigger_rapid_growth']).toBe('true');

		const context = toSentryCaptureContext(event);
		expect(context.level).toBe('error');
		expect(context.fingerprint).toEqual(event.fingerprint);
		expect(context.tags?.['event']).toBe('memory_monitor_alert');
		expect(context.contexts?.['monitor']).toBeTypeOf('object');
	});
});
