const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHQPlayerComponentManager } = require('../../electron/hqplayer/componentManager.cjs');
const { verify } = require('./verify-rpc.cjs');

// Empty official catalogs are explicit pending states, not fabricated release approvals.
async function main() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-hqp-ci-'));
    try {
        const manager = createHQPlayerComponentManager({ app: { isPackaged: true, getPath: () => directory }, verifyStaged: verify });
        if (!(await manager.status()).installable) { console.log('PENDING: no upstream-approved HQPlayer component'); return; }
        console.log(JSON.stringify(await manager.install()));
    } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
