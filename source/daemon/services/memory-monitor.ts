import fs from 'node:fs/promises';
import path from 'node:path';
import {getRunDir} from '../lib/constants.js';

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_RECOVERY_BYTES = 3.5 * 1024 * 1024 * 1024;
const DEFAULT_GROWTH_THRESHOLD_BYTES = 1 * 1024 * 1024 * 1024;
const DEFAULT_GROWTH_WINDOW_MS = 10_000;
const DEFAULT_MIN_REPORT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_REPORTS_PER_DAY = 20;
const DEFAULT_SAMPLE_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_STATE_FILE_NAME = 'memory-monitor-state.json';
const MAX_SAMPLE_HISTORY = 1_200;

type MemoryMonitorLogLevel = 'debug' | 'info' | 'warn' | 'error';
type MemoryMonitorLogger = (
	level: MemoryMonitorLogLevel,
	message: string,
) => void;
type MemoryUsageReader = () => NodeJS.MemoryUsage;
type NowProvider = () => number;

type MemorySample = {
	atMs: number;
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
};

type PersistedLimiterState = {
	dayKey: string;
	sentCount: number;
	lastSentAtMs: number;
};

type GrowthAnalysis = {
	sampleCount: number;
	fromAtMs: number;
	toAtMs: number;
	fromRssBytes: number;
	toRssBytes: number;
	minRssBytes: number;
	maxRssBytes: number;
	growthBytes: number;
	durationMs: number;
};

export type MemoryMonitorTrigger =
	| {
			kind: 'threshold';
			rssMB: number;
			thresholdMB: number;
			firstTriggeredAt: string | null;
	  }
	| {
			kind: 'rapid_growth';
			growthMB: number;
			growthThresholdMB: number;
			windowSec: number;
			durationSec: number;
			fromRssMB: number;
			toRssMB: number;
			fromAt: string;
			toAt: string;
	  };

export type MemoryMonitorReport = {
	observedAt: string;
	observedAtMs: number;
	usage: NodeJS.MemoryUsage;
	triggers: MemoryMonitorTrigger[];
	threshold: {
		active: boolean;
		thresholdMB: number;
		recoveryMB: number;
		firstTriggeredAt: string | null;
	};
	growth: {
		windowSec: number;
		sampleCount: number;
		fromAt: string;
		toAt: string;
		fromRssMB: number;
		toRssMB: number;
		minRssMB: number;
		maxRssMB: number;
		growthMB: number;
		durationSec: number;
	} | null;
	rateLimit: {
		dayKey: string;
		sentToday: number;
		maxReportsPerDay: number;
		minReportIntervalSec: number;
		lastReportedAt: string | null;
		suppressedByCooldown: number;
		suppressedByDailyCap: number;
	};
	samples: {
		retentionSec: number;
		totalSampleCount: number;
		recent: Array<{
			at: string;
			rssMB: number;
			heapUsedMB: number;
			externalMB: number;
		}>;
	};
	config: {
		pollIntervalSec: number;
		thresholdMB: number;
		recoveryMB: number;
		growthThresholdMB: number;
		growthWindowSec: number;
		minReportIntervalSec: number;
		maxReportsPerDay: number;
	};
};

export interface MemoryMonitorStateStore {
	load(): Promise<PersistedLimiterState | null>;
	save(state: PersistedLimiterState): Promise<void>;
}

class JsonFileMemoryMonitorStateStore implements MemoryMonitorStateStore {
	private readonly stateFilePath: string;

	constructor(projectRoot: string) {
		this.stateFilePath = path.join(
			getRunDir(projectRoot),
			DEFAULT_STATE_FILE_NAME,
		);
	}

	async load(): Promise<PersistedLimiterState | null> {
		try {
			const raw = await fs.readFile(this.stateFilePath, 'utf8');
			const parsed = JSON.parse(raw) as unknown;
			if (typeof parsed !== 'object' || parsed === null) {
				return null;
			}
			const maybe = parsed as Record<string, unknown>;
			const dayKeyValue =
				typeof maybe['dayKey'] === 'string' ? maybe['dayKey'].trim() : '';
			const sentCountValue =
				typeof maybe['sentCount'] === 'number' ? maybe['sentCount'] : -1;
			const lastSentAtMsValue =
				typeof maybe['lastSentAtMs'] === 'number' ? maybe['lastSentAtMs'] : -1;
			if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKeyValue)) {
				return null;
			}
			if (
				!Number.isFinite(sentCountValue) ||
				sentCountValue < 0 ||
				!Number.isFinite(lastSentAtMsValue) ||
				lastSentAtMsValue < 0
			) {
				return null;
			}
			return {
				dayKey: dayKeyValue,
				sentCount: Math.floor(sentCountValue),
				lastSentAtMs: Math.floor(lastSentAtMsValue),
			};
		} catch (error) {
			if (error instanceof Error && 'code' in error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') {
					return null;
				}
			}
			return null;
		}
	}

	async save(state: PersistedLimiterState): Promise<void> {
		const directory = path.dirname(this.stateFilePath);
		const tempPath = `${this.stateFilePath}.tmp`;
		await fs.mkdir(directory, {recursive: true});
		await fs.writeFile(tempPath, `${JSON.stringify(state)}\n`, 'utf8');
		await fs.rename(tempPath, this.stateFilePath);
	}
}

