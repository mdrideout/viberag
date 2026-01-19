/**
 * Startup update checks (npm registry).
 *
 * - Best-effort: never throws unless explicitly requested by caller.
 * - Timeout: default 3s.
 * - No external deps (no semver package).
 */

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

type PackageJson = {
	name: string;
	version: string;
};

export type NpmUpdateCheckStatus =
	| 'ok'
	| 'update_available'
	| 'timeout'
	| 'error'
	| 'skipped';

export type NpmUpdateCheckResult = {
	packageName: string;
	currentVersion: string;
	latestVersion: string | null;
	status: NpmUpdateCheckStatus;
	checkedAt: string;
	timeoutMs: number;
	error: string | null;
	upgradeCommand: string;
	message: string | null;
};

export function getCurrentPackageInfo(): {name: string; version: string} {
	// Path is relative from dist/ after compilation:
	// - source/daemon/lib -> ../../../package.json
	// - dist/daemon/lib -> ../../../package.json
	const pkg = require('../../../package.json') as PackageJson;
	return {name: pkg.name, version: pkg.version};
}

function parseSemverTriplet(version: string): [number, number, number] | null {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? '', 10);
	const minor = Number.parseInt(match[2] ?? '', 10);
	const patch = Number.parseInt(match[3] ?? '', 10);
	if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
		return null;
	}
	return [major, minor, patch];
}

export function compareSemver(a: string, b: string): number {
	const aParts = parseSemverTriplet(a);
	const bParts = parseSemverTriplet(b);
	if (!aParts || !bParts) {
		return a.trim() === b.trim() ? 0 : 0;
	}
	const [aMajor, aMinor, aPatch] = aParts;
	const [bMajor, bMinor, bPatch] = bParts;
	if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
	if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
	if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
	return 0;
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	// Node fetch abort errors tend to surface as AbortError or DOMException.
	return error.name === 'AbortError' || error.message.includes('aborted');
}

export async function checkNpmForUpdate(options?: {
	packageName?: string;
	currentVersion?: string;
	timeoutMs?: number;
	registryBaseUrl?: string;
	fetchImpl?: typeof fetch;
}): Promise<NpmUpdateCheckResult> {
	const {name: defaultName, version: defaultVersion} = getCurrentPackageInfo();
	const packageName = options?.packageName ?? defaultName;
	const currentVersion = options?.currentVersion ?? defaultVersion;
	const timeoutMs = options?.timeoutMs ?? 3000;
	const registryBaseUrl =
		options?.registryBaseUrl ?? 'https://registry.npmjs.org';
	const fetchImpl = options?.fetchImpl ?? fetch;
	const checkedAt = new Date().toISOString();
	const upgradeCommand = `npm install -g ${packageName}`;

	const controller = new AbortController();
	let didTimeout = false;
	const timeout = setTimeout(() => {
		didTimeout = true;
		controller.abort();
	}, timeoutMs);

	try {
		const url = `${registryBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/latest`;
		const response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'user-agent': `${packageName}/${currentVersion}`,
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			return {
				packageName,
				currentVersion,
				latestVersion: null,
				status: 'error',
				checkedAt,
				timeoutMs,
				error: `npm registry responded ${response.status} ${response.statusText}`,
				upgradeCommand,
				message: null,
			};
		}

		const json = (await response.json()) as {version?: unknown};
		const latestVersion =
			typeof json.version === 'string' ? json.version : null;

		if (!latestVersion) {
			return {
				packageName,
				currentVersion,
				latestVersion: null,
				status: 'error',
				checkedAt,
				timeoutMs,
				error: 'npm registry response missing version',
				upgradeCommand,
				message: null,
			};
		}

		const cmp = compareSemver(currentVersion, latestVersion);
		if (cmp < 0) {
			return {
				packageName,
				currentVersion,
				latestVersion,
				status: 'update_available',
				checkedAt,
				timeoutMs,
				error: null,
				upgradeCommand,
				message: `Update available: v${latestVersion} (current v${currentVersion}). Run "${upgradeCommand}".`,
			};
		}

		return {
			packageName,
			currentVersion,
			latestVersion,
			status: 'ok',
			checkedAt,
			timeoutMs,
			error: null,
			upgradeCommand,
			message: null,
		};
	} catch (error) {
		if (didTimeout || isAbortError(error)) {
			return {
				packageName,
				currentVersion,
				latestVersion: null,
				status: 'timeout',
				checkedAt,
				timeoutMs,
				error: null,
				upgradeCommand,
				message: null,
			};
		}

		const message = error instanceof Error ? error.message : String(error);
		return {
			packageName,
			currentVersion,
			latestVersion: null,
			status: 'error',
			checkedAt,
			timeoutMs,
			error: message,
			upgradeCommand,
			message: null,
		};
	} finally {
		clearTimeout(timeout);
	}
}
