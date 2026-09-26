const { _electron } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');

// test/manual/nativeAudioElectronSmoke.cjs — production renderer -> IPC -> decoder -> hardware.
// Requires Vite on 127.0.0.1:4173. Pass an explicit device-name substring. Emits silence only.
async function main() {
    const match = process.argv[2];
    if (!match) throw new Error('Pass a device-name substring');
    const electron = await _electron.launch({ args: [path.resolve('test/manual/nativeAudioElectronHost.cjs')] });
    electron.process().stderr.on('data', data => process.stderr.write(data));
    try {
        const page = await electron.firstWindow();
        const devices = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'devices' }));
        const targets = devices.filter(device => device.name.toLowerCase().includes(match.toLowerCase()));
        assert.ok(targets.length, 'No matching device');
        for (const device of targets) {
            await page.addInitScript(({ backend, id }) => {
                localStorage.setItem('i18nextLng', 'en');
                localStorage.setItem('folia_native_audio_backend', backend);
                localStorage.setItem('folia_native_audio_device', id);
            }, device);
            await page.goto('http://127.0.0.1:4173/dev-probe.html?probe=nativeAudio');
            await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'ready', { timeout: 30000 });
            await page.getByRole('button', { name: 'Play', exact: true }).click();
            await page.waitForFunction(() => Number(document.querySelector('[data-testid="clock"]')?.textContent) > 0.2);
            await page.getByRole('button', { name: 'Seek 5s' }).click();
            await page.waitForFunction(() => Number(document.querySelector('[data-testid="clock"]')?.textContent) >= 5);
            await page.getByRole('button', { name: 'Pause', exact: true }).click();
            await page.waitForTimeout(150);
            const paused = await page.getByTestId('clock').textContent();
            await page.waitForTimeout(150);
            assert.equal(await page.getByTestId('clock').textContent(), paused);
            await page.getByRole('button', { name: 'Play', exact: true }).click();
            await page.waitForFunction(value => Number(document.querySelector('[data-testid="clock"]')?.textContent) > Number(value) + 0.1, paused);
            await page.getByRole('button', { name: 'Next file' }).click();
            await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'ready');
            await page.getByRole('button', { name: 'Play', exact: true }).click();
            await page.waitForFunction(() => Number(document.querySelector('[data-testid="clock"]')?.textContent) < 1);
            console.log(JSON.stringify({ backend: device.backend, device: device.name, result: 'PASS',
                checks: 'real preload, chunked file upload, decoder, hardware, UI play/pause/seek, next file', signal: 'silence' }));
        }
    } finally { await electron.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
