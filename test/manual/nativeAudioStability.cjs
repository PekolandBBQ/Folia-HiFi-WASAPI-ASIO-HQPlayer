const { connect, attach } = require('./remainingHarness.cjs');
const assert = require('node:assert/strict');

// test/manual/nativeAudioStability.cjs — repeat cold renderer starts and real driver transitions.
async function main() {
    const h = await connect('stability'); const { page, record } = h;
    try {
        for (let round = 1; round <= 5; round++) {
            await page.reload(); await attach(page);
            await page.evaluate(async () => {
                const r = window.__remaining;
                const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
                const { buildUnifiedNavidromeSong } = await import('/src/services/playbackAdapters.ts');
                const config = getNavidromeConfig(); r.songs = [];
                for (const id of ['32sKZLBKwLBsaPv1R0taFe', '36eyEuJ9uGSwoD4yPgQFAC']) {
                    r.songs.push(buildUnifiedNavidromeSong(navidromeApi.toNavidromeSong(config, await navidromeApi.getSong(config, id))));
                }
                r.settings.setState({ volume: .1, isMuted: false });
                r.settings.getState().handleSetNativeAudioOutput('browser', '');
                r.playback.setState({ audioSrc: null, currentSong: null, playerState: 'IDLE' });
            });
            for (const backend of ['wasapi-exclusive', 'asio']) for (let index = 0; index < 2; index++) {
                await record(`r${round}-${backend}-${index}`, async () => {
                    await page.evaluate(async ({ backend, index }) => {
                        const r = window.__remaining;
                        r.settings.getState().handleSetNativeAudioOutput(backend, r.devices.find(d => d.backend === backend).id);
                        await new Promise(resolve => setTimeout(resolve, 150));
                        await r.entry()(r.songs[index], r.songs, false, { shouldNavigateToPlayer: false });
                    }, { backend, index });
                    await page.waitForFunction(index => {
                        const r = window.__remaining, t = r.active();
                        return t?.readyState === 4 && !t.paused && !t.error && t.currentTime > .3 && r.getPlaybackSongKey(r.playback.getState().currentSong) === r.getPlaybackSongKey(r.songs[index]);
                    }, index, { timeout: 30000 });
                    await page.evaluate(() => { window.__remaining.active().currentTime = 3; });
                    await page.waitForFunction(() => { const t = window.__remaining.active(); return !t.seeking && !t.paused && t.currentTime >= 3; });
                    await page.evaluate(async () => {
                        const r = window.__remaining; r.active().pause();
                        await new Promise(resolve => setTimeout(resolve, 200));
                        await window.electron.nativeAudio.request({ action: 'devices' });
                        await r.active().play();
                    });
                    await page.waitForFunction(() => { const t = window.__remaining.active(); return !t.paused && !t.error && t.currentTime > 3.2; });
                    const result = await page.evaluate(() => { const r = window.__remaining, t = r.active(); return { position: t.currentTime, backend: t.backend, playerState: r.playback.getState().playerState, sampleRate: r.events.at(-1)?.sampleRate }; });
                    assert.equal(result.playerState, 'PLAYING'); return result;
                });
            }
        }
    } finally {
        await page.evaluate(() => window.__remaining?.active()?.pause()).catch(() => {}); await h.browser.close();
    }
    if (h.results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
