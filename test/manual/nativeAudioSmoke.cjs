const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHelper } = require('../../electron/nativeAudio/helper.cjs');
const { decodeLocalAudio } = require('../../electron/nativeAudio/decode.cjs');

// test/manual/nativeAudioSmoke.cjs — opt-in hardware test; only renders silence.
// node test/manual/nativeAudioSmoke.cjs "part of device name"
async function main() {
    const match = process.argv[2];
    if (!match) throw new Error('Pass an explicit device-name substring; this test opens exclusive audio streams');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-native-smoke-'));
    const filename = path.join(directory, 'silence.wav');
    let latest, error;
    const helper = createHelper(path.resolve('build/native-audio/folia-audio.exe'), event => {
        if (event.state) latest = event.state;
        if (event.event === 'error') error = event.error;
    });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
        const devices = (await helper.request({ action: 'devices' })).filter(device => device.name.toLowerCase().includes(match.toLowerCase()));
        assert.ok(devices.length, 'No matching output device');
        for (const rate of [44100, 48000]) {
            const dataSize = rate * 2 * 3 * 4;
            const wav = Buffer.alloc(44 + dataSize);
            wav.write('RIFF'); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVEfmt ', 8);
            wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
            wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 6, 28);
            wav.writeUInt16LE(6, 32); wav.writeUInt16LE(24, 34); wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
            await fs.writeFile(filename, wav);
            const decoded = await decodeLocalAudio(path.resolve('build/native-audio/ffmpeg.exe'), filename, directory, new AbortController().signal);
            for (const device of devices) {
                const session = `${device.backend}-${rate}`;
                const request = (action, extra = {}) => helper.request({ action, session, ...extra });
                latest = undefined; error = undefined;
                const loaded = await request('load', { path: decoded, backend: device.backend, deviceId: device.id });
                assert.equal(loaded.playing, false); assert.equal(loaded.duration, 4); assert.equal(loaded.sampleRate, rate);
                await request('play'); await wait(500);
                assert.equal(error, undefined);
                assert.ok(latest?.position > 0.15 && latest.position < 1, `clock: ${JSON.stringify(latest)}`);
                const paused = await request('pause'); await wait(150);
                assert.equal(paused.playing, false);
                const again = await request('pause');
                assert.equal(again.position, paused.position, 'Paused clock must be frozen');
                const seek = await request('seek', { position: 2 });
                assert.equal(seek.position, 2); assert.equal(seek.playing, false);
                await request('play'); await wait(250);
                assert.ok(latest.position > 2 && latest.position < 2.7, `resume clock: ${latest.position}`);
                await request('seek', { position: 3.8 }); await wait(650);
                assert.equal(latest.ended, true); assert.equal(latest.position, 4);
                const replay = await request('play'); assert.equal(replay.ended, false);
                await wait(100);
                await assert.rejects(helper.request({ action: 'pause', session: 'stale' }), /Stale/);
                await request('stop');
                console.log(JSON.stringify({ backend: device.backend, device: device.name, sampleRate: rate,
                    result: 'PASS', checks: 'open, clock, pause, seek, resume, EOF, replay, stale session, stop', signal: 'silence' }));
            }
        }
    } finally { helper.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
