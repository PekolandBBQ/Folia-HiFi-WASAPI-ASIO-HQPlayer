const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

// test/manual/nativeAudioProviderReview.cjs — opt-in real accounts, sanitized evidence only.
// Run against the isolated review host with FOLIA_REVIEW_DEBUG=1. Never exports source URLs or credentials.
async function main() {
    const navidrome = process.argv.includes('--navidrome');
    const providerFilter = process.argv.find(value => value.startsWith('--provider='))?.split('=')[1];
    const output = path.resolve('test-results/native-audio-review', `${navidrome ? 'navidrome' : 'providers'}-${Date.now()}`);
    await fs.mkdir(output, { recursive: true });
    const browser = await chromium.connectOverCDP('http://127.0.0.1:19333');
    const page = browser.contexts()[0].pages().find(page => page.url().startsWith('http://localhost:3000/'));
    if (!page) throw new Error('Isolated review window missing');
    const results = [];
    let sessionCookieObserved = false;
    const expiredServer = http.createServer((request, response) => {
        sessionCookieObserved ||= request.headers.cookie?.includes('folia_review_cookie=present') || false;
        response.writeHead(403); response.end('Expired test source');
    });
    await new Promise(resolve => expiredServer.listen(0, '127.0.0.1', resolve));
    const expiredUrl = `http://localhost:${expiredServer.address().port}/expired`;
    async function step(id, zh, en, task) {
        const started = Date.now();
        let result;
        try { result = await task(); } catch (error) { result = { status: 'FAIL', code: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 150) }; }
        const record = { id, zh, en, elapsedMs: Date.now() - started, ...result };
        results.push(record);
        console.log(JSON.stringify(record));
        await page.evaluate(record => {
            let panel = document.getElementById('native-review-evidence');
            if (!panel) { panel = document.createElement('pre'); panel.id = 'native-review-evidence'; document.body.append(panel); }
            panel.style.cssText = 'position:fixed;z-index:2147483647;left:24px;top:24px;max-width:85vw;max-height:85vh;overflow:auto;padding:24px;background:#172126;color:#e8eef0;border:1px solid #73848c;border-radius:16px;font:16px/1.5 monospace;white-space:pre-wrap;pointer-events:none';
            panel.textContent = '专项验证记录 / Live validation evidence\n' + JSON.stringify(record, null, 2);
        }, record);
        await page.screenshot({ path: path.join(output, `${id}.png`) });
        await fs.writeFile(path.join(output, 'provider-results.json'), JSON.stringify(results, null, 2));
        return result;
    }
    await page.exposeBinding('__nativeReviewPhase', async (_source, record) => step(record.id, record.zh, record.en, async () => record));
    try {
        await step('00-environment', '确认账号、组件和设备', 'Verify accounts, component and devices', () => page.evaluate(async () => {
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            const accounts = [];
            for (const id of ['netease', 'qq', 'kugou']) accounts.push({ provider: id, authenticated: !!await omni.getLoginStatus(id) });
            const api = window.electron.nativeAudio;
            await api.request({ action: 'component-install' });
            const devices = await api.request({ action: 'devices' });
            window.__reviewDevices = devices.filter(device => /XingCore/i.test(device.name));
            window.__reviewSources = {};
            return { status: window.__reviewDevices.length ? 'PASS' : 'BLOCKED', accounts,
                component: (await api.request({ action: 'status' })).version,
                devices: window.__reviewDevices.map(({ backend, name }) => ({ backend, name })) };
        }));
        for (const provider of navidrome ? ['navidrome-raw', 'navidrome-mp3', 'navidrome-folia-transcode'] : (providerFilter ? [providerFilter] : ['netease', 'qq', 'kugou'])) {
            const source = await step(`${provider}-source`, navidrome ? '通过 Subsonic 解析账号音源' : '通过 Omni 解析真实账号音源', navidrome ? 'Resolve account audio through Subsonic' : 'Resolve account audio through Omni', () => page.evaluate(async provider => {
                if (provider.startsWith('navidrome')) {
                    const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
                    const config = getNavidromeConfig();
                    if (!config || !await navidromeApi.ping(config)) return { status: 'BLOCKED', reason: 'Navidrome 尚未连接 / Navidrome not connected' };
                    const songs = window.__reviewNavSong ? [window.__reviewNavSong] : await navidromeApi.getRandomSongs(config, 5);
                    const song = songs.find(song => String(song.suffix).toLowerCase() === 'flac');
                    if (!song) return { status: 'BLOCKED', reason: '曲库为空 / Empty library' };
                    window.__reviewNavSong = song;
                    let url = navidromeApi.getStreamUrl(config, song.id, provider === 'navidrome-mp3' ? 'mp3' : 'raw');
                    if (provider === 'navidrome-folia-transcode') {
                        const result = await window.electron.requestTranscodeFallback({ requestId: crypto.randomUUID(), priority: 'playback', limitBytes: 1024 ** 3,
                            source: { kind: 'navidrome', songKey: `navidrome:${song.id}`, sourceRevision: 'review-v1', url, fileName: 'source.flac' } });
                        if (!result.ok) return { status: 'FAIL', code: result.errorCode, song: song.title, trackId: song.id, suffix: song.suffix,
                            detail: String(result.message || '').replace(/https?:\/\/\S+/g, '[URL omitted]').replace(/[A-Z]:\\[^\n]+/g, '[local diagnostic path omitted]').slice(0, 800) };
                        url = result.representation.url;
                    }
                    window.__reviewSources[provider] = { song, source: { url } };
                    return { status: 'PASS', song: song.title, trackId: song.id, suffix: song.suffix, sourceScheme: new URL(url).protocol };
                }
                const { omni } = await import('/src/services/onlineMusic/omni.ts');
                const songs = await omni.searchProviderSongs(provider, '晴天', { limit: 5, offset: 0 });
                const song = songs.items.find(song => omni.canPlaySong(song));
                if (!song) return { status: 'BLOCKED', reason: '没有可播放搜索结果 / No playable search result' };
                const source = await omni.getAudioSource(song, 'hires');
                if (!source?.url) return { status: 'BLOCKED', reason: '没有音源 / No audio source' };
                window.__reviewSources[provider] = { song, source };
                return { status: 'PASS', song: song.name, requestedQuality: 'hires', returnedQuality: source.quality, sourceScheme: new URL(source.url).protocol };
            }, provider));
            if (source.status !== 'PASS') continue;
            if (!navidrome) await step(`${provider}-expired-refresh`, '注入 HTTP 403 后通过原恢复控制器重新解析真实音源', 'Inject HTTP 403, then refresh a real source through the existing recovery controller', async () => {
                const result = await page.evaluate(async ({ provider, expiredUrl }) => {
                    const api = window.electron.nativeAudio;
                    const device = window.__reviewDevices[0];
                    if (!device) return { status: 'BLOCKED' };
                    const session = crypto.randomUUID();
                    document.cookie = 'folia_review_cookie=present; path=/; SameSite=Lax';
                    let rejectedCode;
                    try {
                        await api.request({ action: 'begin', session, backend: device.backend, deviceId: device.id, url: expiredUrl });
                        await api.request({ action: 'finish', session });
                    } catch (error) {
                        const { getNativeErrorCode } = await import('/src/services/nativeAudio/errors.ts');
                        rejectedCode = getNativeErrorCode(error);
                    }
                    finally { await api.request({ action: 'stop', session }); }
                    const { createOnlineRecoveryController } = await import('/src/components/app/playback/createOnlineRecoveryController.ts');
                    const { getPlaybackSongKey } = await import('/src/utils/appPlaybackGuards.ts');
                    const { usePlaybackStore } = await import('/src/stores/usePlaybackStore.ts');
                    const song = window.__reviewSources[provider].song, ref = current => ({ current });
                    const oldSource = usePlaybackStore.getState().audioSrc;
                    const resume = ref(null), auto = ref(false);
                    const controller = createOnlineRecoveryController({ audioQuality: 'hires', currentSong: song, audioSrc: expiredUrl,
                        audioRef: ref({ currentTime: 3, currentSrc: expiredUrl }), currentSongRef: ref(getPlaybackSongKey(song)), blobUrlRef: ref(null),
                        shouldAutoPlayRef: auto, pendingResumeTimeRef: resume, onlinePlaybackRecoveryRef: ref(null), lastAudioRecoverySourceRef: ref(null),
                        currentOnlineAudioUrlFetchedAtRef: ref(0), persistLastPlaybackCache: async () => {}, playQueue: [song], onlineAudioUrlTtlMs: 60000, onlineAudioUrlRefreshBufferMs: 5000 });
                    const recovered = await controller.recoverOnlinePlaybackSource({ failedSrc: expiredUrl, resumeAt: 3, autoplay: true });
                    const refreshed = usePlaybackStore.getState().audioSrc;
                    usePlaybackStore.setState({ audioSrc: oldSource });
                    if (recovered) window.__reviewSources[provider].source.url = refreshed;
                    document.cookie = 'folia_review_cookie=; path=/; Max-Age=0';
                    return { status: rejectedCode === 'SOURCE_EXPIRED' && recovered && resume.current === 3 && auto.current ? 'PASS' : 'FAIL',
                        injectedStatus: 403, rejectedCode, recovered, resumeAt: resume.current, autoplayIntent: auto.current,
                        sourceScheme: refreshed ? new URL(refreshed).protocol : null };
                }, { provider, expiredUrl });
                return { ...result, electronSessionCookieObserved: sessionCookieObserved };
            });
            for (const target of ['wasapi-exclusive', 'asio', ...(!navidrome ? ['wasapi-exclusive-cached', 'asio-cached'] : [])]) {
                const cached = target.endsWith('-cached'), backend = target.replace('-cached', '');
                await step(`${provider}-${target}`, cached ? '完整缓存 Blob 经生产加载器进入硬件播放' : '完整准备后进行硬件播放、暂停和定位', cached ? 'Play a fully cached Blob through the production loader and hardware' : 'Prepare completely, then test hardware playback, pause and seek', () => page.evaluate(async ({ provider, backend, cached }) => {
                    const api = window.electron.nativeAudio;
                    const device = window.__reviewDevices.find(device => device.backend === backend);
                    if (!device) return { status: 'BLOCKED', reason: '设备不可用 / Device unavailable' };
                    const session = crypto.randomUUID();
                    let latest, errorCode;
                    const phase = (name, zh, en, data = {}) => window.__nativeReviewPhase({ id: `${provider}-${backend}${cached ? '-cached' : ''}-${name}`, zh, en, status: 'PASS', ...data });
                    const unsubscribe = api.onEvent(event => { if (event.session === session) { if (event.state) latest = event.state; if (event.errorCode) errorCode = event.errorCode; } });
                    const call = (action, extra = {}) => api.request({ action, session, ...extra });
                    try {
                        const start = performance.now();
                        const entry = window.__reviewSources[provider];
                        if (cached && !entry.blobUrl) {
                            const response = await fetch(entry.source.url);
                            if (!response.ok) throw new Error('CACHE_DOWNLOAD_FAILED');
                            entry.blobUrl = URL.createObjectURL(await response.blob());
                        }
                        const { loadNativeOnlineSource } = await import('/src/services/nativeAudio/loadOnlineSource.ts');
                        const prepared = await loadNativeOnlineSource(api, session, cached ? entry.blobUrl : entry.source.url,
                            backend, device.id, new AbortController().signal, 'compatibility');
                        const preparationMs = Math.round(performance.now() - start);
                        await phase('prepared', '完整音源准备完成，尚未播放', 'Full source prepared before playback', { preparationMs, sourceCodec: prepared.sourceCodec, sourceSampleRate: prepared.sourceSampleRate, sourceBitsPerSample: prepared.sourceBitsPerSample });
                        await call('volume', { volume: 0.1 });
                        await call('play');
                        const deadline = performance.now() + 8000;
                        while ((!latest || latest.position < 0.3) && !errorCode && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
                        if (errorCode || !latest || latest.position < 0.3) throw new Error(errorCode || 'PROGRESS_TIMEOUT');
                        const progress = latest.position;
                        await phase('playing', '硬件播放时钟已前进', 'Hardware playback clock advanced', { progress });
                        const paused = await call('pause');
                        await phase('paused', '已暂停', 'Paused', { playing: paused.playing });
                        const seek = await call('seek', { position: 5 });
                        await phase('seeked', '已定位至五秒', 'Seeked to five seconds', { position: seek.position });
                        return { status: !paused.playing && Math.abs(seek.position - 5) < 0.1 ? 'PASS' : 'FAIL', preparationMs, progress,
                            sourceSampleRate: prepared.sourceSampleRate, sourceBitsPerSample: prepared.sourceBitsPerSample, sourceCodec: prepared.sourceCodec,
                            outputSampleRate: prepared.sampleRate, outputFormat: prepared.outputFormat,
                            paused: !paused.playing, seekPosition: seek.position };
                    } catch (error) { return { status: 'FAIL', code: error.code || error.message }; }
                    finally { await call('stop').catch(() => {}); unsubscribe(); await phase('stopped', '已停止并释放测试会话', 'Stopped and released test session'); }
                }, { provider, backend, cached }));
            }
        }
    } finally { await page.evaluate(() => document.getElementById('native-review-evidence')?.remove()).catch(() => {}); await browser.close(); await new Promise(resolve => expiredServer.close(resolve)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
