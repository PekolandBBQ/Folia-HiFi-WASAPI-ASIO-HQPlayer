// Production browser decks with the native component deactivated; no synthetic audio engine.
async function runBrowserReview(page, record) {
    await record('browser-automix-handoff', '停用原生组件后真实浏览器双甲板交接', 'Real browser deck handoff with the native component deactivated', async () => {
        await page.evaluate(async () => {
            const r = window.__appReview;
            const loaded = p => performance.getEntriesByType('resource').map(e => e.name).findLast(n => new URL(n).pathname === p) || p;
            const { useAutomixSettingsStore } = await import(loaded('/src/stores/useAutomixSettingsStore.ts'));
            const { subscribeToTransitionCue } = await import(loaded('/src/services/automix/transitionCue.ts'));
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            r.mixStore = useAutomixSettingsStore;
            r.savedMix = { automixEnabled: r.mixStore.getState().automixEnabled, transitionMode: r.mixStore.getState().transitionMode };
            r.savedLoop = r.settings.getState().loopMode;
            r.active()?.pause(); r.settings.getState().handleSetNativeAudioOutput('browser', '');
            await new Promise(resolve => setTimeout(resolve, 300));
            await window.electron.nativeAudio.request({ action: 'component-uninstall' });
            const result = await omni.getCollectionTracks({ providerId: 'qq', id: '9614955116', type: 'playlist' }, { limit: 5, offset: 0 });
            const songs = result.items.filter(s => omni.canPlaySong(s)).slice(0, 2);
            if (songs.length !== 2) throw new Error('Two real tracks required');
            r.browserNext = r.getPlaybackSongKey(songs[1]);
            r.cues = []; r.maxSoundingDecks = 0; r.states.length = 0;
            r.cueUnsubscribe = subscribeToTransitionCue(c => { if (c && !c.preview) r.cues.push({ plain: Boolean(c.plain), durationSec: c.seconds }); });
            r.deckInterval = setInterval(() => { r.maxSoundingDecks = Math.max(r.maxSoundingDecks, [...document.querySelectorAll('audio')].filter(a => !a.paused && !a.ended).length); }, 40);
            r.mixStore.setState({ automixEnabled: true, transitionMode: 'automix' });
            r.settings.setState({ loopMode: 'all' });
            await r.playEntry()(songs[0], songs, false, { shouldNavigateToPlayer: false });
        });
        try {
            await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > .3), { timeout: 30000 });
            await page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find(a => !a.paused); a.currentTime = a.duration - 16; });
            await page.waitForFunction(() => {
                const r = window.__appReview;
                return r.getPlaybackSongKey(r.playback.getState().currentSong) === r.browserNext
                    && r.playback.getState().playerState === 'PLAYING'
                    && r.maxSoundingDecks >= 2 && r.cues.length > 0
                    && [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > .3);
            }, { timeout: 45000 });
            const result = await page.evaluate(async () => {
                const r = window.__appReview, s = await window.electron.nativeAudio.request({ action: 'status' });
                return { installed: s.installed, nativeEvents: r.states.length, maxSoundingDecks: r.maxSoundingDecks, cues: r.cues, nextTrack: true };
            });
            if (result.installed || result.nativeEvents || result.maxSoundingDecks < 2 || !result.cues.length) throw new Error(`Handoff coverage insufficient: ${JSON.stringify(result)}`);
            return result;
        } finally {
            await page.evaluate(async () => {
                const r = window.__appReview;
                clearInterval(r.deckInterval); r.cueUnsubscribe?.();
                r.playback.setState({ playerState: 'PAUSED' });
                document.querySelectorAll('audio').forEach(a => a.pause());
                r.mixStore.setState(r.savedMix); r.settings.setState({ loopMode: r.savedLoop });
                await window.electron.nativeAudio.request({ action: 'component-install' });
            });
        }
    });
}
module.exports = { runBrowserReview };
