const http = require('node:http');
const crypto = require('node:crypto');

// test/manual/nativeAudioAppChecks.cjs — authenticated session boundary and App-to-driver gain assertions.
async function runAppChecks(page, record) {
    const bytes = Buffer.alloc(44 + 4800 * 4);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32);
    bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    let marker = '', observed = [];
    const server = http.createServer((request, response) => {
        const authenticated = request.headers.cookie?.split(';').some(c => c.trim() === `folia_review_auth=${marker}`) || false;
        observed.push(authenticated);
        response.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'audio/wav' });
        response.end(authenticated ? bytes : Buffer.from('Authentication required'));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await page.evaluate(() => { const r = window.__appReview; r.active()?.pause(); r.settings.getState().handleSetNativeAudioOutput('browser', ''); });
        await page.waitForTimeout(200);
        for (const backend of ['wasapi-exclusive', 'asio']) {
            marker = crypto.randomUUID(); observed = [];
            await record(`${backend}-session-cookie-negative-positive`, '同一会话无 Cookie 拒绝，有 Cookie 才能准备音频', 'Missing cookie is rejected; authenticated Electron session prepares audio', async () => {
                const result = await page.evaluate(async ({ backend, marker, url }) => {
                    const r = window.__appReview, api = window.electron.nativeAudio;
                    const device = r.devices.find(d => d.backend === backend);
                    document.cookie = 'folia_review_auth=; path=/; Max-Age=0';
                    let rejectedCode, prepared;
                    for (const authenticated of [false, true]) {
                        if (authenticated) document.cookie = `folia_review_auth=${marker}; path=/; SameSite=Lax`;
                        const session = crypto.randomUUID();
                        try {
                            await api.request({ action: 'begin', session, backend, deviceId: device.id, url });
                            prepared = await api.request({ action: 'finish', session });
                            if (!authenticated) throw new Error('Unauthenticated source unexpectedly accepted');
                        } catch (error) {
                            if (authenticated) throw error;
                            rejectedCode = error.message;
                        } finally { await api.request({ action: 'stop', session }); }
                    }
                    document.cookie = 'folia_review_auth=; path=/; Max-Age=0';
                    return { rejectedCode, sourceRate: prepared?.sourceSampleRate };
                }, { backend, marker, url: `http://localhost:${server.address().port}/cookie-${marker}.wav` });
                if (result.rejectedCode !== 'SOURCE_EXPIRED' || result.sourceRate !== 48000 || observed.length !== 2 || observed[0] !== false || observed[1] !== true)
                    throw new Error('Cookie isolation or authentication assertion failed');
                return { ...result, anonymousRejected: true, authenticatedAccepted: true, independentRequests: observed.length, layer: 'real-Electron-session-IPC' };
            });
            for (const processingMode of ['compatibility', 'integer-direct']) {
                await page.evaluate(async ({ backend, processingMode }) => {
                    const r = window.__appReview;
                    r.settings.getState().handleSetNativeAudioProcessingMode(processingMode);
                    r.settings.getState().handleSetNativeAudioOutput(backend, r.devices.find(d => d.backend === backend).id);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await r.playEntry()(r.song, [r.song], false, { shouldNavigateToPlayer: false });
                }, { backend, processingMode });
                await page.waitForFunction(() => { const t = window.__appReview.active(); return t?.readyState === 4 && !t.paused; }, { timeout: 25000 });
                for (const scenario of [
                    { name: 'off', mode: 'off', metadata: { trackGain: -6, albumGain: -12 }, gain: 1 },
                    { name: 'track', mode: 'track', metadata: { trackGain: -6, albumGain: -12 }, gain: 10 ** (-6 / 20) },
                    { name: 'album', mode: 'album', metadata: { trackGain: -6, albumGain: -12 }, gain: 10 ** (-12 / 20) },
                    { name: 'album-fallback', mode: 'album', metadata: { trackGain: -6 }, gain: 10 ** (-6 / 20) },
                    { name: 'missing', mode: 'track', metadata: {}, gain: 1 },
                ]) await record(`${backend}-${processingMode}-gain-${scenario.name}`, '已知元数据经 App ReplayGain 设置到真实输出引擎', 'Known metadata passes through App ReplayGain settings to the real engine', async () => {
                    await page.evaluate(scenario => {
                        const r = window.__appReview;
                        r.states.length = 0;
                        r.playback.setState(s => ({ currentSong: { ...s.currentSong, replayGain: scenario.metadata }, replayGainMode: scenario.mode }));
                    }, scenario);
                    await page.waitForFunction(gain => {
                        const r = window.__appReview, t = r.active(), state = r.states.findLast(s => s.session === t?.session);
                        return state && Math.abs(state.replayGain - gain) < .00002 && Math.abs(state.effectiveGain - gain * .1) < .00002;
                    }, scenario.gain, { timeout: 5000 });
                    return page.evaluate(() => { const r = window.__appReview, state = r.states.findLast(s => s.session === r.active()?.session);
                        return { replayGain: state.replayGain, volume: state.volume, effectiveGain: state.effectiveGain,
                            processingMode: state.processingMode, metadataSource: 'known-test-metadata-in-memory-no-file-tags-written' }; });
                });
                await page.evaluate(() => window.__appReview.active()?.pause());
            }
            await page.evaluate(() => window.__appReview.settings.getState().handleSetNativeAudioOutput('browser', ''));
            await page.waitForTimeout(200);
        }
        await record('browser-without-component', '停用组件后原 App 浏览器播放、定位、暂停和循环', 'Original App browser playback, seek, pause and loop with component deactivated', async () => {
            await page.evaluate(async () => {
                const r = window.__appReview;
                await window.electron.nativeAudio.request({ action: 'component-uninstall' });
                r.states.length = 0;
                await r.playEntry()(r.song, [r.song], false, { shouldNavigateToPlayer: false });
            });
            await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > .2), { timeout: 25000 });
            await page.evaluate(() => { document.querySelectorAll('audio').forEach(a => { if (!a.paused) { window.__appReview.web = a; a.currentTime = 3; } }); });
            await page.waitForFunction(() => !window.__appReview.web.seeking && window.__appReview.web.currentTime >= 3);
            await page.evaluate(() => window.__appReview.web.pause());
            await page.waitForFunction(() => window.__appReview.playback.getState().playerState === 'PAUSED');
            await page.evaluate(async () => {
                const r = window.__appReview; r.previousLoop = r.settings.getState().loopMode;
                r.settings.setState({ loopMode: 'one' }); await r.web.play();
            });
            await page.waitForFunction(() => window.__appReview.web.loop);
            await page.evaluate(() => { const a = window.__appReview.web; a.currentTime = a.duration - .2; });
            await page.waitForFunction(() => { const a = window.__appReview.web; return !a.paused && a.currentTime < 2; }, { timeout: 8000 });
            const state = await page.evaluate(async () => {
                const r = window.__appReview, status = await window.electron.nativeAudio.request({ action: 'status' });
                const result = { installed: status.installed, nativeEvents: r.states.length, position: r.web.currentTime, looped: r.web.loop,
                    sameSong: r.getPlaybackSongKey(r.playback.getState().currentSong) === r.getPlaybackSongKey(r.song) };
                r.web.pause(); r.settings.setState({ loopMode: r.previousLoop });
                await window.electron.nativeAudio.request({ action: 'component-install' });
                return result;
            });
            if (state.installed || state.nativeEvents !== 0 || !state.sameSong) throw new Error('Component leaked into browser baseline');
            return state;
        });
    } finally {
        await page.evaluate(() => { const r = window.__appReview; r.active()?.pause(); r.playback.setState({ replayGainMode: 'off' });
            r.settings.getState().handleSetNativeAudioProcessingMode('compatibility'); document.cookie = 'folia_review_auth=; path=/; Max-Age=0'; });
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
module.exports = { runAppChecks };