export type DaemonMemoryMonitorOptions = {
	projectRoot: string;
	onReport: (report: MemoryMonitorReport) => void | Promise<void>;
	logger?: MemoryMonitorLogger;
	readMemoryUsage?: MemoryUsageReader;
	now?: NowProvider;
	pollIntervalMs?: number;
	thresholdBytes?: number;
	recoveryBytes?: number;
	growthThresholdBytes?: number;
	growthWindowMs?: number;
	minReportIntervalMs?: number;
	maxReportsPerDay?: number;
	sampleRetentionMs?: number;
	stateStore?: MemoryMonitorStateStore;
};

function toMB(bytes: number): number {
	return Number((bytes / (1024 * 1024)).toFixed(1));
}

function isoAt(ms: number): string {
	return new Date(ms).toISOString();
}

function dayKeyAt(ms: number): string {
	return isoAt(ms).slice(0, 10);
}

function normalizeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	if (value <= 0) return fallback;
	return Math.floor(value);
}

export class DaemonMemoryMonitor {
	private readonly projectRoot: string;
	private readonly onReport: (
		report: MemoryMonitorReport,
	) => void | Promise<void>;
	private readonly logger: MemoryMonitorLogger | null;
	private readonly readMemoryUsage: MemoryUsageReader;
	private readonly now: NowProvider;
	private readonly pollIntervalMs: number;
	private readonly thresholdBytes: number;
	private readonly recoveryBytes: number;
	private readonly growthThresholdBytes: number;
	private readonly growthWindowMs: number;
	private readonly minReportIntervalMs: number;
	private readonly maxReportsPerDay: number;
	private readonly sampleRetentionMs: number;
	private readonly stateStore: MemoryMonitorStateStore;

	private timer: NodeJS.Timeout | null = null;
	private checkInFlight = false;
	private samples: MemorySample[] = [];
	private thresholdActive = false;
	private thresholdFirstTriggeredAtMs: number | null = null;
	private limiterState: PersistedLimiterState;
	private suppressedByCooldown = 0;
	private suppressedByDailyCap = 0;
	private stateLoaded = false;

	constructor(options: DaemonMemoryMonitorOptions) {
		this.projectRoot = options.projectRoot;
		this.onReport = options.onReport;
		this.logger = options.logger ?? null;
		this.readMemoryUsage =
			options.readMemoryUsage ?? (() => process.memoryUsage());
		this.now = options.now ?? (() => Date.now());
		this.pollIntervalMs = normalizeInteger(
			options.pollIntervalMs,
			DEFAULT_POLL_INTERVAL_MS,
		);
		this.thresholdBytes = normalizeInteger(
			options.thresholdBytes,
			DEFAULT_THRESHOLD_BYTES,
		);
		this.recoveryBytes = normalizeInteger(
			options.recoveryBytes,
			DEFAULT_RECOVERY_BYTES,
		);
		this.growthThresholdBytes = normalizeInteger(
			options.growthThresholdBytes,
			DEFAULT_GROWTH_THRESHOLD_BYTES,
		);
		this.growthWindowMs = normalizeInteger(
			options.growthWindowMs,
			DEFAULT_GROWTH_WINDOW_MS,
		);
		this.minReportIntervalMs = normalizeInteger(
			options.minReportIntervalMs,
			DEFAULT_MIN_REPORT_INTERVAL_MS,
		);
		this.maxReportsPerDay = normalizeInteger(
			options.maxReportsPerDay,
			DEFAULT_MAX_REPORTS_PER_DAY,
		);
		this.sampleRetentionMs = normalizeInteger(
			options.sampleRetentionMs,
			DEFAULT_SAMPLE_RETENTION_MS,
		);
		this.stateStore =
			options.stateStore ??
			new JsonFileMemoryMonitorStateStore(this.projectRoot);

		const now = this.now();
		this.limiterState = {
			dayKey: dayKeyAt(now),
			sentCount: 0,
			lastSentAtMs: 0,
		};
	}

