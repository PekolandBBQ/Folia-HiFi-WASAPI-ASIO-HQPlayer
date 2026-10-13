import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import path from 'node:path';
import { assertLiveFoliaDevServer, unregisterPreviewServiceWorkers } from './foliaAppTestReadiness.mjs';

// Observe signed-in provider source quality changes without starting an output or retaining credentials/stream URLs.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
const report = { startedAt: new Date().toISOString(), cases: [] };
const prefixLimit = 256 * 1024;
async function inspectEncodedSource(url) {
    const response = await fetch(url, { headers: { Range: `bytes=0-${prefixLimit - 1}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.body) return { httpStatus: response.status, error: 'source-request-failed' };
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
        while (bytes < prefixLimit) {
            const { value, done } = await reader.read(); if (done) break;
            const part = Buffer.from(value).subarray(0, prefixLimit - bytes); chunks.push(part); bytes += part.length;
        }
    } finally { await reader.cancel(); }
    const buffer = Buffer.concat(chunks);
    // Some CDNs label a FLAC file audio/mpeg; detect its bytes instead of forcing the HTTP MIME parser.
    const metadata = await parseBuffer(buffer, undefined, { duration: false, skipCovers: true });
    const { codec, container, sampleRate, bitsPerSample, bitrate, lossless, numberOfChannels } = metadata.format;
    return { httpStatus: response.status, httpContentType: response.headers.get('content-type'), prefixBytes: bytes,
        prefixSha256: createHash('sha256').update(buffer).digest('hex'),
        // A bounded FLAC prefix cannot measure the whole file's average encoded bitrate.
        codec, container, sampleRate, bitsPerSample, ...(lossless ? {} : { bitrate }), lossless, numberOfChannels };
}
let app;
try {
    await assertLiveFoliaDevServer();
    app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
        args: [path.resolve('test/manual/spotifyAppPreview.cjs')], timeout: 60000, env: { ...process.env } });
    let page;
    for (let attempt = 0; attempt < 120 && !page; attempt++) {
        page = app.windows().find(window => window.url().startsWith('http://localhost:3000'));
        if (!page) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!page) throw new Error('App page unavailable');
    report.unregisteredPreviewWorkers = await unregisterPreviewServiceWorkers(page);
    await page.evaluate(() => {
        localStorage.setItem('folia_native_audio_backend', 'browser');
        localStorage.setItem('open_player_on_launch', 'false');
    });
    await page.reload();
    await page.waitForTimeout(12000);
    await page.evaluate(async () => {
        const { usePlaybackStore } = await import('/src/stores/usePlaybackStore.ts');
        usePlaybackStore.getState().setPlayerState('PAUSED');
        const fetchSource = window.fetch.bind(window);
        const trace = [];
        window.fetch = async (...args) => {
            const response = await fetchSource(...args);
            const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
            if (url.pathname === '/song/url/v1') {
                const raw = await response.clone().json();
                const entry = raw.data?.[0] || {};
                const fields = {};
                for (const key of ['code', 'level', 'type', 'encodeType', 'br', 'sr', 'sampleRate', 'bitDepth', 'bitsPerSample', 'size', 'time']) {
                    if (['number', 'string'].includes(typeof entry[key])) fields[key] = entry[key];
                }
                trace.push({ provider: 'netease', requestedLevel: url.searchParams.get('level'), httpStatus: response.status,
                    code: raw.code, hasUrl: Boolean(entry.url), responseFields: Object.keys(entry), sourceFields: fields });
            }
            if (url.hostname === 'u.y.qq.com' && typeof args[1]?.body === 'string'
                && JSON.parse(args[1].body).request?.method === 'DoSearchForQQMusicLite') {
                const raw = await response.clone().json();
                trace.push({ provider: 'qq', operation: 'search', httpStatus: response.status, code: raw.code,
                    requestCode: raw.request?.code, itemSongCount: raw.request?.data?.body?.item_song?.length });
            }
            return response;
        };
        window.qualityProbe = { trace };
    });
    const cases = [['netease', 'HIMEHINA'], ['qq', '许嵩']]
        .filter(([provider]) => !process.env.FOLIA_SOURCE_QUALITY_PROVIDER || provider === process.env.FOLIA_SOURCE_QUALITY_PROVIDER)
        .map(([provider, query]) => [provider, process.env.FOLIA_SOURCE_QUALITY_QUERY || query]);
    for (const [provider, query] of cases) {
        const result = { provider, query, qualities: [] }; report.cases.push(result);
        result.loginBefore = await page.evaluate(async provider => {
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            return Boolean((await omni.getLoginStatus(provider))?.id);
        }, provider);
        if (!result.loginBefore) { result.outcome = 'blocked-login'; continue; }
        result.search = await page.evaluate(async ({ provider, query }) => {
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            let list;
            try { list = await omni.searchProviderSongs(provider, query, { limit: 10, offset: 0 }); }
            catch (error) { return { error: error.code || error.message, trace: [...window.qualityProbe.trace] }; }
            const song = list.items[0];
            window.qualityProbe.song = song;
            window.qualityProbe.candidates = list.items;
            return { count: list.items.length, song: song ? { id: String(song.id), name: song.name,
                durationMs: song.durationMs, provider: song.sourceRef?.providerId } : null };
        }, { provider, query });
        if (!result.search.song) {
            result.outcome = 'failed-search';
            result.loginAfter = await page.evaluate(async provider => {
                const { omni } = await import('/src/services/onlineMusic/omni.ts');
                return Boolean((await omni.getLoginStatus(provider))?.id);
            }, provider);
            continue;
        }
        if (provider === 'netease' && process.env.FOLIA_SOURCE_QUALITY_FIND_HIRES === '1') {
            result.hiresDiscovery = await page.evaluate(async () => {
                const { omni } = await import('/src/services/onlineMusic/omni.ts');
                const q = window.qualityProbe; const attempts = [];
                for (const song of q.candidates.slice(0, 10)) {
                    try {
                        const source = await omni.getAudioSource(song, 'hires');
                        attempts.push({ id: String(song.id), name: song.name, actual: source?.quality || 'unknown',
                            providerLevel: source?.providerLevel, sourceFormat: source?.sourceFormat });
                        if (source?.quality === 'hires') {
                            q.song = song;
                            return { covered: true, attempts, selected: { id: String(song.id), name: song.name } };
                        }
                    } catch (error) { attempts.push({ id: String(song.id), error: error.code || error.message }); }
                }
                return { covered: false, attempts };
            });
        }
        for (const requested of ['standard', 'high', 'lossless', 'hires', 'high', 'standard']) {
            const row = await page.evaluate(async requested => {
                const { omni } = await import('/src/services/onlineMusic/omni.ts');
                const { getAudioSourceQuality } = await import('/src/services/onlineMusic/audioSourceQuality.ts');
                const { getSongAudioCacheKey } = await import('/src/services/onlineMusic/resourceKeys.ts');
                const { hasCachedSongAudio } = await import('/src/services/onlineMusic/resourceCache.ts');
                const q = window.qualityProbe; q.trace.length = 0;
                const started = performance.now();
                try {
                    const source = await omni.getAudioSource(q.song, requested);
                    return { requested, hasSource: Boolean(source?.url), privateUrl: source?.url, actual: source?.quality || 'unknown',
                        requestedMetadata: source?.requestedQuality, providerLevel: source?.providerLevel,
                        sourceFormat: source?.sourceFormat, rememberedQuality: source ? getAudioSourceQuality(q.song, source.url) || 'unknown' : null,
                        cache: { requestedKey: getSongAudioCacheKey(q.song, requested),
                            actualKey: getSongAudioCacheKey(q.song, source?.quality),
                            requestedTierPresent: await hasCachedSongAudio(q.song, requested),
                            actualTierPresent: source?.quality ? await hasCachedSongAudio(q.song, source.quality) : null },
                        elapsedMs: Math.round(performance.now() - started), trace: [...q.trace] };
                } catch (error) { return { requested, error: error.code || error.message, elapsedMs: Math.round(performance.now() - started), trace: [...q.trace] }; }
            }, requested);
            const { privateUrl, ...safeRow } = row;
            if (privateUrl) {
                try { safeRow.encodedHeader = await inspectEncodedSource(privateUrl); }
                catch (error) { safeRow.encodedHeader = { error: error.code || 'encoded-header-inspection-failed' }; }
            }
            const header = safeRow.encodedHeader;
            const providerFormat = safeRow.sourceFormat;
            const expectedCodec = providerFormat?.codec === 'mp3' ? 'MPEG 1 Layer 3' : providerFormat?.codec?.toUpperCase();
            safeRow.metadataMatchesEncodedHeader = Boolean(header?.codec) && !header?.error
                && (!expectedCodec || expectedCodec === header.codec)
                && (!providerFormat?.sampleRate || providerFormat.sampleRate === header.sampleRate)
                && (!providerFormat?.bitsPerSample || providerFormat.bitsPerSample === header.bitsPerSample)
                && (!['lossless', 'hires'].includes(safeRow.actual) || header.lossless === true);
            result.qualities.push(safeRow);
            console.log(JSON.stringify({ provider, ...safeRow }));
        }
        result.loginAfter = await page.evaluate(async provider => {
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            return Boolean((await omni.getLoginStatus(provider))?.id);
        }, provider);
        result.outcome = result.loginAfter && result.qualities.every(row => row.hasSource && row.metadataMatchesEncodedHeader)
            ? 'source-probe-passed' : 'failed';
    }
} catch (error) { report.error = String(error.message).split('\n')[0]; }
finally {
    await app?.close(); await mkdir(directory, { recursive: true }); report.finishedAt = new Date().toISOString();
    const file = path.join(directory, `streaming-source-quality-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(report, null, 2)); console.log(file);
}
