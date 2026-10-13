import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'vitest';

// test/unit/electron/qqAuthenticatedSearch.test.ts: include the actual CJS host and session suite in the regular unit gate.
it('passes authenticated QQ host, session isolation and cancellation regressions', async () => {
    await promisify(execFile)(process.execPath, ['--test',
        fileURLToPath(new URL('./qqAuthenticatedSearch.node.test.cjs', import.meta.url)),
    ], { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true });
}, 15000);
