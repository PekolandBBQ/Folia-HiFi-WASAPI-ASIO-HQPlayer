const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixtures } = require('./remainingFixtures.cjs');

// test/manual/nativeAudioOfficialReview.cjs — unchanged official binary, isolated disposable profile.
async function main() {
    const output = path.resolve('test-results/native-audio-review', `official-079-${Date.now()}`);
    await fs.mkdir(output, { recursive: true });
    const profile = path.join(output, 'profile');
    const app = await electron.launch({ executablePath: path.resolve('../artifacts/official-runtime-0.7.9/Folia.exe'), args: [`--user-data-dir=${profile}`], env: { ...process.env, ELECTRON_DEV: 'false', NODE_ENV: 'production' }, timeout: 60000 });
    const rows = [];
    try {
        const host = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData') }));
        assert.equal(path.resolve(host.profile).toLowerCase(), profile.toLowerCase());
        assert.equal(host.version, '0.7.9'); assert.equal(host.packaged, true);
        const page = await app.firstWindow();
        await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0);
        await page.evaluate(() => { localStorage.setItem('folia_last_seen_guide_version','0.7.9'); localStorage.setItem('folia_last_seen_ponder_onboarding_version','0.7.9'); localStorage.setItem('auto_use_best_lyric','false'); localStorage.setItem('player_volume','.1'); });
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0);
        await page.evaluate(() => {
            window.__officialProps = () => {
                const root = document.querySelector('#root'), key = Object.keys(root).find(k => k.startsWith('__reactContainer'));
                const visit = f => f && ((f.memoizedProps?.onPlaySong && Array.isArray(f.memoizedProps.localSongs) && f.memoizedProps) || visit(f.child) || visit(f.sibling));
                return visit(root[key].stateNode.current);
            };
        });
        await page.waitForFunction(() => !!window.__officialProps());
        assert.equal(await page.evaluate(() => !!window.electron?.nativeAudio), false);
        rows.push({ id: 'official-binary-isolated-launch', status: 'PASS', version: host.version, stockNativeExtension: false });
        await page.screenshot({ path: path.join(output, 'official-launch.png') });
        const entries = await fixtures(output);
        await page.evaluate(async entries => {
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('OfficialTaggedMusic', { create: true });
            for (const entry of entries) { const writer = await (await directory.getFileHandle(`tagged-${entry.id}.flac`, { create: true })).createWritable(); await writer.write(Uint8Array.from(atob(entry.bytes), c => c.charCodeAt(0))); await writer.close(); }
            window.showDirectoryPicker = async () => directory;
        }, entries);
        const close = page.getByTestId('release-notes-close'); if (await close.isVisible()) await close.click();
        await page.getByRole('button', { name: /^(本地|Folder)$/ }).last().click();
        await page.getByRole('button', { name: /^(导入文件夹|Import Folder)$/ }).last().click();
        await page.waitForFunction(() => window.__officialProps().localSongs.filter(s => s.folderName?.startsWith('OfficialTaggedMusic') && s.replayGainAlbumGain === -12).length === 2);
        rows.push({ id: 'official-local-import-tags', status: 'PASS', files: 2 });
        await page.evaluate(async () => {
            const props = window.__officialProps(), local = props.localSongs.filter(s => s.folderName?.startsWith('OfficialTaggedMusic'));
            const songs = local.map((s,i) => ({ id: -i-1, name:s.title, artists:[], album:{id:0,name:''}, durationMs:s.duration, isLocal:true, localRef:{songId:s.id}, sourceRef:{kind:'local',mediaId:s.id} }));
            await props.onPlaySong(songs[0], songs, false, { shouldNavigateToPlayer: false });
        });
        await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > .5 && !a.error));
        await page.evaluate(async () => { const a = [...document.querySelectorAll('audio')].find(a => !a.paused); a.currentTime=3; a.pause(); await a.play(); });
        await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime >= 3 && !a.error));
        rows.push({ id: 'official-web-local-play-seek-resume', status: 'PASS' });
        await page.screenshot({ path: path.join(output, 'official-local-playing.png') });
    } catch (error) { rows.push({ id:'official-check', status:'FAIL', error:error.message }); process.exitCode=1; }
    finally { await fs.writeFile(path.join(output,'results.json'), JSON.stringify(rows,null,2)); rows.forEach(r => console.log(JSON.stringify(r))); await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
