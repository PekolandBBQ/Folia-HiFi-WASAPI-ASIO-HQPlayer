import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'vitest';

// Run the real CJS boundary suite in Node so the upstream unit gate also covers private HTTP startup and cancellation.
it('passes Soloist private HTTP and SSH bootstrap boundary regressions', async () => {
    await promisify(execFile)(process.execPath, ['--test',
        fileURLToPath(new URL('../../node/soloistHttpInvoke.test.cjs', import.meta.url)),
        fileURLToPath(new URL('../../node/soloistHttpBootstrap.test.cjs', import.meta.url)),
    ], { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true });
}, 15000);
