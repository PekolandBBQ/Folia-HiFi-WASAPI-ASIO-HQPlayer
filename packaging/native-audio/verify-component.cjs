const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createComponentManager } = require('../../electron/nativeAudio/componentManager.cjs');
const { createHelper } = require('../../electron/nativeAudio/helper.cjs');

// packaging/native-audio/verify-component.cjs — download exactly the host-approved artifact in optional CI.
async function main() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 verification only');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-component-ci-'));
    let helper;
    try {
        const components = createComponentManager({ app: { isPackaged: true, getPath: () => directory } });
        if (!(await components.status()).installable) {
            console.log('PENDING: no published component has been approved in the catalog. Ordinary Folia builds are unaffected.');
            return;
        }
        const installed = await components.install();
        helper = createHelper(installed.executable, () => {});
        const hello = await helper.request({ action: 'hello', protocolMajor: 1 });
        if (hello.protocolMajor !== 1 || !hello.capabilities.includes('integer-pcm')) throw new Error('Component contract mismatch');
        console.log(JSON.stringify({ version: installed.version, protocol: hello.protocolMajor, result: 'PASS' }));
    } finally {
        helper?.dispose();
        // Wait for Windows to release the mapped executable before removing this generated temp directory.
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
