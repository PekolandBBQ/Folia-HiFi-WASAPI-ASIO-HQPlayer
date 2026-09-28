const { attach, connect } = require('./remainingHarness.cjs');
const { fixtures, seed } = require('./remainingFixtures.cjs');
const assert = require('node:assert/strict');

// File tags -> metadata worker -> persistent cache -> new renderer -> App -> real output engine.
async function main() {
    const h = await connect('tagged-cache'); const { page, record } = h;
    try {
        await attach(page);
        const songs = await seed(page, await fixtures(h.output));
        await page.reload(); await attach(page);
        await page.evaluate(async songs => {
            const r = window.__remaining; r.songs = songs;
            const { useAutomixSettingsStore } = await import('/src/stores/useAutomixSettingsStore.ts'); useAutomixSettingsStore.setState({ automixEnabled: false });
            r.settings.setState({ volume: .1, isMuted: false });
            const { hasCachedSongAudio, getCachedSongReplayGain } = await import('/src/services/onlineMusic/resourceCache.ts');
            r.persisted = await Promise.all(songs.map(async s => ({ audio: await hasCachedSongAudio(s), gain: await getCachedSongReplayGain(s), inputHadGain: !!s.replayGain })));
        }, songs);
        for (const backend of ['wasapi-exclusive', 'asio']) for (const processing of process.argv.includes('--core') ? ['compatibility'] : ['compatibility', 'integer-direct']) {
            await page.evaluate(async ({ backend, processing }) => {
                const r = window.__remaining; r.active()?.pause();
                r.settings.getState().handleSetNativeAudioProcessingMode?.(processing);
                r.settings.getState().handleSetNativeAudioOutput(backend, r.devices.find(d => d.backend === backend).id);
                await new Promise(resolve => setTimeout(resolve, 350));
            }, { backend, processing });
            for (const mode of process.argv.includes('--quick') ? ['track'] : ['track', 'album', 'off']) for (const index of [0, 1]) await record(`${backend}-${processing}-${mode}-${index}`, async () => {
                const expected = mode === 'off' ? 1 : 10 ** ((mode === 'album' ? -12 : index ? -3 : -6) / 20);
                await page.evaluate(async ({ mode, index }) => {
                    const r = window.__remaining; r.playback.setState({ replayGainMode: mode }); r.events.length = 0;
                    await r.entry()(r.songs[index], r.songs, false, { shouldNavigateToPlayer: false });
                }, { mode, index });
                await page.waitForFunction(({ expected, index }) => {
                    const r = window.__remaining, t = r.active(), e = r.events.findLast(e => e.session === t?.session);
                    return t?.readyState === 4 && !t.paused && t.currentTime > .2 && r.playback.getState().currentSong.id === r.songs[index].id
                        && e && Math.abs(e.replayGain - expected) < .00002 && Math.abs(e.effectiveGain - expected * .1) < .00002;
                }, { expected, index }, { timeout: 20000 });
                const result = await page.evaluate(index => {
                    const r = window.__remaining, t = r.active(), e = r.events.findLast(e => e.session === t.session);
                    return { persisted: r.persisted[index], sourceScheme: t.src.split(':')[0], gain: e.replayGain, effectiveGain: e.effectiveGain, processing: e.processingMode, hydratedGain: r.playback.getState().currentSong.replayGain, rendererReloaded: true };
                }, index);
                assert.equal(result.sourceScheme, 'blob'); assert.equal(result.persisted.audio, true); assert.equal(result.persisted.inputHadGain, false); return result;
            });
        }
    } finally { await page.evaluate(() => { const r = window.__remaining; r?.active()?.pause(); r?.settings.getState().handleSetNativeAudioOutput('browser', ''); r?.playback.setState({ replayGainMode: 'off' }); }).catch(() => {}); await h.browser.close(); }
    if (h.results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
