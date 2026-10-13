const { app, session } = require('electron');
require('../../electron/debug/consolePipeGuard.cjs').installConsolePipeGuard();
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { registerNativeAudio } = require('../../electron/nativeAudio/service.cjs');
const { createHQPlayerComponentHost } = require('../../electron/hqplayer/client.cjs');

// Actual Electron session fetch, FFmpeg, growing cache, binary helper pipe and real DAC together.
app.setPath('userData', path.resolve('../artifacts/native-streaming-20261002/service-profile'));
const report = { started: new Date().toISOString(), scope: 'actual-service-synthetic-stream', results: [] };
const backends = process.env.FOLIA_SERVICE_PROBE_BACKEND ? [process.env.FOLIA_SERVICE_PROBE_BACKEND] : ['wasapi-exclusive', 'asio'];
const formats = process.env.FOLIA_SERVICE_PROBE_FORMAT ? [process.env.FOLIA_SERVICE_PROBE_FORMAT] : ['wav', 'flac'];
app.whenReady().then(async () => {
    const { fixtures, slowServer } = await import('../../../folia-native-audio-component/experiments/streaming/probeFixtures.mjs');
    const { sleep } = await import('../../../folia-native-audio-component/experiments/streaming/probeSupport.mjs');
    const ffmpeg = path.resolve('../artifacts/Folia-HiFi-0.7.12-final/win-unpacked/resources/ffmpeg-audio/ffmpeg.exe');
    const duration = backends.includes('hqplayer') ? 24 : 8;
    const files = fixtures(ffmpeg, { seconds: duration });
    const sender = { isDestroyed: () => false, session: session.defaultSession, send: (_channel, value) => { events.push(value); } };
    let events = [];
    let hqFacade;
    const service = registerNativeAudio({ app, ipcMain: { handle: () => {} }, isTrustedSender: value => value === sender,
        componentManager: { status: async () => ({ available: true, version: '0.1.3-preview.1',
            executable: path.resolve('../folia-native-audio-component/artifacts/streaming-preview/folia-audio.exe') }) },
        hqplayerFactory: options => (hqFacade = createHQPlayerComponentHost({ ...options,
            manager: { status: async () => ({ available: true,
                version: require('../../../folia-hqplayer-component/component.json').version,
                executable: path.resolve('../folia-hqplayer-component/src/worker.cjs') }) } })),
        decoderResolver: async () => ffmpeg });
    const request = payload => service.handle({ sender }, payload);
    try {
        const devices = backends.every(backend => backend === 'hqplayer') ? [] : await request({ action: 'devices' });
        for (const backend of backends) for (const format of formats) {
            const result = { backend, format, passed: false, timeline: [] }, server = await slowServer(files[format], backend === 'hqplayer' ? { intervalMs: 80, stallMs: 60000, manualStall: true } : {});
            const id = `service-${backend}-${format}`;
            const command = (action, args = {}) => request({ action, session: id, ...args });
            const device = backend === 'hqplayer' ? { id: 'hqplayer-local' } : devices.find(item => item.backend === backend && /XingCore/i.test(item.name));
            events = []; const start = Date.now();
            const latest = () => events.filter(event => event.state?.session === id).at(-1)?.state;
            try {
                assert.ok(device, 'Test DAC unavailable');
                await command('begin', { backend, deviceId: device.id, processingMode: 'integer-direct', url: server.url, duration, silent: true, hqplayerGainDb: -35 });
                const ready = await command('finish');
                result.readyMs = Date.now() - start; result.bytesFractionAtReady = server.state.sent / files[format].length;
                assert.equal(ready.streaming, true); assert.ok(ready.bufferedEnd > 0 && ready.bufferedEnd < duration);
                assert.ok(!server.state.finished, 'Finish waited for full download');
                // A Play acknowledgement may itself wait for DSP priming; the network
                // fixture must be able to stall while that request is outstanding.
                server.state.playing = true; result.playRequestedMs = Date.now() - start;
                await command('play'); result.playAcknowledgedMs = Date.now() - start;
                let paused = false, starved = false, held, sampledAt = 0, lastBuffering;
                while (Date.now() - start < (backend === 'hqplayer' ? 140000 : 26000)) {
                    assert.equal(events.some(event => event.event === 'error'), false, 'Service error');
                    const state = latest();
                    if (state && (Date.now() - sampledAt >= 750 || state.buffering !== lastBuffering)) {
                        result.timeline.push({ ms: Date.now() - start, position: state.position, bufferedEnd: state.bufferedEnd, hostDecodedEnd: state.streamDecodedEnd,
                            buffering: state.buffering, playing: state.playing, complete: state.producerComplete,
                            downloadedFraction: server.state.sent / files[format].length });
                        sampledAt = Date.now(); lastBuffering = state.buffering;
                    }
                    if (state?.position > 0.8 && !paused) {
                        await command('pause'); await sleep(120); const before = latest().position;
                        await sleep(200); assert.equal(latest().position, before, 'Paused clock moved');
                        await command('play'); paused = true; result.pauseResume = true;
                    }
                    if (state?.buffering) {
                        starved = true;
                        if (held === state.position) { result.starvedClockHeld = true; server.resume(); }
                        held = state.position;
                    } else if (starved && state?.position > held) result.starvationResumed = true;
                    if (state?.ended) { result.ended = state; break; }
                    await sleep(60);
                }
                result.network = { ...server.state };
                assert.ok(result.ended, 'Missing true ended event'); assert.equal(result.ended.position, duration);
                assert.ok(result.starvedClockHeld && result.starvationResumed, 'Network underrun/resume not observed');
                // The real compressed decoder now restarts at a cached-song timestamp, with the app still paused.
                const seeked = await command('seek', { position: 4 });
                assert.equal(seeked.playing, false); assert.equal(seeked.position, 4); assert.equal(seeked.streamGeneration, ready.streamGeneration + 1);
                const seekStart = Date.now(); await command('play');
                // HQPlayer reports real DSP latency (currently about one second
                // on this DAC). Require actual advancement within a bound, rather
                // than expecting its output clock to advance after only 700ms.
                const resumed = state => state?.streamGeneration === seeked.streamGeneration && state.playing
                    && !state.ended && state.position >= 4.4 && state.position < duration;
                while (!resumed(latest()) && Date.now() - seekStart < 8000) await sleep(60);
                assert.ok(resumed(latest()), 'Cached seek did not resume through the real output generation');
                result.seekResumeMs = Date.now() - seekStart;
                result.decoderSeek = latest(); result.passed = true;
            } catch (error) { result.error = error.message; result.last = latest(); result.network = { ...server.state }; result.errors = events.filter(event => event.event === 'error'); }
            finally { await command('stop').catch(() => {}); server.close(); }
            report.results.push(result); const { timeline, ...summary } = result; console.log(JSON.stringify(summary));
        }
    } catch (error) { report.error = error.message; }
    finally {
        const file = path.resolve(`../artifacts/native-streaming-20261002/service-${Date.now()}.json`);
        await fs.writeFile(file, JSON.stringify(report, null, 2)); console.log(file);
        if (backends.includes('hqplayer')) await request({ action: 'hqplayer-shutdown' }).catch(() => {});
        await hqFacade?.dispose();
        process.exitCode = report.error || report.results.length !== backends.length * formats.length || report.results.some(item => !item.passed) ? 1 : 0;
        app.exit(process.exitCode);
    }
});
