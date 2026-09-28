const { attach, connect } = require('./remainingHarness.cjs');
const assert = require('node:assert/strict');

// Delay only boot cache completion to expose a real restore-versus-user-play ordering.
async function main() {
    const h = await connect('startup-race'); const { page, record } = h;
    try {
        await attach(page);
        await page.evaluate(async () => {
            const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
            const { buildUnifiedNavidromeSong } = await import('/src/services/playbackAdapters.ts');
            const { saveToCache } = await import('/src/services/db.ts');
            const c = getNavidromeConfig();
            const s = await navidromeApi.getSong(c, '32sKZLBKwLBsaPv1R0taFe');
            const remembered = buildUnifiedNavidromeSong(navidromeApi.toNavidromeSong(c, s));
            await saveToCache('last_song', remembered); await saveToCache('last_queue', [remembered]);
            window.__remaining.active()?.pause();
        });
        await page.route('**/src/hooks/useSessionRestoreController.ts*', async route => {
            const response = await route.fetch(); let body = await response.text();
            const marker = /let lastQueue = await getFromCache\(["']last_queue["']\);/;
            if (!marker.test(body)) throw new Error('Restore timing checkpoint unavailable');
            body = body.replace(marker, "$&\n await new Promise(resolve => { window.__releaseRestore = resolve; window.__restoreWaiting = true; });");
            await route.fulfill({ response, body });
        });
        await page.route('**/src/services/nativeAudio/NativeAudioTransport.ts*', async route => {
            const response = await route.fetch(); let body = await response.text();
            body = body.replace(/(async play\(\) \{|pause\(\) \{|setSource\(src\) \{)/g, '$&\n window.__remaining?.trace.push({ op: "$&", at: performance.now(), intent: this.intent, session: this.session, stack: new Error().stack?.split("\\n").slice(1,8).map(l => l.replace(/https?:\\/\\/[^/]+/g, "[origin]")) });');
            await route.fulfill({ response, body });
        });
        await page.reload(); await attach(page);
        await page.waitForFunction(() => window.__restoreWaiting);
        await record('user-play-before-restore-completes', async () => {
            const result = await page.evaluate(async () => {
                const r = window.__remaining;
                const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
                const { buildUnifiedNavidromeSong } = await import('/src/services/playbackAdapters.ts');
                const { saveToCache } = await import('/src/services/db.ts');
                const c = getNavidromeConfig();
                const s = await navidromeApi.getSong(c, '36eyEuJ9uGSwoD4yPgQFAC');
                if (!s) throw new Error('No independent startup sample');
                await saveToCache(`navidrome_match_${s.id}`, { noAutoMatch: true });
                r.target = buildUnifiedNavidromeSong(navidromeApi.toNavidromeSong(c, s));
                r.settings.setState({ volume: .1, isMuted: false });
                r.settings.getState().handleSetNativeAudioOutput('asio', r.devices.find(d => d.backend === 'asio').id);
                await new Promise(resolve => setTimeout(resolve, 250));
                await r.entry()(r.target, [r.target], false, { shouldNavigateToPlayer: false });
                return { target: s.title, trackId: s.id, timing: 'boot-cache-read-delayed' };
            });
            await page.waitForFunction(() => { const t = window.__remaining.active(); return t?.readyState === 4 && !t.paused && t.currentTime > .3; }, null, { timeout: 30000 });
            return result;
        });
        await record('late-restore-must-not-overwrite-user-play', async () => {
            await page.evaluate(() => window.__releaseRestore());
            await page.waitForTimeout(6500);
            const r = await page.evaluate(() => { const r = window.__remaining, s = r.playback.getState(), t = r.active(); return { expected: r.target.name, actual: s.currentSong?.name, sameSong: r.getPlaybackSongKey(s.currentSong) === r.getPlaybackSongKey(r.target), playing: !t?.paused, ready: t?.readyState, position: t?.currentTime }; });
            assert.equal(r.sameSong, true, JSON.stringify(r)); assert.equal(r.playing, true, JSON.stringify(r)); return r;
        });
    } finally { await page.unrouteAll({ behavior: 'wait' }); await page.evaluate(() => window.__remaining?.active()?.pause()).catch(() => {}); await h.browser.close(); }
    if (h.results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
