/**
 * File watcher tests for gitignore handling.
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {FileWatcher} from '../services/watcher.js';
import {
	createConfigForProvider,
	saveConfig,
	type ViberagConfig,
} from '../lib/config.js';
import {getRunDir, getViberagDir} from '../lib/constants.js';
import {addFile, modifyFile, waitForFs} from './helpers.js';

type TempProject = {
	projectRoot: string;
	cleanup: () => Promise<void>;
};

async function writeWatcherConfig(projectRoot: string): Promise<void> {
	const config: ViberagConfig = {
		...createConfigForProvider('local'),
		watch: {
			enabled: true,
			debounceMs: 10,
			batchWindowMs: 10,
			awaitWriteFinish: false,
		},
	};
	await saveConfig(projectRoot, config);
}

async function createTempProject(): Promise<TempProject> {
	const projectRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), 'viberag-watch-test-'),
	);
	await writeWatcherConfig(projectRoot);

	const projectDataDir = getViberagDir(projectRoot);
	const runDir = getRunDir(projectRoot);

	return {
		projectRoot,
		cleanup: async () => {
			await fs.rm(projectDataDir, {recursive: true, force: true});
			await fs.rm(runDir, {recursive: true, force: true});
			await fs.rm(projectRoot, {recursive: true, force: true});
		},
	};
}

describe('FileWatcher', () => {
	let ctx: TempProject;
	let watcher: FileWatcher | null = null;

	beforeEach(async () => {
		ctx = await createTempProject();
	});

	afterEach(async () => {
		if (watcher) {
			await watcher.stop();
			watcher = null;
		}
		await ctx.cleanup();
	});

	it('reloads .gitignore and ignores newly listed files', async () => {
		await fs.writeFile(
			path.join(ctx.projectRoot, '.gitignore'),
			'ignored.txt\n',
		);

		watcher = new FileWatcher(ctx.projectRoot);
		let indexCalls = 0;
		watcher.setIndexTrigger(async () => {
			indexCalls += 1;
			return {chunksAdded: 0, chunksDeleted: 0};
		});

		await watcher.start();
		await waitForFs(200);
		indexCalls = 0;

		await addFile(ctx.projectRoot, 'ignored.txt', 'ignore me');
		await waitForFs(200);
		expect(indexCalls).toBe(0);

		await modifyFile(
			ctx.projectRoot,
			'.gitignore',
			'ignored.txt\ndynamic.txt\n',
		);
		await waitForFs(200);
		indexCalls = 0;

		await addFile(ctx.projectRoot, 'dynamic.txt', 'also ignore');
		await waitForFs(200);
		expect(indexCalls).toBe(0);

		await addFile(ctx.projectRoot, 'tracked.txt', 'track me');
		await waitForFs(200);
		expect(indexCalls).toBeGreaterThan(0);
	});
});
