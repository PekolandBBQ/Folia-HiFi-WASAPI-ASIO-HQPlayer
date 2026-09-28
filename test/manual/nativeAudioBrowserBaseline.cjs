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
        for (const [label, port, repository] of [['baseline', 3001, '../folia-native-review-split'], ['current', 3000, '.']]) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
            await page.addInitScript(() => { localStorage.setItem('auto_use_best_lyric', 'false'); });
            await page.goto(`http://127.0.0.1:${port}/`); await attach(page);
            const songs = await seed(page, samples);
            const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
            const dirty = execFileSync('git', ['-C', repository, 'diff', '--name-only'], { encoding: 'utf8' }).trim();
            async function record(name, action) {
                let result; try { result = { status: 'PASS', ...await action() }; } catch (e) { result = { status: 'FAIL', error: e.message.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 400) }; }
                const row = { id: `${label}-${name}`, commit, dirty, ...result }; results.push(row); console.log(JSON.stringify(row));
                await page.screenshot({ path: path.join(output, `${row.id}.png`) }); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
            }
            const start = async () => {
                await page.evaluate(async songs => {
                    const r = window.__remaining; r.songs = songs;
                    r.settings.setState({ volume: .1, isMuted: false, loopMode: 'all' });
                    const { useAutomixSettingsStore } = await import('/src/stores/useAutomixSettingsStore.ts'); useAutomixSettingsStore.setState({ automixEnabled: false });
                    await r.entry()(songs[0], songs, false, { shouldNavigateToPlayer: false });
                }, songs);
                await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > .2), null, { timeout: 15000 });
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
                await page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find(a => !a.paused); a.currentTime = a.duration - .3; });
                await page.waitForFunction(() => { const r = window.__remaining; return r.playback.getState().currentSong.id === r.songs[1].id && r.playback.getState().playerState === 'PLAYING'; }, null, { timeout: 15000 }); return { next: true };
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
