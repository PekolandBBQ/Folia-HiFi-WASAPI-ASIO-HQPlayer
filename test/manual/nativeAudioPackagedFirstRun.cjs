// test/manual/nativeAudioPackagedFirstRun.cjs — confirm the delivered app initializes an empty manual profile.
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
    const output = path.resolve('test-results/native-audio-review', `packaged-first-run-${Date.now()}`);
    await fs.mkdir(output, { recursive: true });
    const app = await _electron.launch({ executablePath: path.resolve('release/manual-20260929/win-unpacked/Folia Native Validation.exe'), timeout: 60000 });
    try {
        const page = await app.firstWindow();
        await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0 && window.electron?.nativeAudio);
        const status = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' }));
        assert.equal(status.version, '0.1.2'); assert.equal(status.available, true); assert.equal(status.rollbackAvailable, true);
        const firstRun = await page.evaluate(() => ({ backend: localStorage.getItem('folia_native_audio_backend'), folder: localStorage.getItem('native_review_folder') }));
        assert.equal(firstRun.folder, null); assert.ok(firstRun.backend === null || firstRun.backend === 'browser');
        const results = [{ id: 'fresh-packaged-first-run', status: 'PASS', version: status.version, rollbackAvailable: status.rollbackAvailable, ...firstRun }];
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        await page.screenshot({ path: path.join(output, 'first-run.png') });
        console.log(JSON.stringify(results[0]));
    } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
