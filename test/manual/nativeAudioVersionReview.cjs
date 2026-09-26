const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createComponentManager } = require('../../electron/nativeAudio/componentManager.cjs');
const { createHelper } = require('../../electron/nativeAudio/helper.cjs');

// test/manual/nativeAudioVersionReview.cjs — real executable upgrade/rollback, isolated from user activation.
async function main() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-version-review-'));
    const catalogPath = path.join(directory, 'catalog.json');
    const catalog = JSON.parse(await fs.readFile('../folia-native-audio-component/artifacts/development-catalog.json', 'utf8'));
    const releases = catalog.releases;
    assert.ok(releases.length >= 2, 'Two local approved builds required');
    const manager = createComponentManager({ app: { isPackaged: false, getPath: () => directory }, catalogPath });
    const observations = [];
    async function observe(zh, en, state) {
        const helper = createHelper(state.executable, () => {});
        try {
            const hello = await helper.request({ action: 'hello', protocolMajor: 1 });
            assert.equal(hello.componentVersion, state.version);
            observations.push({ zh, en, version: hello.componentVersion, protocol: hello.protocolMajor, status: 'PASS' });
        } finally { helper.dispose(); }
    }
    try {
        await fs.writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [releases[1]] }));
        await observe('安装旧组件并握手', 'Install previous component and handshake', await manager.install());
        await fs.writeFile(catalogPath, JSON.stringify(catalog));
        assert.equal((await manager.status()).available, true);
        assert.equal((await manager.status()).updateAvailable, true);
        await observe('升级组件并握手', 'Upgrade component and handshake', await manager.install());
        await observe('恢复上一组件并握手', 'Roll back and handshake', await manager.rollback());
        const folders = (await fs.readdir(path.join(directory, 'components/native-audio'))).filter(name => /^\d+\./.test(name));
        assert.equal(folders.length, 2);
        await fs.mkdir('test-results/native-audio-review', { recursive: true });
        await fs.writeFile('test-results/native-audio-review/version-results.json', JSON.stringify({ observations, retainedVersions: folders.length }, null, 2));
        console.log('真实版本切换通过 / Real version switching PASS', JSON.stringify(observations));
    } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