	async start(): Promise<void> {
		if (this.timer) return;

		await this.ensureLimiterStateLoaded();
		await this.checkNow();

		this.timer = setInterval(() => {
			void this.checkNow();
		}, this.pollIntervalMs);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.persistLimiterState();
		this.thresholdActive = false;
		this.thresholdFirstTriggeredAtMs = null;
	}

	async checkNow(): Promise<void> {
		if (this.checkInFlight) return;
		this.checkInFlight = true;
		try {
			await this.runCheck();
		} finally {
			this.checkInFlight = false;
		}
	}

	private async runCheck(): Promise<void> {
		await this.ensureLimiterStateLoaded();

		const now = this.now();
		this.rollLimiterDayIfNeeded(now);

		const usage = this.readMemoryUsage();
		this.recordSample(now, usage);

		if (this.thresholdActive && usage.rss <= this.recoveryBytes) {
			this.thresholdActive = false;
			this.thresholdFirstTriggeredAtMs = null;
		}

		const triggers: MemoryMonitorTrigger[] = [];
		if (usage.rss >= this.thresholdBytes) {
			if (!this.thresholdActive) {
				this.thresholdActive = true;
				this.thresholdFirstTriggeredAtMs = now;
			}
			triggers.push({
				kind: 'threshold',
				rssMB: toMB(usage.rss),
				thresholdMB: toMB(this.thresholdBytes),
				firstTriggeredAt:
					this.thresholdFirstTriggeredAtMs === null
						? null
						: isoAt(this.thresholdFirstTriggeredAtMs),
			});
		}

		const growth = this.computeGrowth(now);
		if (growth && growth.growthBytes >= this.growthThresholdBytes) {
			triggers.push({
				kind: 'rapid_growth',
				growthMB: toMB(growth.growthBytes),
				growthThresholdMB: toMB(this.growthThresholdBytes),
				windowSec: Number((this.growthWindowMs / 1000).toFixed(1)),
				durationSec: Number((growth.durationMs / 1000).toFixed(1)),
				fromRssMB: toMB(growth.fromRssBytes),
				toRssMB: toMB(growth.toRssBytes),
				fromAt: isoAt(growth.fromAtMs),
				toAt: isoAt(growth.toAtMs),
			});
		}

		if (triggers.length === 0) return;

		const limiterBlock = this.getLimiterBlockReason(now);
		if (limiterBlock === 'daily_cap') {
			this.suppressedByDailyCap += 1;
			return;
		}
		if (limiterBlock === 'cooldown') {
			this.suppressedByCooldown += 1;
			return;
		}

		this.limiterState.sentCount += 1;
		this.limiterState.lastSentAtMs = now;
		await this.persistLimiterState();

		const report = this.buildReport(now, usage, triggers, growth);
		try {
			await this.onReport(report);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log('warn', `Memory monitor report callback failed: ${message}`);
		}
	}

