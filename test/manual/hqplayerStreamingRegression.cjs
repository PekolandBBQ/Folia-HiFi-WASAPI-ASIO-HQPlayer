const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Real packaged renderer + Omni providers + native hardware. Never logs signed URLs or account data.
async function main() {
    const executablePath = path.resolve(process.argv[2]);
    const output = path.resolve(process.argv[3]); fs.mkdirSync(output, { recursive: true });
    const provider = process.env.FOLIA_STREAM_PROVIDER || 'netease';
    const silent = process.env.FOLIA_TEST_SILENT === 'true';
    const assetFiles = fs.readdirSync(path.resolve('dist/assets'));
    const chunks = Object.fromEntries(['bootstrap', 'omni', 'resourceCache', 'usePlaybackStore'].map(prefix =>
        [prefix, assetFiles.find(name => name.startsWith(prefix + '-') && name.endsWith('.js'))]));
    const app = await _electron.launch({ executablePath, timeout: 60000 });
    const result = { provider, silent, phases: [] }, diagnostics = [];
    app.process().stderr.on('data', data => { if (/Native audio error|could not be cloned/.test(String(data))) diagnostics.push(String(data)); });
    let page, originalSilent;
    try {
        page = await app.firstWindow(); page.setDefaultTimeout(25000);
        await page.waitForFunction(() => window.electron?.nativeAudio && document.querySelector('#root')?.children.length);
        originalSilent = await page.evaluate(() => localStorage.getItem('folia_hqplayer_silent_launch'));
        await page.evaluate(() => {
            // This regression tests playback, not the upstream first-run introduction.
            localStorage.setItem('folia_last_seen_ponder_onboarding_version', '0.7.9');
            localStorage.setItem('folia_last_seen_guide_version', '0.7.9');
        });
        await page.evaluate(silent => localStorage.setItem('folia_hqplayer_silent_launch', String(silent)), silent);
        await page.reload();
        await page.waitForFunction(() => window.electron?.nativeAudio && document.querySelector('#root')?.children.length);
        await page.keyboard.press('Escape');
        result.identity = await app.evaluate(({ app }) => ({ version: app.getVersion(), profile: app.getPath('userData') }));
        result.component = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-status' }));
        if (!result.component.available) {
            await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-component-install' }));
            result.component = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-status' }));
        }
        assert.equal(result.component.component.version, '0.1.2');
        // Start from a closed Desktop for a genuine cold launch, after verifying the installed component.
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-shutdown' }));
        result.songs = await page.evaluate(async ({ chunks, provider }) => {
            const modules = await Promise.all(Object.values(chunks).map(file => import(new URL('./assets/' + file, location.href).href)));
            const values = modules.flatMap(module => Object.values(module));
            const stores = values.filter(value => typeof value?.getState === 'function');
            const find = key => stores.find(store => key in store.getState());
            const player = find('currentSong'), settings = find('nativeAudioBackend'), hqp = find('dspDefaults'), loading = stores.find(store => 'owner' in store.getState() && 'startedAt' in store.getState());
            if (!player || !settings) throw new Error('Cannot inspect packaged playback stores');
            const omni = values.find(value => typeof value?.searchProviderSongs === 'function');
            const original = { backend: settings.getState().nativeAudioBackend, deviceId: settings.getState().nativeAudioDeviceId,
                volume: settings.getState().volume, muted: settings.getState().isMuted, gain: hqp?.getState().gainDb, defaults: hqp?.getState().dspDefaults };
            player.setState({ playerState: 'PAUSED', audioSrc: null, currentSong: null });
            settings.setState({ nativeAudioBackend: 'browser', nativeAudioDeviceId: '', volume: 0.03, isMuted: false, showAudioSignalPath: true });
            hqp?.setState({ gainDb: -35, dspDefaults: null });
            const events = []; const off = window.electron.nativeAudio.onEvent(event => events.push(event));
            window.__hqpRegression = { player, settings, hqp, loading, original, events, off, tracks: [] };
            const searches = []; window.__hqpRegression.searches = searches;
            for (const query of provider === 'qq' ? ['HIMEHINA', '许嵩', '纯音乐'] : ['HIMEHINA']) {
                const found = await omni.searchProviderSongs(provider, query, { limit: 8, offset: 0 });
                searches.push({ query, found: found.items.length, playable: 0 });
                for (const song of found.items) {
                    const source = await omni.getAudioSource(song, 'standard');
                    if (source?.url) { window.__hqpRegression.tracks.push({ song, url: source.url }); searches.at(-1).playable++; }
                    if (window.__hqpRegression.tracks.length === 2) break;
                }
                if (window.__hqpRegression.tracks.length === 2) break;
            }
            if (window.__hqpRegression.tracks.length < 2) throw new Error(`${provider} did not provide two playable sources`);
            return window.__hqpRegression.tracks.map(({ song }) => ({ id: song.id, title: song.name }));
        }, { chunks, provider });
        console.log(provider, 'sources resolved through Omni:', JSON.stringify(result.songs));
        if (await page.getByTestId('release-notes-close').isVisible()) await page.getByTestId('release-notes-close').click();
        const confirmView = page.getByRole('button', { name: '就这样', exact: true });
        if (await confirmView.isVisible()) await confirmView.click();
        await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
        for (const [label, index] of [['cold-stream', 0], ['repeat-stream', 0], ['next-stream', 1]]) {
            const started = Date.now();
            await page.evaluate(async index => {
                const q = window.__hqpRegression;
                q.player.setState({ audioSrc: null, playerState: 'PAUSED' });
                await new Promise(resolve => setTimeout(resolve, 200)); q.events.length = 0;
                await q.settings.getState().handleSetNativeAudioOutput('hqplayer', 'hqplayer-local');
                const { song, url } = q.tracks[index];
                q.player.setState({ currentSong: song, audioSrc: url, playerState: 'PAUSED', playQueue: q.tracks.map(track => track.song) });
            }, index);
            await page.waitForFunction(() => window.__hqpRegression.events.some(event => event.state?.duration > 0), null, { timeout: 60000 });
            await page.keyboard.press('Space');
            await page.waitForFunction(() => window.__hqpRegression.events.some(event => event.state?.playing && event.state.position > 2), null, { timeout: 60000 });
            const phase = await page.evaluate(() => {
                const q = window.__hqpRegression;
                return { state: q.events.filter(event => event.state).at(-1)?.state,
                    progress: q.events.filter(event => event.event === 'progress').map(event => event.progress),
                    errors: q.events.filter(event => event.event === 'error'), visibleProgress: (q.loading ? q.loading.getState().progress : document.querySelector('progress') ? { visible: true } : null) };
            });
            assert.equal(phase.errors.length, 0); assert.equal(phase.visibleProgress, null);
            if (label === 'cold-stream') {
                result.windows = require('./hqplayerWindowState.cjs').hqplayerWindowState();
                assert.equal(result.windows.pids.length, 1);
                assert.equal(result.windows.windows.some(window => window.visible && !window.minimized), !silent);
            }
            result.phases.push({ label, elapsedMs: Date.now() - started, ...phase });
            console.log('PASS', label, Date.now() - started);
        }
        // Use a full-length source for repeated window/seek checks; the trial source was tested above.
        await page.evaluate(async () => {
            const q = window.__hqpRegression;
            q.player.setState({ audioSrc: null, playerState: 'PAUSED' });
            await new Promise(resolve => setTimeout(resolve, 200)); q.events.length = 0;
            const { song, url } = q.tracks[0];
            q.player.setState({ currentSong: song, audioSrc: url, playerState: 'PAUSED' });
        });
        await page.waitForFunction(() => window.__hqpRegression.events.some(e => e.state?.duration > 0), null, { timeout: 60000 });
        await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__hqpRegression.events.some(e => e.state?.playing && e.state.position > 2), null, { timeout: 60000 });
        // Use the real floating panel while paused and playing; a settings restart must preserve the checkpoint.
        if (await confirmView.isVisible()) await confirmView.click();
        for (const paused of [true, false]) {
            await page.evaluate(async paused => {
                const q = window.__hqpRegression;
                const session = q.events.filter(event => event.state).at(-1).session;
                await window.electron.nativeAudio.request({ action: 'seek', session, position: paused ? 12 : 6 });
            }, paused);
            await page.waitForFunction(position => {
                const current = window.__hqpRegression.events.filter(event => event.state).at(-1)?.state.position;
                return Math.abs(current - position) < 2;
            }, paused ? 12 : 6);
            if (paused) { await page.keyboard.press('Space'); await page.waitForFunction(() => window.__hqpRegression.player.getState().playerState === 'PAUSED'); }
            const checkpoint = await page.evaluate(() => window.__hqpRegression.events.filter(event => event.state).at(-1).state.position);
            await page.getByRole('button', { name: 'HQPlayer设置', exact: true }).click();
            await page.getByRole('button', { name: '目标采样率', exact: true }).waitFor();
            await page.evaluate(() => { window.__hqpRegression.events.length = 0; });
            await page.getByRole('button', { name: '应用到当前歌曲', exact: true }).click();
            await page.waitForFunction(checkpoint => {
                const q = window.__hqpRegression, state = q.events.filter(event => event.state).at(-1)?.state;
                return q.events.some(event => event.event === 'resume') && q.player.getState().playerState === 'PLAYING'
                    && state?.playing && state.position > checkpoint + 1;
            }, checkpoint, { timeout: 60000 });
            const state = await page.evaluate(() => window.__hqpRegression.events.filter(event => event.state).at(-1).state);
            assert.ok(state.position < checkpoint + 8, 'DSP restart lost its checkpoint');
            result.phases.push({ label: paused ? 'apply-while-paused' : 'apply-while-playing', checkpoint, state });
            console.log('PASS', paused ? 'apply-while-paused' : 'apply-while-playing', checkpoint, state.position);
            await page.keyboard.press('Escape');
            await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
        }
        await page.getByRole('button', { name: 'HQPlayer设置', exact: true }).click();
        await page.getByRole('button', { name: '目标采样率', exact: true }).waitFor();
        const windowSwitch = page.getByRole('switch', { name: '显示 HQPlayer 窗口', exact: true });
        await windowSwitch.waitFor();
        const beforeWindow = require('./hqplayerWindowState.cjs').hqplayerWindowState();
        for (const visible of [!beforeWindow.windows.some(w => w.visible && !w.minimized), beforeWindow.windows.some(w => w.visible && !w.minimized)]) {
            await windowSwitch.click();
            await page.waitForFunction(visible => document.querySelector('[role="switch"][aria-label="显示 HQPlayer 窗口"]')?.getAttribute('aria-checked') === String(visible), visible);
            const actual = require('./hqplayerWindowState.cjs').hqplayerWindowState();
            assert.deepEqual(actual.pids, beforeWindow.pids);
            assert.equal(actual.windows.some(w => w.visible && !w.minimized), visible);
            assert.equal(await page.evaluate(() => window.__hqpRegression.player.getState().playerState), 'PLAYING');
            result.phases.push({ label: visible ? 'show-window' : 'hide-window', pids: actual.pids, visible, playing: true });
        }
        await page.screenshot({ path: path.join(output, 'packaged-hqplayer-settings.png') });
        await page.keyboard.press('Escape');
        const browserCheckpoint = await page.evaluate(() => window.__hqpRegression.events.filter(e => e.state).at(-1).state.position);
        await page.evaluate(async () => {
            const q = window.__hqpRegression; await q.settings.getState().handleSetNativeAudioOutput('browser', '');
        });
        await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(audio => audio.readyState >= 3), null, { timeout: 30000 });
        await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(audio => !audio.paused && audio.currentTime > 1), null, { timeout: 30000 });
        const browserPosition = await page.evaluate(() => [...document.querySelectorAll('audio')].find(a => !a.paused).currentTime);
        assert.ok(browserPosition >= browserCheckpoint - 1 && browserPosition < browserCheckpoint + 8, 'Browser lost output-switch checkpoint');
        const remaining = await require('../../../folia-hqplayer-component/src/hqplayerInstance.cjs').findRunningHQPlayers();
        assert.equal(remaining.length, 0);
        result.phases.push({ label: 'browser-after-hqplayer', playing: true, remainingHQPlayers: 0 });
        result.devices = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'devices' }));
        for (const backend of ['wasapi-exclusive', 'asio']) {
            const device = result.devices.find(item => item.backend === backend && /XingCore/.test(item.name));
            assert.ok(device, `Missing hardware for ${backend}`);
            await page.evaluate(async () => {
                const q = window.__hqpRegression;
                q.player.setState({ audioSrc: null, playerState: 'PAUSED' });
                await new Promise(resolve => setTimeout(resolve, 200)); q.events.length = 0;
                await q.settings.getState().handleSetNativeAudioOutput('hqplayer', 'hqplayer-local');
                const { song, url } = q.tracks[0];
                q.player.setState({ currentSong: song, audioSrc: url, playerState: 'PAUSED' });
            });
            await page.waitForFunction(() => window.__hqpRegression.events.some(event => event.state?.backend === 'hqplayer' && event.state.duration > 0), null, { timeout: 60000 });
            await page.keyboard.press('Space');
            await page.waitForFunction(() => window.__hqpRegression.events.some(event => event.state?.backend === 'hqplayer' && event.state.playing && event.state.position > 2), null, { timeout: 60000 });
            const checkpoint = await page.evaluate(() => window.__hqpRegression.events.filter(e => e.state).at(-1).state.position);
            const started = Date.now();
            await page.evaluate(async device => {
                const q = window.__hqpRegression; q.events.length = 0;
                await q.settings.getState().handleSetNativeAudioOutput(device.backend, device.id);
            }, device);
            assert.equal((await require('../../../folia-hqplayer-component/src/hqplayerInstance.cjs').findRunningHQPlayers()).length, 0);
            // Native helpers emit clock events only while playing; load replies update the signal path.
            await page.waitForFunction(() => /kHz/.test(document.querySelector('[data-signal-path]')?.textContent || ''), null, { timeout: 30000 });
            await page.waitForFunction(backend => window.__hqpRegression.events.some(event => event.state?.backend === backend && event.state.playing && event.state.position > 2), backend, { timeout: 60000 });
            const phase = await page.evaluate(backend => ({
                state: window.__hqpRegression.events.filter(event => event.state?.backend === backend).at(-1)?.state,
                errors: window.__hqpRegression.events.filter(event => event.event === 'error'),
            }), backend);
            assert.equal(phase.errors.length, 0);
            assert.ok(phase.state.position >= checkpoint - 1 && phase.state.position < checkpoint + 8, 'Native output lost checkpoint');
            result.phases.push({ label: `${backend}-after-hqplayer`, elapsedMs: Date.now() - started, remainingHQPlayers: 0, ...phase });
            console.log('PASS', backend, Date.now() - started);
            const resumePoint = phase.state.position;
            await page.evaluate(async () => { const q = window.__hqpRegression; q.events.length = 0; await q.settings.getState().handleSetNativeAudioOutput('hqplayer', 'hqplayer-local'); });
            await page.waitForFunction(position => window.__hqpRegression.events.some(e => e.state?.backend === 'hqplayer' && e.state.playing && e.state.position > position + 1), resumePoint, { timeout: 60000 });
            const restored = await page.evaluate(() => window.__hqpRegression.events.filter(e => e.state).at(-1).state);
            assert.ok(restored.position < resumePoint + 8, 'Returning to HQPlayer lost checkpoint');
            result.phases.push({ label: 'hqplayer-after-' + backend, checkpoint: resumePoint, state: restored });
            console.log('PASS', 'hqplayer-after-' + backend, resumePoint, restored.position);
        }
        result.status = 'PASS';
    } catch (error) {
        result.status = 'FAIL'; result.error = error.message;
        if (page) result.last = await page.evaluate(() => {
            const q = window.__hqpRegression;
            return { searches: q?.searches, events: q?.events.slice(-12), progress: q?.loading?.getState(), playerState: q?.player.getState().playerState,
                text: document.body.innerText.slice(-2200) };
        }).catch(() => null);
        throw error;
    } finally {
        if (page) await page.evaluate(async () => {
            const q = window.__hqpRegression; if (!q) return;
            q.player.setState({ audioSrc: null, currentSong: null, playerState: 'PAUSED' });
            await q.settings.getState().handleSetNativeAudioOutput('browser', '');
            q.settings.setState({ volume: q.original.volume, isMuted: q.original.muted });
            q.hqp?.setState({ gainDb: q.original.gain, dspDefaults: q.original.defaults }); q.off();
        }).catch(() => {});
        if (page && originalSilent !== undefined) await page.evaluate(value => {
            if (value === null) localStorage.removeItem('folia_hqplayer_silent_launch');
            else localStorage.setItem('folia_hqplayer_silent_launch', value);
        }, originalSilent).catch(() => {});
        await app.close();
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(output, 'native-diagnostics.log'), diagnostics.join(''));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
