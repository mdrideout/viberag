import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function replacePlaceholder(input, placeholder, value) {
	const re = new RegExp(`(['"])${placeholder}\\1`, 'g');
	const replacement = JSON.stringify(value);
	const next = input.replace(re, replacement);
	if (next === input) {
		throw new Error(
			`[bake-telemetry-keys] Placeholder not found: ${placeholder}`,
		);
	}
	return next;
}

async function main() {
	const posthogKey = process.env['VIBERAG_BAKE_POSTHOG_KEY']?.trim();
	const sentryDsn = process.env['VIBERAG_BAKE_SENTRY_DSN']?.trim();

	if (!posthogKey || !sentryDsn) {
		throw new Error(
			'[bake-telemetry-keys] Missing VIBERAG_BAKE_POSTHOG_KEY and/or VIBERAG_BAKE_SENTRY_DSN. ' +
				'Set these in your publish environment so dist ships with baked-in keys.',
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
