const { attach, connect } = require('./remainingHarness.cjs');

// Native decoding is tolerant; a controlled media error exercises strict transcode failure recovery.
async function main() {
    const h = await connect('nav-corrupt-recovery'); const { page, record } = h;
    try {
        await page.reload(); await attach(page);
        for (const backend of ['wasapi-exclusive', 'asio']) for (const id of ['3B7IskPYaj5cXacvfgF6IS', '0vkNVrR3Iqmso4JAUxoyDX']) {
            await page.evaluate(async ({ backend, id }) => {
                const r = window.__remaining;
                const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
                const { buildUnifiedNavidromeSong } = await import('/src/services/playbackAdapters.ts');
                const { saveToCache } = await import('/src/services/db.ts');
                const c = getNavidromeConfig();
                const songs = await Promise.all([id, '32sKZLBKwLBsaPv1R0taFe'].map(async id => {
                    const s = await navidromeApi.getSong(c, id); await saveToCache(`navidrome_match_${id}`, { noAutoMatch: true });
                    return buildUnifiedNavidromeSong(navidromeApi.toNavidromeSong(c, s));
                }));
                r.good = songs[1]; r.bad = songs[0]; r.errors = [];
                r.settings.setState({ volume: .1, isMuted: false, enableTranscodeFallback: true, loopMode: 'all' });
                r.settings.getState().handleSetNativeAudioProcessingMode?.('compatibility');
                r.settings.getState().handleSetNativeAudioOutput(backend, r.devices.find(d => d.backend === backend).id);
                await new Promise(resolve => setTimeout(resolve, 300));
                r.watch = setInterval(() => {
                    const t = r.active(); if (!t || t === r.watched) return; r.watched = t;
                    t.addEventListener('error', () => r.errors.push({ code: t.error?.message, song: r.playback.getState().currentSong?.name, at: performance.now() }));
                }, 10);
                void r.entry()(songs[0], songs, false, { shouldNavigateToPlayer: false });
            }, { backend, id });
            await record(`${backend}-${id}-native-tolerant-play`, async () => {
                await page.waitForFunction(() => { const t = window.__remaining.active(); return t?.readyState === 4 && !t.paused && t.currentTime > .3; }, null, { timeout: 20000 });
                return { sourceHasStrictDecodeErrors: true, nativeDecoderToleratesErrors: true };
            });
            await record(`${backend}-${id}-controlled-error`, async () => {
                await page.evaluate(async () => { const t = window.__remaining.active(); await window.electron.nativeAudio.request({ action: 'pause', session: t.session }); t.fail(new Error('DECODE_FAILED')); });
                await page.waitForFunction(() => window.__remaining.errors.some(e => e.code === 'DECODE_FAILED'), null, { timeout: 20000 });
                return page.evaluate(() => ({ faultInjection: 'DECODE_FAILED-media-event', errors: window.__remaining.errors }));
            });
            await record(`${backend}-${id}-healthy-next`, async () => {
                await page.waitForFunction(() => { const r = window.__remaining, t = r.active(), s = r.playback.getState(); return s.currentSong && r.getPlaybackSongKey(s.currentSong) === r.getPlaybackSongKey(r.good) && t?.readyState === 4 && !t.paused && t.currentTime > .3; }, null, { timeout: 30000 });
                return { recoveredToHealthyNext: true };
            });
            await page.evaluate(() => { const r = window.__remaining; clearInterval(r.watch); r.active()?.pause(); });
        }
    } finally { await page.evaluate(() => { clearInterval(window.__remaining?.watch); window.__remaining?.active()?.pause(); }).catch(() => {}); await h.browser.close(); }
    if (h.results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
