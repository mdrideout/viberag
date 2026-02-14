import {describe, expect, it} from 'vitest';
import type {MemoryMonitorStateStore} from '../services/memory-monitor.js';
import {DaemonMemoryMonitor} from '../services/memory-monitor.js';

const MB = 1024 * 1024;

class InMemoryStateStore implements MemoryMonitorStateStore {
	private state: {
		dayKey: string;
		sentCount: number;
		lastSentAtMs: number;
	} | null = null;

	async load() {
		return this.state ? {...this.state} : null;
	}

	async save(state: {dayKey: string; sentCount: number; lastSentAtMs: number}) {
		this.state = {...state};
	}
}

function usageFromRssMB(rssMB: number): NodeJS.MemoryUsage {
	return {
		rss: Math.floor(rssMB * MB),
		heapTotal: 256 * MB,
		heapUsed: 128 * MB,
		external: 40 * MB,
		arrayBuffers: 10 * MB,
	};
}

describe('DaemonMemoryMonitor', () => {
	it('limits reporting to at most once per 10 seconds and 20 times per day', async () => {
		let now = Date.parse('2026-02-14T00:00:00.000Z');
		const rssMB = 5_200;
		const reports: Array<{rateLimit: {sentToday: number}}> = [];

		const monitor = new DaemonMemoryMonitor({
			projectRoot: process.cwd(),
			onReport: report => {
				reports.push({rateLimit: report.rateLimit});
			},
			now: () => now,
			readMemoryUsage: () => usageFromRssMB(rssMB),
			minReportIntervalMs: 10_000,
			maxReportsPerDay: 20,
			growthThresholdBytes: Number.MAX_SAFE_INTEGER,
			stateStore: new InMemoryStateStore(),
		});

		await monitor.checkNow();
		now += 3_000;
		await monitor.checkNow();
		expect(reports).toHaveLength(1);

		now += 7_000;
		await monitor.checkNow();
		expect(reports).toHaveLength(2);

		for (let index = 0; index < 30; index += 1) {
			now += 10_000;
			await monitor.checkNow();
		}

		expect(reports).toHaveLength(20);
		expect(reports[19]!.rateLimit.sentToday).toBe(20);
	});

	it('triggers when RSS grows by 1GB within 10 seconds', async () => {
		let now = Date.parse('2026-02-14T10:00:00.000Z');
		let rssMB = 600;
		const reports: Array<{triggers: string[]}> = [];

		const monitor = new DaemonMemoryMonitor({
			projectRoot: process.cwd(),
			onReport: report => {
				reports.push({triggers: report.triggers.map(trigger => trigger.kind)});
			},
			now: () => now,
			readMemoryUsage: () => usageFromRssMB(rssMB),
			thresholdBytes: 12 * 1024 * 1024 * 1024,
			growthThresholdBytes: 1 * 1024 * 1024 * 1024,
			growthWindowMs: 10_000,
			stateStore: new InMemoryStateStore(),
		});

		await monitor.checkNow();
		now += 3_000;
		rssMB = 950;
		await monitor.checkNow();
		now += 3_000;
		rssMB = 1_300;
		await monitor.checkNow();
		now += 3_000;
		rssMB = 1_700;
		await monitor.checkNow();

		expect(reports).toHaveLength(1);
		expect(reports[0]!.triggers).toContain('rapid_growth');
		expect(reports[0]!.triggers).not.toContain('threshold');
	});

	it('resets the daily report budget on UTC day rollover', async () => {
		let now = Date.parse('2026-02-14T12:00:00.000Z');
		const reports: Array<{dayKey: string; sentToday: number}> = [];

		const monitor = new DaemonMemoryMonitor({
			projectRoot: process.cwd(),
			onReport: report => {
				reports.push({
					dayKey: report.rateLimit.dayKey,
					sentToday: report.rateLimit.sentToday,
				});
			},
			now: () => now,
			readMemoryUsage: () => usageFromRssMB(4_600),
			maxReportsPerDay: 1,
			minReportIntervalMs: 10_000,
			growthThresholdBytes: Number.MAX_SAFE_INTEGER,
			stateStore: new InMemoryStateStore(),
		});

		await monitor.checkNow();
		now += 10_000;
		await monitor.checkNow();
		expect(reports).toHaveLength(1);

		now = Date.parse('2026-02-15T00:00:01.000Z');
		await monitor.checkNow();

		expect(reports).toHaveLength(2);
		expect(reports[1]!.dayKey).toBe('2026-02-15');
		expect(reports[1]!.sentToday).toBe(1);
	});
});
