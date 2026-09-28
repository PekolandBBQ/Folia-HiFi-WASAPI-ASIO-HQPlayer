const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { fixtures } = require('./remainingFixtures.cjs');

// test/manual/nativeAudioPackagedReview.cjs — exercise the actual packaged renderer and offline bootstrap.
async function attach(page) {
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0 && window.electron?.nativeAudio);
    await page.evaluate(() => {
        const r = window.__packageReview = { events: [] };
        r.walk = test => {
            const root = document.querySelector('#root'), key = Object.keys(root).find(k => k.startsWith('__reactContainer'));
            const visit = f => f && (test(f) || visit(f.child) || visit(f.sibling));
            return visit(root[key].stateNode.current);
        };
        r.props = () => r.walk(f => f.memoizedProps?.onPlaySong && Array.isArray(f.memoizedProps.localSongs) && f.memoizedProps);
        r.active = () => r.walk(f => {
            for (let h = f.memoizedState; h && typeof h === 'object'; h = h.next) {
                const v = h.memoizedState?.current; if (v?.nativeAudio && !v.disposed && v.src) return v;
            }
        });
        window.electron.nativeAudio.onEvent(e => { if (e.state) r.events.push(e.state); });
    });
    await page.waitForFunction(() => !!window.__packageReview.props());
}
async function main() {
    const output = path.resolve('test-results/native-audio-review', `packaged-${Date.now()}`); await fs.mkdir(output, { recursive: true });
    const executablePath = path.resolve('release/manual-20260929/win-unpacked/Folia Native Validation.exe');
    const app = await electron.launch({ executablePath, args: ['--native-validation-debug'], timeout: 60000 });
    const page = await app.firstWindow(), results = [];
    async function record(id, action) {
        let row; try { row = { id, status: 'PASS', ...await action() }; } catch (error) { row = { id, status: 'FAIL', error: error.message.slice(0,500) }; }
        results.push(row); console.log(JSON.stringify(row));
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        await page.screenshot({ path: path.join(output, `${id}.png`) }); return row;
    }
    try {
        const asar = path.join(path.dirname(executablePath), 'resources/app.asar');
        const host = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') }));
        await fs.writeFile(path.join(output, 'environment.json'), JSON.stringify({ ...host, asarSha256: crypto.createHash('sha256').update(await fs.readFile(asar)).digest('hex'), executableSha256: crypto.createHash('sha256').update(await fs.readFile(executablePath)).digest('hex'), source: 'packaged-file-renderer-no-dev-server' }, null, 2));
        await attach(page);
        await page.evaluate(() => { localStorage.setItem('folia_last_seen_ponder_onboarding_version', '0.7.9'); localStorage.setItem('folia_last_seen_guide_version', '0.7.9'); localStorage.setItem('auto_use_best_lyric', 'false'); localStorage.setItem('player_volume', '.1'); localStorage.setItem('folia_automix_enabled', 'false'); localStorage.setItem('folia_native_audio_backend', 'browser'); });
        await page.reload(); await attach(page);
        await record('offline-component-ready', async () => {
            const status = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' }));
            assert.equal(host.packaged, true); assert.equal(status.available, true); assert.equal(status.version, '0.1.2'); assert.equal(status.rollbackAvailable, true);
            return { ...status, rendererProtocol: new URL(page.url()).protocol, isolatedProfile: path.basename(host.profile) };
        });
        await record('real-local-folder-import', async () => {
            const entries = await fixtures(output);
            await page.evaluate(async entries => {
                const root = await navigator.storage.getDirectory(); const directory = await root.getDirectoryHandle('PackagedTaggedMusic', { create: true });
                for (const entry of entries) { const file = await directory.getFileHandle(`tagged-${entry.id}.flac`, { create: true }); const writer = await file.createWritable(); await writer.write(Uint8Array.from(atob(entry.bytes), c => c.charCodeAt(0))); await writer.close(); }
                window.showDirectoryPicker = async () => directory;
            }, entries);
            await page.getByRole('button', { name: /^(本地|Folder)$/ }).last().click();
            await page.getByRole('button', { name: /^(导入文件夹|Import Folder)$/ }).last().click();
            await page.waitForFunction(() => { const songs = window.__packageReview.props().localSongs.filter(s => s.folderName?.startsWith('PackagedTaggedMusic')); return songs.length === 2 && songs.every(s => s.replayGainAlbumGain === -12 && s.duration === 24000); });
            return { files: 2, realTags: true, picker: 'real-persistent-OPFS-directory' };
        });
        const devices = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'devices' }));
        for (const backend of ['wasapi-exclusive', 'asio']) for (const processing of ['compatibility', 'integer-direct']) {
            const device = devices.find(d => d.backend === backend && /XingCore/i.test(d.name)); assert.ok(device);
            await page.evaluate(({ backend, device, processing }) => { localStorage.setItem('folia_native_audio_backend', backend); localStorage.setItem('folia_native_audio_device', device); localStorage.setItem('folia_native_audio_processing_mode', processing); localStorage.setItem('local_replaygain_mode', 'track'); }, { backend, device: device.id, processing });
            await page.reload(); await attach(page);
            for (const index of [0, 1]) await record(`${backend}-${processing}-local-${index}`, async () => {
                await page.waitForFunction(() => window.__packageReview.props().localSongs.filter(s => s.folderName?.startsWith('PackagedTaggedMusic')).length === 2);
                await page.evaluate(async index => {
                    const r = window.__packageReview, props = r.props();
                    const localSongs = props.localSongs.filter(s => s.folderName?.startsWith('PackagedTaggedMusic')).sort((a,b) => a.title.localeCompare(b.title));
                    const songs = localSongs.map((s,i) => ({ id: -i-1, name: s.title, artists: [], album: { id: 0, name: '' }, durationMs: s.duration, isLocal: true, localRef: { songId: s.id }, sourceRef: { kind: 'local', mediaId: s.id } }));
                    r.expected = localSongs[index].id; await props.onPlaySong(songs[index], songs, false, { shouldNavigateToPlayer: false });
                }, index);
                const expected = 10 ** ((index ? -3 : -6) / 20);
                await page.waitForFunction(expected => { const r = window.__packageReview, t = r.active(), e = r.events.findLast(e => e.session === t?.session); return t?.readyState === 4 && !t.paused && !t.error && t.currentTime > .2 && r.props().currentTrack?.localRef?.songId === r.expected && e && Math.abs(e.replayGain - expected) < .00002; }, expected, { timeout: 30000 });
                await page.evaluate(() => { window.__packageReview.active().currentTime = 3; });
                await page.waitForFunction(() => !window.__packageReview.active().seeking && window.__packageReview.active().currentTime >= 3);
                await page.evaluate(async () => { const t = window.__packageReview.active(); t.pause(); await new Promise(resolve => setTimeout(resolve,150)); await t.play(); });
                return page.evaluate(() => { const r = window.__packageReview, t = r.active(), e = r.events.findLast(e => e.session === t.session); return { position: t.currentTime, replayGain: e.replayGain, effectiveGain: e.effectiveGain, mode: e.processingMode, sampleRate: e.sampleRate }; });
            });
        }
        await page.evaluate(() => { window.__packageReview.active()?.pause(); localStorage.setItem('folia_native_audio_backend','browser'); });
        await page.reload(); await attach(page);
        await record('offline-update-and-rollback', async () => {
            for (const action of ['component-rollback', 'component-install']) await page.evaluate(action => window.electron.nativeAudio.request({ action }), action);
            const status = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' })); assert.equal(status.version, '0.1.2'); return { version: status.version, busy: status.busy };
        });
    } finally { await app.close(); }
    if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
