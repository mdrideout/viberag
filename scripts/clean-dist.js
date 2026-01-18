import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

async function main() {
	const projectRoot = process.cwd();
	const distPath = path.resolve(projectRoot, 'dist');

	// Safety check: only allow removing "<cwd>/dist".
	if (path.basename(distPath) !== 'dist') {
		throw new Error(`Refusing to clean unexpected path: ${distPath}`);
	}
	if (!distPath.startsWith(path.resolve(projectRoot) + path.sep)) {
		throw new Error(`Refusing to clean outside project root: ${distPath}`);
	}

	await fs.rm(distPath, {recursive: true, force: true});
}

await main();
