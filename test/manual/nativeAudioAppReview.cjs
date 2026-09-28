const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// test/manual/nativeAudioAppReview.cjs — real App event orchestration; never invokes recovery controllers directly.
async function main() {
    const provider = process.argv.find(v => v.startsWith('--provider='))?.split('=')[1] || 'qq';
    const output = path.resolve('test-results/native-audio-review', `app-${provider}-${Date.now()}`);
    await fs.mkdir(output, { recursive: true });
    const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    await fs.writeFile(path.join(output, 'environment.json'), JSON.stringify({
        startedAt: new Date().toISOString(), hostCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        changes: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n'),
        scriptSha256: await hash(__filename), ffmpegSha256: await hash('build/ffmpeg/win-x64/ffmpeg.exe'),
        componentCatalogSha256: await hash('../folia-native-audio-component/artifacts/development-catalog.json'),
        componentExecutableSha256: await hash('../folia-native-audio-component/artifacts/publish/folia-audio.exe'),
        faultScriptSha256: await hash(path.join(__dirname, 'nativeAudioAppFaults.cjs')),
        checksScriptSha256: await hash(path.join(__dirname, 'nativeAudioAppChecks.cjs')),
        layer: 'real-app-real-component', fault: 'controlled-local-http-403',
    }, null, 2));
    let requests = 0;
    const server = http.createServer((_q, r) => { requests++; r.writeHead(403); r.end('Controlled expiry / 受控过期'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.connectOverCDP('http://127.0.0.1:19333').catch(error => {
        server.close(); throw error;
    });
    const page = browser.contexts()[0].pages().find(p => p.url().startsWith('http://localhost:3000/'));
    const records = [];
    const startup = [];
    page.on('console', message => {
        if (/\[Session\]|Failed to restore|Session restore/.test(message.text())) startup.push({ at: Date.now(), text: message.text().replace(/https?:\/\/\S+/g, '[URL]') });
    });
    const provenance = JSON.parse(await fs.readFile(path.join(output, 'environment.json'), 'utf8'));
    provenance.installedComponent = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' })).then(s => ({ version: s.version, installed: s.installed }));
    await fs.writeFile(path.join(output, 'environment.json'), JSON.stringify(provenance, null, 2));
    async function record(id, zh, en, task) {
        const start = Date.now(); let data;
        try { data = { status: 'PASS', ...await task() }; }
        catch (error) { data = { status: 'FAIL', code: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 180),
            observation: await page.evaluate(() => {
                const r = window.__appReview, t = r?.active(), s = r?.playback.getState();
                return { ready: t?.readyState, errorCode: t?.error?.message, paused: t?.paused, position: t?.currentTime,
                    sourceScheme: t?.src.split(':')[0], sourceSameStore: t?.src === s?.audioSrc,
                    sessionChanged: t?.session !== r?.beforeSession, playerState: s?.playerState,
                    sameSong: s?.currentSong && r.getPlaybackSongKey(s.currentSong) === r.expectedKey };
            }).catch(() => null) }; }
        const row = { zh, en, elapsedMs: Date.now() - start, ...data, id };
        if (id.includes('-real-dialog-')) await page.waitForTimeout(450);
        await page.screenshot({ path: path.join(output, `${id}.png`) });
        records.push(row); await fs.writeFile(path.join(output, 'provider-results.json'), JSON.stringify(records, null, 2));
        await fs.writeFile(path.join(output, 'startup-trace.json'), JSON.stringify({ console: startup, changes: await page.evaluate(() => window.__appReview?.trace || []) }, null, 2));
        console.log(JSON.stringify(row)); return row;
    }
    try {
        await page.reload();
        await page.waitForFunction(() => !!window.electron?.nativeAudio, { timeout: 20000 });
        await page.evaluate(async provider => {
            const resources = performance.getEntriesByType('resource').map(e => e.name);
            const loadedModule = p => resources.findLast(name => new URL(name).pathname === p) || p;
            const { usePlaybackStore: playback } = await import(loadedModule('/src/stores/usePlaybackStore.ts'));
            const { useAudioSettingsStore: settings } = await import(loadedModule('/src/stores/useAudioSettingsStore.ts'));
            const { getPlaybackSongKey } = await import('/src/utils/appPlaybackGuards.ts');
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            const saved = settings.getState();
            window.__appReview = { transports: [], states: [], playback, settings, getPlaybackSongKey,
                saved: { volume: saved.volume, isMuted: saved.isMuted, backend: saved.nativeAudioBackend, device: saved.nativeAudioDeviceId } };
            const review = window.__appReview;
            review.trace = [];
            review.traceUnsubscribe = playback.subscribe((s, p) => {
                if (s.currentSong !== p.currentSong || s.audioSrc !== p.audioSrc || s.playerState !== p.playerState) review.trace.push({ at: Date.now(), song: s.currentSong?.name, key: s.currentSong && getPlaybackSongKey(s.currentSong), state: s.playerState, scheme: s.audioSrc?.split(':')[0], stack: new Error().stack?.split('\n').slice(2, 9).map(line => line.replace(/https?:\/\/[^/]+/g, '[origin]')) });
            });
            review.unsubscribe = window.electron.nativeAudio.onEvent(e => {
                if (e.state) review.states.push({ ...e.state, receivedAt: performance.now() });
                if (review.states.length > 1000) review.states.shift();
            });
            review.devices = (await window.electron.nativeAudio.request({ action: 'devices' })).filter(d => /XingCore/i.test(d.name));
            review.active = () => {
                const root = document.querySelector('#root');
                const key = Object.keys(root).find(k => k.startsWith('__reactContainer'));
                let transport;
                function walk(f) {
                    if (!f || transport) return;
                    if (f.type?.name === 'NativeDeck') for (let hook = f.memoizedState; hook; hook = hook.next) {
                        const value = hook.memoizedState?.current;
                        if (value?.nativeAudio && !value.disposed && value.src) transport = value;
                    }
                    walk(f.child); walk(f.sibling);
                }
                walk(root[key].stateNode.current);
                return transport;
            };
            review.playEntry = () => {
                const root = document.querySelector('#root');
                const key = Object.keys(root).find(k => k.startsWith('__reactContainer'));
                let entry;
                function walk(f) {
                    if (!f || entry) return;
                    if (f.type?.name === 'Grid3D' && typeof f.memoizedProps?.onPlaySong === 'function') entry = f.memoizedProps.onPlaySong;
                    walk(f.child); walk(f.sibling);
                }
                walk(root[key].stateNode.current);
                if (!entry) throw new Error('Production playback entry unavailable');
                return entry;
            };
            if (provider === 'navidrome') {
                const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
                const { buildUnifiedNavidromeSong } = await import('/src/services/playbackAdapters.ts');
                const config = getNavidromeConfig();
                const song = await navidromeApi.getSong(config, '32sKZLBKwLBsaPv1R0taFe');
                if (!song) throw new Error('Fixed Navidrome sample unavailable');
                review.song = buildUnifiedNavidromeSong(navidromeApi.toNavidromeSong(config, song));
                settings.setState({ enableTranscodeFallback: true });
            } else {
            const songs = provider === 'qq'
                ? await omni.getCollectionTracks({ providerId: provider, id: '9614955116', type: 'playlist' }, { limit: 5, offset: 0 })
                : await omni.searchProviderSongs(provider, '晴天', { limit: 5, offset: 0 });
            review.song = songs.items.find(s => omni.canPlaySong(s));
            }
            if (!review.song) throw new Error('No playable account track');
            settings.setState({ volume: 0.1, isMuted: false });
            settings.getState().handleSetNativeAudioOutput('browser', '');
            // Clear the restored track before changing backends; setup must not race a previous load.
            playback.setState({ audioSrc: null, currentSong: null, playerState: 'IDLE' });
        }, provider);
        for (const backend of ['wasapi-exclusive', 'asio']) {
            const selected = await record(`${provider}-${backend}-app-play`, '通过真实 App 播放入口开始固定曲目', 'Start a fixed track through the production App entry', async () => {
                await page.evaluate(async ({ backend, provider }) => {
                    const r = window.__appReview, device = r.devices.find(d => d.backend === backend);
                    if (!device) throw new Error('Missing hardware backend');
                    if (provider === 'navidrome') (await import('/src/services/playbackRecovery/representationRegistry.ts')).clearPlaybackRepresentationsForTests();
                    r.expectedKey = r.getPlaybackSongKey(r.song);
                    r.settings.getState().handleSetNativeAudioOutput(backend, device.id);
                    await new Promise(resolve => setTimeout(resolve, 150));
                    await r.playEntry()(r.song, [r.song], false, { shouldNavigateToPlayer: false });
                }, { backend, provider });
                await page.waitForFunction(() => { const t = window.__appReview.active(); return t?.readyState === 4 && !t.paused && t.currentTime > .3; }, { timeout: 30000 });
                return page.evaluate(() => { const r = window.__appReview, t = r.active(); return { song: r.playback.getState().currentSong.name, position: t.currentTime, backend: t.backend }; });
            });
            if (selected.status !== 'PASS') continue;
            if (provider === 'navidrome') {
                await record(`navidrome-${backend}-app-transcode`, '媒体解码故障事件触发 App 自动转码并恢复真实音源', 'Media decode error triggers App transcode and real-source recovery', async () => {
                    await page.evaluate(() => { window.__appReview.active().currentTime = 3; });
                    await page.waitForFunction(() => !window.__appReview.active().seeking);
                    await page.evaluate(async () => {
                        const r = window.__appReview, t = r.active();
                        if (!/^https?:/.test(t.currentSrc)) throw new Error('HARNESS_PRECONDITION: expected original HTTP source before decode fault');
                        r.expectedKey = r.getPlaybackSongKey(r.playback.getState().currentSong);
                        await window.electron.nativeAudio.request({ action: 'pause', session: t.session });
                        t.fail(new Error('DECODE_FAILED'));
                    });
                    await page.waitForFunction(() => {
                        const r = window.__appReview, t = r.active();
                        return t?.currentSrc.startsWith('folia-transcode:') && t.readyState === 4 && !t.paused && !t.error && t.currentTime >= 2.9;
                    }, { timeout: 30000 });
                    return page.evaluate(() => { const r = window.__appReview; return { position: r.active().currentTime,
                        sameSong: r.getPlaybackSongKey(r.playback.getState().currentSong) === r.expectedKey,
                        sourceScheme: 'folia-transcode:', fault: 'injected-DECODE_FAILED-media-event', trackId: '32sKZLBKwLBsaPv1R0taFe' }; });
                });
                await page.evaluate(() => window.__appReview.active()?.pause());
                continue;
            }
            const before = requests;
            await record(`${provider}-${backend}-app-expiry`, '真实 HTTP 403 经 App 自动刷新，保持当前曲目并继续播放', 'Real HTTP 403 triggers App refresh without skipping the track', async () => {
                await page.evaluate(url => {
                    const r = window.__appReview;
                    r.expectedKey = r.getPlaybackSongKey(r.playback.getState().currentSong);
                    r.beforeSession = r.active().session;
                    r.playback.getState().setAudioSrc(url);
                }, `http://127.0.0.1:${server.address().port}/${provider}-${backend}.flac`);
                await page.waitForFunction(() => {
                    const r = window.__appReview, t = r.active(), s = r.playback.getState();
                    return t?.session !== r.beforeSession && t?.readyState === 4 && !t.paused && !t.error && t.currentTime > .3
                        && !s.audioSrc?.startsWith('http://127.0.0.1:') && r.getPlaybackSongKey(s.currentSong) === r.expectedKey;
                }, { timeout: 30000 });
                if (requests <= before) throw new Error('Fault endpoint was not reached');
                return page.evaluate(count => { const r = window.__appReview; return { http403Requests: count, sameSong: r.getPlaybackSongKey(r.playback.getState().currentSong) === r.expectedKey,
                    position: r.active().currentTime, playerState: r.playback.getState().playerState, layer: 'App-error-to-refresh-to-play', resumeCoverage: 'new-source-start-only' }; }, requests - before);
            });
            for (const paused of [false, true]) await record(`${provider}-${backend}-resume-${paused ? 'paused' : 'playing'}`,
                '注入媒体错误事件后保持非零进度及暂停意图', 'Injected media error preserves nonzero position and pause intent', async () => {
                    await page.evaluate(async () => {
                        const r = window.__appReview;
                        // A completed Blob cannot expire. Start this scenario from a real remote source.
                        if (!/^https?:/.test(r.active().currentSrc)) {
                            const { omni } = await import('/src/services/onlineMusic/omni.ts');
                            const source = await omni.getAudioSource(r.song, r.settings.getState().audioQuality);
                            if (!source?.url || !/^https?:/.test(source.url)) throw new Error('HARNESS_PRECONDITION: expiry requires HTTP source');
                            r.playback.getState().setAudioSrc(source.url);
                        }
                    });
                    await page.waitForFunction(() => window.__appReview.active()?.readyState === 4 && /^https?:/.test(window.__appReview.active().currentSrc));
                    await page.evaluate(async paused => {
                        const r = window.__appReview, t = r.active();
                        if (paused) t.pause(); else await t.play();
                        t.currentTime = 3;
                    }, paused);
                    await page.waitForFunction(() => { const t = window.__appReview.active(); return !t.seeking && t.currentTime >= 3; });
                    await page.evaluate(async () => {
                        const r = window.__appReview, t = r.active();
                        r.beforeSession = t.session;
                        r.expectedKey = r.getPlaybackSongKey(r.playback.getState().currentSong);
                        // Stop the real driver before emitting a media error, without altering App playback intent.
                        await window.electron.nativeAudio.request({ action: 'pause', session: t.session });
                        t.fail(new Error('SOURCE_EXPIRED'));
                    });
                    await page.waitForFunction(paused => {
                        const r = window.__appReview, t = r.active();
                        return t?.session !== r.beforeSession && t?.readyState === 4 && !t.error
                            && t.paused === paused && t.currentTime >= 2.9
                            && r.getPlaybackSongKey(r.playback.getState().currentSong) === r.expectedKey;
                    }, paused, { timeout: 15000 });
                    return page.evaluate(() => { const r = window.__appReview, t = r.active();
                        return { position: t.currentTime, paused: t.paused, errorInjection: 'transport-media-event', layer: 'real-App-recovery-real-driver' }; });
                });
            if (process.argv.includes('--bounded')) await record(`${provider}-${backend}-bounded-refresh-failure`, '连续刷新失败后停止自动重试', 'Repeated preparation failures stop refreshing', async () => {
                await page.evaluate(async () => {
                    const r = window.__appReview, t = r.active(); r.failedFinishes = 0; r.originalApi = t.api;
                    await t.play(); await new Promise(resolve => setTimeout(resolve, 200));
                    await window.electron.nativeAudio.request({ action: 'pause', session: t.session });
                    t.api = { ...t.api, request: async request => {
                        if (request.action === 'finish') { r.failedFinishes++; throw Object.assign(new Error('SOURCE_EXPIRED'), { code: 'SOURCE_EXPIRED' }); }
                        return r.originalApi.request(request);
                    } };
                    t.fail(new Error('SOURCE_EXPIRED'));
                });
                try {
                    await page.waitForTimeout(5000);
                    const count = await page.evaluate(() => window.__appReview.failedFinishes);
                    if (count < 1 || count > 3) throw new Error(`Unexpected refresh count: ${count}`);
                    await page.waitForTimeout(5000);
                    const after = await page.evaluate(() => window.__appReview.failedFinishes);
                    if (after !== count) throw new Error(`Unbounded retry: ${count} -> ${after}`);
                    return { failedFinishes: count, stableForMs: 5000, fault: 'controlled finish rejection through real App orchestration' };
                } finally { await page.evaluate(() => { const r = window.__appReview; r.active().api = r.originalApi; }); }
            });
            await page.evaluate(() => window.__appReview.active()?.pause());
        }
        if (process.argv.includes('--faults')) await require('./nativeAudioAppFaults.cjs').runFaultReview(page, record);
        if (process.argv.includes('--checks')) await require('./nativeAudioAppChecks.cjs').runAppChecks(page, record);
        if (process.argv.includes('--nav-samples')) await require('./nativeAudioNavSamples.cjs').runNavSamples(page, record);
        if (process.argv.includes('--browser-review')) await require('./nativeAudioBrowserReview.cjs').runBrowserReview(page, record);
    } finally {
        await page.evaluate(() => {
            const r = window.__appReview; if (!r) return;
            r.active()?.pause(); r.unsubscribe(); r.traceUnsubscribe?.();
            r.settings.setState({ volume: r.saved.volume, isMuted: r.saved.isMuted });
            r.settings.getState().handleSetNativeAudioOutput('browser', '');
        }).catch(() => {});
        await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    if (records.some(r => r.status !== 'PASS')) process.exitCode = 1;
}
main().catch(error => { console.error(String(error.message).replace(/https?:\/\/\S+/g, '[URL]')); process.exitCode = 1; });
