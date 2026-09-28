const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { attach } = require('./remainingHarness.cjs');
const { fixtures, seed } = require('./remainingFixtures.cjs');
const assert = require('node:assert/strict');

// Identical full-browser App scenarios against untouched upstream and current source.
async function main() {
    const output = path.resolve('test-results/native-audio-review', `browser-ab-${Date.now()}`); await fs.mkdir(output, { recursive: true });
    const samples = await fixtures(output), results = []; let hits = 0;
    const server = http.createServer((q, s) => { hits++; s.writeHead(q.url.includes('404') ? 404 : 200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'audio/flac' }); s.end('invalid audio'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    try {
        for (const [label, port, repository] of [['baseline', 3001, null], ['current', 3000, '.']]) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
            await page.addInitScript(() => {
                localStorage.setItem('auto_use_best_lyric', 'false');
                const createGain = AudioContext.prototype.createGain;
                window.__actualGains = [];
                AudioContext.prototype.createGain = function () { const node = createGain.call(this); window.__actualGains.push(node); return node; };
            });
            await page.goto(`http://127.0.0.1:${port}/`); await attach(page);
            // Chromium cannot reliably seek the last block of the tiny generated FLAC (demuxer seek failed).
            // Use the identical uncompressed PCM for transport tests; tag parsing still uses the physical FLAC.
            const songs = await seed(page, samples.map(s => ({ ...s, cachePcm: true })));
            const commit = repository ? execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : 'd2b84674ce83329c1d62a371305e691de20e0950';
            const dirty = repository ? execFileSync('git', ['-C', repository, 'diff', '--name-only'], { encoding: 'utf8' }).trim() : 'read-only git archive; test configuration only';
            async function record(name, action) {
                let result; try { result = { status: 'PASS', ...await action() }; } catch (e) { result = { status: 'FAIL', error: e.message.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 400) }; }
                const row = { id: `${label}-${name}`, commit, dirty, ...result }; results.push(row); console.log(JSON.stringify(row));
                await fs.writeFile(path.join(output, `${row.id}-trace.json`), JSON.stringify(await page.evaluate(() => ({ changes: window.__remaining.trace, loop: window.__remaining.loopTrace })), null, 2));
                await page.screenshot({ path: path.join(output, `${row.id}.png`) }); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
            }
            const start = async () => {
                await page.evaluate(async songs => {
                    const r = window.__remaining; r.songs = songs;
                    r.settings.setState({ volume: .1, isMuted: false, loopMode: 'all' });
                    const { useAutomixSettingsStore } = await import('/src/stores/useAutomixSettingsStore.ts'); useAutomixSettingsStore.setState({ automixEnabled: false });
                    await r.entry()(songs[0], songs, false, { shouldNavigateToPlayer: false });
                }, songs);
                await page.waitForFunction(() => {
                    const r = window.__remaining, s = r.playback.getState();
                    return s.currentSong?.id === r.songs[0].id && s.playerState === 'PLAYING'
                        && [...document.querySelectorAll('audio')].some(a => a.currentSrc === s.audioSrc && !a.paused && a.currentTime > .2);
                }, null, { timeout: 15000 });
            };
            await record('cached-play-seek-pause-resume', async () => {
                await start();
                await page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find(a => !a.paused); window.__remaining.web = a; a.currentTime = 3; });
                await page.waitForFunction(() => !window.__remaining.web.seeking && window.__remaining.web.currentTime >= 3);
                await page.evaluate(() => window.__remaining.web.pause());
                await page.waitForFunction(() => window.__remaining.playback.getState().playerState === 'PAUSED');
                await page.evaluate(() => window.__remaining.web.play());
                await page.waitForFunction(() => window.__remaining.playback.getState().playerState === 'PLAYING');
                return { realApp: true, componentBridgePresent: await page.evaluate(() => !!window.electron?.nativeAudio), cachedBlob: await page.evaluate(() => window.__remaining.playback.getState().audioSrc.startsWith('blob:')) };
            });
            await record('natural-next-track', async () => {
                await page.evaluate(() => { const r = window.__remaining; r.naturalEnds = 0; r.mediaErrors = 0; document.querySelectorAll('audio').forEach(a => { a.addEventListener('ended', () => r.naturalEnds++); a.addEventListener('error', () => r.mediaErrors++); }); });
                await page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find(a => !a.paused); a.currentTime = a.duration - .3; });
                await page.waitForFunction(() => { const r = window.__remaining; return r.playback.getState().currentSong.id === r.songs[1].id && r.playback.getState().playerState === 'PLAYING'; }, null, { timeout: 15000 });
                const observed = await page.evaluate(() => ({ ended: window.__remaining.naturalEnds, errors: window.__remaining.mediaErrors }));
                assert.ok(observed.ended > 0); assert.equal(observed.errors, 0); return { next: true, ...observed };
            });
            for (const [mode, db] of [['track', -6], ['album', -12], ['off', 0]]) await record(`real-web-replaygain-${mode}`, async () => {
                await start(); const expected = 10 ** (db / 20);
                await page.evaluate(mode => window.__remaining.playback.setState({ replayGainMode: mode }), mode);
                await page.waitForFunction(expected => window.__actualGains.some(n => Math.abs(n.gain.value - expected) < .00002), expected);
                return { expected, observed: await page.evaluate(expected => window.__actualGains.find(n => Math.abs(n.gain.value - expected) < .00002).gain.value, expected), realAudioContext: true };
            });
            await record('single-track-loop', async () => {
                await start();
                await page.evaluate(() => { const r = window.__remaining; r.loopTrace = []; r.sampleLoop = phase => r.loopTrace.push({ phase, song: r.playback.getState().currentSong.id, mode: r.settings.getState().loopMode, audio: [...document.querySelectorAll('audio')].map(a => ({ time: a.currentTime, loop: a.loop, paused: a.paused, current: a.currentSrc === r.playback.getState().audioSrc, error: a.error && { code: a.error.code, message: a.error.message } })) }); r.sampleLoop('start'); r.web = [...document.querySelectorAll('audio')].find(a => a.currentSrc === r.playback.getState().audioSrc && !a.paused); for (const name of ['ended','error','seeking','seeked']) r.web.addEventListener(name, () => r.sampleLoop(name)); r.settings.setState({ loopMode: 'one' }); });
                await page.waitForFunction(() => window.__remaining.web.loop);
                await page.evaluate(() => { const r = window.__remaining; r.sampleLoop('before-seek'); const a = r.web; a.currentTime = a.duration - .2; });
                await page.waitForFunction(() => { const a = window.__remaining.web; return a.loop && !a.paused && a.currentTime < 1; });
                await page.evaluate(() => window.__remaining.sampleLoop('after-loop'));
                assert.equal(await page.evaluate(() => window.__remaining.playback.getState().currentSong.id), songs[0].id); return { looped: true };
            });
            await record('automix-dual-deck', async () => {
                await start();
                await page.evaluate(async () => {
                    const r = window.__remaining; r.maxDecks = 0; r.cues = [];
                    const { subscribeToTransitionCue } = await import('/src/services/automix/transitionCue.ts');
                    r.offCue = subscribeToTransitionCue(c => { if (c && !c.preview) r.cues.push({ plain: !!c.plain, seconds: c.seconds }); });
                    r.timer = setInterval(() => { r.maxDecks = Math.max(r.maxDecks, [...document.querySelectorAll('audio')].filter(a => !a.paused && !a.ended).length); }, 20);
                    (await import('/src/stores/useAutomixSettingsStore.ts')).useAutomixSettingsStore.setState({ automixEnabled: true, transitionMode: 'automix' });
                    const a = [...document.querySelectorAll('audio')].find(a => !a.paused); a.currentTime = a.duration - 16;
                });
                try {
                    await page.waitForFunction(() => { const r = window.__remaining; return r.playback.getState().currentSong.id === r.songs[1].id && r.playback.getState().playerState === 'PLAYING' && r.maxDecks >= 2 && r.cues.length > 0; }, null, { timeout: 40000 });
                    return page.evaluate(() => ({ maxDecks: window.__remaining.maxDecks, cues: window.__remaining.cues }));
                } finally { await page.evaluate(() => { clearInterval(window.__remaining.timer); window.__remaining.offCue(); }); }
            });
            for (const fault of ['404', 'decode']) await record(`${fault}-error-next-recovery`, async () => {
                await start(); const before = hits;
                await page.evaluate(url => window.__remaining.playback.getState().setAudioSrc(url), `http://127.0.0.1:${server.address().port}/${fault}.flac`);
                await page.waitForFunction(() => { const r = window.__remaining, s = r.playback.getState(); return s.playerState === 'PLAYING' && s.audioSrc?.startsWith('blob:') && [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > .2); }, null, { timeout: 20000 });
                assert.ok(hits > before); return { requests: hits - before, recoverySong: await page.evaluate(() => window.__remaining.playback.getState().currentSong.name) };
            });
            await context.close();
        }
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
