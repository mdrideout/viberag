import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function stripInlineComment(value) {
	// Only strip comments for unquoted values: "foo # bar" -> "foo"
	const trimmed = value.trim();
	if (trimmed.startsWith('"') || trimmed.startsWith("'")) return value;
	const idx = value.indexOf(' #');
	if (idx === -1) return value;
	return value.slice(0, idx);
}

function unquote(value) {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseDotenv(contents) {
	/** @type {Record<string, string>} */
	const env = {};
	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const withoutExport = trimmed.startsWith('export ')
			? trimmed.slice('export '.length).trim()
			: trimmed;

		const eq = withoutExport.indexOf('=');
		if (eq === -1) continue;

		const key = withoutExport.slice(0, eq).trim();
		const rawValue = withoutExport.slice(eq + 1);
		const value = unquote(stripInlineComment(rawValue));

		if (key) env[key] = value;
	}
	return env;
}

function replacePlaceholder(input, placeholder, value) {
	const re = new RegExp(`(['"])${placeholder}\\1`, 'g');
	const replacement = JSON.stringify(value);
	const next = input.replace(re, replacement);
	if (next === input) {
		throw new Error(
			`[bake-telemetry-keys-local] Placeholder not found: ${placeholder}`,
		);
	}
	return next;
}

async function main() {
	const envPath = path.join(process.cwd(), '.env.telemetry.local');
	let fileEnv = null;
	try {
		const raw = await fs.readFile(envPath, 'utf8');
		fileEnv = parseDotenv(raw);
	} catch {
		throw new Error(
			`[bake-telemetry-keys-local] Missing ${envPath}.\n\n` +
				`Create it with:\n` +
				`  VIBERAG_BAKE_POSTHOG_KEY=phc_...\n` +
				`  VIBERAG_BAKE_SENTRY_DSN=https://...@o...ingest.sentry.io/...\n`,
		);
	}

	const posthogKey =
		fileEnv['VIBERAG_BAKE_POSTHOG_KEY'] ??
		process.env['VIBERAG_BAKE_POSTHOG_KEY']?.trim();
	const sentryDsn =
		fileEnv['VIBERAG_BAKE_SENTRY_DSN'] ??
		process.env['VIBERAG_BAKE_SENTRY_DSN']?.trim();

	if (!posthogKey || !sentryDsn) {
		throw new Error(
			'[bake-telemetry-keys-local] Missing VIBERAG_BAKE_POSTHOG_KEY and/or VIBERAG_BAKE_SENTRY_DSN in .env.telemetry.local.',
		);
	}

	const distKeysPath = path.join(
		process.cwd(),
		'dist',
		'daemon',
		'lib',
		'telemetry',
		'keys.js',
	);

	const raw = await fs.readFile(distKeysPath, 'utf8');
	let next = raw;
	next = replacePlaceholder(
		next,
		'__VIBERAG_POSTHOG_PROJECT_API_KEY__',
		posthogKey,
	);
	next = replacePlaceholder(next, '__VIBERAG_SENTRY_DSN__', sentryDsn);

	if (next !== raw) {
		await fs.writeFile(distKeysPath, next);
	}
}

main().catch(error => {
	globalThis.console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
