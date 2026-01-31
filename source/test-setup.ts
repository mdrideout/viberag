import os from 'node:os';
import path from 'node:path';

// Ensure tests never write to real user data directories.
process.env['VIBERAG_HOME'] =
	process.env['VIBERAG_HOME'] ??
	path.join(os.tmpdir(), `viberag-test-home-${process.pid}`);

// Avoid network update checks in tests.
process.env['VIBERAG_SKIP_UPDATE_CHECK'] =
	process.env['VIBERAG_SKIP_UPDATE_CHECK'] ?? '1';
