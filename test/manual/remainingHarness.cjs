const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Shared real-App inspection and sanitized evidence; no production recovery calls are bypassed.
async function attach(page) {
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0);
    await page.evaluate(async () => {
        const loaded = p => performance.getEntriesByType('resource').map(e => e.name).findLast(n => new URL(n).pathname === p) || p;
        const { usePlaybackStore: playback } = await import(loaded('/src/stores/usePlaybackStore.ts'));
        const { useAudioSettingsStore: settings } = await import(loaded('/src/stores/useAudioSettingsStore.ts'));
        const { getPlaybackSongKey } = await import('/src/utils/appPlaybackGuards.ts');
        const r = window.__remaining = { playback, settings, getPlaybackSongKey, trace: [], events: [] };
        r.walk = test => {
            const root = document.querySelector('#root'), key = Object.keys(root).find(k => k.startsWith('__reactContainer'));
            const visit = f => { if (!f) return; const hit = test(f); return hit || visit(f.child) || visit(f.sibling); };
            return visit(root[key].stateNode.current);
        };
        r.entry = () => r.walk(f => f.type?.name === 'Grid3D' && f.memoizedProps?.onPlaySong);
        r.active = () => r.walk(f => {
            if (f.type?.name !== 'NativeDeck') return;
            for (let h = f.memoizedState; h; h = h.next) { const v = h.memoizedState?.current; if (v?.nativeAudio && !v.disposed && v.src) return v; }
        });
        r.unsubscribe = playback.subscribe((s, p) => {
            if (s.currentSong !== p.currentSong || s.audioSrc !== p.audioSrc || s.playerState !== p.playerState)
                r.trace.push({ at: performance.now(), song: s.currentSong?.name, key: s.currentSong && getPlaybackSongKey(s.currentSong), state: s.playerState, scheme: s.audioSrc?.split(':')[0], stack: new Error().stack?.split('\n').slice(2, 9).map(l => l.replace(/https?:\/\/[^/]+/g, '[origin]')) });
        });
        if (window.electron?.nativeAudio) {
            r.off = window.electron.nativeAudio.onEvent(e => { if (e.state) { r.events.push(e.state); if (r.events.length > 500) r.events.shift(); } });
            r.devices = (await window.electron.nativeAudio.request({ action: 'devices' })).filter(d => /XingCore/i.test(d.name));
        }
    });
    await page.waitForFunction(() => !!window.__remaining.entry());
}
async function connect(label) {
    const output = path.resolve('test-results/native-audio-review', `${label}-${Date.now()}`); await fs.mkdir(output, { recursive: true });
    const browser = await chromium.connectOverCDP('http://127.0.0.1:19333');
    const page = browser.contexts()[0].pages().find(p => /^http:\/\/(localhost|127.0.0.1):3000\//.test(p.url()));
    const hash = async f => crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex');
    const files = ['src/hooks/useSessionRestoreController.ts', 'src/components/app/playback/restorePlaybackSource.ts', 'src/services/nativeAudio/NativeAudioTransport.ts', 'electron/nativeAudio/componentVersions.cjs', __filename, process.argv[1]];
    await fs.writeFile(path.join(output, 'environment.json'), JSON.stringify({ started: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), changes: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n'), hashes: Object.fromEntries(await Promise.all(files.map(async f => [path.relative(process.cwd(), f), await hash(f)]))) }, null, 2));
    const results = [];
    async function record(id, action) {
        let result; const started = Date.now();
        try { result = { status: 'PASS', ...await action() }; }
        catch (e) { result = { status: 'FAIL', error: String(e.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 800) }; }
        const observation = await page.evaluate(() => { const r = window.__remaining, t = r?.active(), s = r?.playback.getState(); return { song: s?.currentSong?.name, state: s?.playerState, scheme: s?.audioSrc?.split(':')[0], paused: t?.paused, ready: t?.readyState, error: t?.error?.message, position: t?.currentTime }; }).catch(() => null);
        const row = { elapsedMs: Date.now() - started, ...result, observation, id }; results.push(row);
        await fs.writeFile(path.join(output, `${id}-trace.json`), JSON.stringify(await page.evaluate(() => window.__remaining?.trace), null, 2));
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        try { await page.screenshot({ path: path.join(output, `${id}.png`), timeout: 15000 }); }
        catch (error) { row.screenshotError = error.message.slice(0, 150); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); }
        console.log(JSON.stringify(row)); return row;
    }
    return { browser, page, output, record, results };
}
module.exports = { attach, connect };
