const { _electron } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');

// test/manual/nativeAudioElectronSmoke.cjs — production renderer -> IPC -> decoder -> hardware.
// Requires Vite on 127.0.0.1:4173. Pass an explicit device-name substring. Emits silence only.
async function main() {
    const match = process.argv[2];
    if (!match) throw new Error('Pass a device-name substring');
    const online = process.argv.includes('--online');
    const processingMode = process.argv.includes('--integer') ? 'integer-direct' : 'compatibility';
    let server;
    if (online) {
        const rate = 96000, size = rate * 6 * 10;
        const wav = Buffer.alloc(44 + size);
        wav.write('RIFF'); wav.writeUInt32LE(size + 36, 4); wav.write('WAVEfmt ', 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
        wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 6, 28); wav.writeUInt16LE(6, 32);
        wav.writeUInt16LE(24, 34); wav.write('data', 36); wav.writeUInt32LE(size, 40);
        server = require('node:http').createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'audio/wav' });
            response.write(wav.subarray(0, 44));
            setTimeout(() => response.end(wav.subarray(44)), 200);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    }
    const electron = await _electron.launch({ args: [path.resolve('test/manual/nativeAudioElectronHost.cjs')] });
    electron.process().stderr.on('data', data => process.stderr.write(data));
    try {
        const page = await electron.firstWindow();
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'component-install' }));
        const devices = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'devices' }));
        const targets = devices.filter(device => device.name.toLowerCase().includes(match.toLowerCase()));
        assert.ok(targets.length, 'No matching device');
        await page.addInitScript(({ processingMode }) => {
                const params = new URLSearchParams(location.search);
                const backend = params.get('backend'), id = params.get('device');
                localStorage.setItem('folia_native_audio_processing_mode', processingMode);
                localStorage.setItem('i18nextLng', 'en');
                localStorage.setItem('folia_native_audio_backend', backend);
                localStorage.setItem('folia_native_audio_device', id);
            }, { processingMode });
        for (const device of targets) {
            await page.goto('http://127.0.0.1:4173/dev-probe.html?probe=nativeAudio&backend=' + encodeURIComponent(device.backend) + '&device=' + encodeURIComponent(device.id) + (online
                ? '&sourceKind=remote&audioUrl=' + encodeURIComponent(`http://127.0.0.1:${server.address().port}/silence.wav`) : ''));
            await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'ready', { timeout: 30000 }).catch(async error => { throw new Error(`${error.message}; status: ${await page.getByTestId('status').textContent()}`); });
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
            console.log(JSON.stringify({ backend: device.backend, device: device.name, processingMode, result: 'PASS',
                checks: online ? 'HTTP 96kHz/24-bit complete preparation, hardware, UI play/pause/seek, next cached blob' : 'real preload, chunked file upload, decoder, hardware, UI play/pause/seek, next file', signal: 'silence' }));
        }
    } finally { await electron.close(); if (server) await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