	private async ensureLimiterStateLoaded(): Promise<void> {
		if (this.stateLoaded) return;
		this.stateLoaded = true;
		try {
			const loaded = await this.stateStore.load();
			if (!loaded) return;
			this.limiterState = {
				dayKey: loaded.dayKey,
				sentCount: Math.max(0, Math.floor(loaded.sentCount)),
				lastSentAtMs: Math.max(0, Math.floor(loaded.lastSentAtMs)),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log('warn', `Memory monitor state load failed: ${message}`);
		}
	}

	private async persistLimiterState(): Promise<void> {
		try {
			await this.stateStore.save(this.limiterState);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log('warn', `Memory monitor state save failed: ${message}`);
		}
	}

	private rollLimiterDayIfNeeded(now: number): void {
		const dayKey = dayKeyAt(now);
		if (dayKey === this.limiterState.dayKey) return;
		this.limiterState = {
			dayKey,
			sentCount: 0,
			lastSentAtMs: 0,
		};
		this.suppressedByCooldown = 0;
		this.suppressedByDailyCap = 0;
	}

	private getLimiterBlockReason(now: number): 'daily_cap' | 'cooldown' | null {
		if (this.limiterState.sentCount >= this.maxReportsPerDay) {
			return 'daily_cap';
		}
		if (
			this.limiterState.lastSentAtMs > 0 &&
			now - this.limiterState.lastSentAtMs < this.minReportIntervalMs
		) {
			return 'cooldown';
		}
		return null;
	}

	private recordSample(now: number, usage: NodeJS.MemoryUsage): void {
		this.samples.push({
			atMs: now,
			rssBytes: usage.rss,
			heapUsedBytes: usage.heapUsed,
			heapTotalBytes: usage.heapTotal,
			externalBytes: usage.external,
			arrayBuffersBytes: usage.arrayBuffers,
		});
		const cutoff = now - this.sampleRetentionMs;
		while (this.samples.length > 0 && this.samples[0]!.atMs < cutoff) {
			this.samples.shift();
		}
		while (this.samples.length > MAX_SAMPLE_HISTORY) {
			this.samples.shift();
		}
	}

	private computeGrowth(now: number): GrowthAnalysis | null {
		const cutoff = now - this.growthWindowMs;
		const windowSamples = this.samples.filter(sample => sample.atMs >= cutoff);
		if (windowSamples.length < 2) return null;
		const newest = windowSamples[windowSamples.length - 1]!;
		let minSample = windowSamples[0]!;
		let minRssBytes = minSample.rssBytes;
		let maxRssBytes = minSample.rssBytes;
		for (const sample of windowSamples) {
			if (sample.rssBytes < minSample.rssBytes) {
				minSample = sample;
			}
			if (sample.rssBytes < minRssBytes) {
				minRssBytes = sample.rssBytes;
			}
			if (sample.rssBytes > maxRssBytes) {
				maxRssBytes = sample.rssBytes;
			}
		}
		const growthBytes = Math.max(0, newest.rssBytes - minSample.rssBytes);
		const durationMs = Math.max(1, newest.atMs - minSample.atMs);
		return {
			sampleCount: windowSamples.length,
			fromAtMs: minSample.atMs,
			toAtMs: newest.atMs,
			fromRssBytes: minSample.rssBytes,
			toRssBytes: newest.rssBytes,
			minRssBytes,
			maxRssBytes,
			growthBytes,
			durationMs,
		};
	}

	private buildReport(
		now: number,
		usage: NodeJS.MemoryUsage,
		triggers: MemoryMonitorTrigger[],
		growth: GrowthAnalysis | null,
	): MemoryMonitorReport {
		const recent = this.samples.slice(-8).map(sample => ({
			at: isoAt(sample.atMs),
			rssMB: toMB(sample.rssBytes),
			heapUsedMB: toMB(sample.heapUsedBytes),
			externalMB: toMB(sample.externalBytes),
		}));

		return {
			observedAt: isoAt(now),
			observedAtMs: now,
			usage,
			triggers,
			threshold: {
				active: this.thresholdActive,
				thresholdMB: toMB(this.thresholdBytes),
				recoveryMB: toMB(this.recoveryBytes),
				firstTriggeredAt:
					this.thresholdFirstTriggeredAtMs === null
						? null
						: isoAt(this.thresholdFirstTriggeredAtMs),
			},
			growth: growth
				? {
						windowSec: Number((this.growthWindowMs / 1000).toFixed(1)),
						sampleCount: growth.sampleCount,
						fromAt: isoAt(growth.fromAtMs),
						toAt: isoAt(growth.toAtMs),
						fromRssMB: toMB(growth.fromRssBytes),
						toRssMB: toMB(growth.toRssBytes),
						minRssMB: toMB(growth.minRssBytes),
						maxRssMB: toMB(growth.maxRssBytes),
						growthMB: toMB(growth.growthBytes),
						durationSec: Number((growth.durationMs / 1000).toFixed(1)),
					}
				: null,
			rateLimit: {
				dayKey: this.limiterState.dayKey,
				sentToday: this.limiterState.sentCount,
				maxReportsPerDay: this.maxReportsPerDay,
				minReportIntervalSec: Number(
					(this.minReportIntervalMs / 1000).toFixed(1),
				),
				lastReportedAt:
					this.limiterState.lastSentAtMs > 0
						? isoAt(this.limiterState.lastSentAtMs)
						: null,
				suppressedByCooldown: this.suppressedByCooldown,
				suppressedByDailyCap: this.suppressedByDailyCap,
			},
			samples: {
				retentionSec: Number((this.sampleRetentionMs / 1000).toFixed(1)),
				totalSampleCount: this.samples.length,
				recent,
			},
			config: {
				pollIntervalSec: Number((this.pollIntervalMs / 1000).toFixed(1)),
				thresholdMB: toMB(this.thresholdBytes),
				recoveryMB: toMB(this.recoveryBytes),
				growthThresholdMB: toMB(this.growthThresholdBytes),
				growthWindowSec: Number((this.growthWindowMs / 1000).toFixed(1)),
				minReportIntervalSec: Number(
					(this.minReportIntervalMs / 1000).toFixed(1),
				),
				maxReportsPerDay: this.maxReportsPerDay,
			},
		};
	}

	private log(level: MemoryMonitorLogLevel, message: string): void {
		if (!this.logger) return;
		this.logger(level, message);
	}
}
