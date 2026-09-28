const fs = require('node:fs/promises');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { createComponentManager } = require('../../electron/nativeAudio/componentManager.cjs');
const { createHelper } = require('../../electron/nativeAudio/helper.cjs');

// Real Windows locks and killed installers; only disposable test profiles are mutated.
async function child() {
    const [root, stopAt] = process.argv.slice(3);
    const rename = fs.rename;
    fs.rename = async (from, to) => {
        if (stopAt === 'before-active' && path.basename(to) === 'active.json') {
            process.send('checkpoint'); await new Promise(() => {});
        }
        const result = await rename(from, to);
        if (stopAt === 'after-active' && path.basename(to) === 'active.json') {
            process.send('checkpoint'); await new Promise(() => {});
        }
        return result;
    };
    await createComponentManager({ app: { isPackaged: false, getPath: () => root }, catalogPath: path.join(root, 'catalog.json') }).install();
}
async function lock(file, sharing = 'Read') {
    const script = "$s=[IO.File]::Open($env:FOLIA_LOCK_FILE,'Open','Read',[IO.FileShare]::" + sharing + "); [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null; $s.Dispose()";
    const proc = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, env: { ...process.env, FOLIA_LOCK_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { proc.stdout.on('data', b => { if (b.toString().includes('LOCKED')) resolve(); }); proc.on('exit', () => reject(new Error('lock exited'))); proc.stderr.on('data', b => reject(new Error(b.toString()))); });
    return async () => { const done = once(proc, 'exit'); proc.stdin.end('\n'); await done; };
}
async function main() {
    const output = path.resolve('test-results/native-audio-review', `windows-${Date.now()}`);
    await fs.mkdir(output, { recursive: true });
    const catalog = JSON.parse(await fs.readFile('../folia-native-audio-component/artifacts/development-catalog.json', 'utf8'));
    const results = [];
    for (const scenario of ['active-pointer-locked', 'archive-locked', 'running-old-executable', 'obsolete-executable-locked', 'before-active', 'after-active']) {
        const root = path.join(output, scenario); await fs.mkdir(root);
        const catalogPath = path.join(root, 'catalog.json');
        const writeCatalog = releases => fs.writeFile(catalogPath, JSON.stringify({ schema: 1, releases }));
        const manager = createComponentManager({ app: { isPackaged: false, getPath: () => root }, catalogPath });
        let unlock, helper, installer;
        try {
            await writeCatalog([catalog.releases[2]]);
            const old = await manager.install();
            if (scenario === 'obsolete-executable-locked') {
                await writeCatalog(catalog.releases.slice(1)); await manager.install();
                unlock = await lock(old.executable);
            }
            if (scenario === 'active-pointer-locked') unlock = await lock(path.join(root, 'components/native-audio/active.json'));
            if (scenario === 'archive-locked') {
                const copy = path.join(root, 'locked.zip'); await fs.copyFile(catalog.releases[0].localPath, copy);
                unlock = await lock(copy, 'None');
                await writeCatalog([{ ...catalog.releases[0], localPath: copy }, ...catalog.releases.slice(1)]);
            } else await writeCatalog(catalog.releases);
            if (scenario === 'running-old-executable') { helper = createHelper(old.executable, () => {}); await helper.request({ action: 'hello', protocolMajor: 1 }); }
            let error;
            if (scenario.endsWith('-active')) {
                installer = fork(__filename, ['--child', root, scenario], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
                await Promise.race([once(installer, 'message'), new Promise((_, reject) => setTimeout(() => reject(new Error('checkpoint timeout')), 15000).unref())]);
                const stopped = once(installer, 'exit'); installer.kill(); await stopped; installer = null;
            } else { try { await manager.install(); } catch (e) { error = e.code || e.message; } }
            const state = await manager.status();
            const expectedOld = ['active-pointer-locked', 'archive-locked', 'before-active'].includes(scenario);
            assert.equal(state.available, true); assert.equal(state.version, expectedOld ? '0.1.0' : '0.1.2');
            assert.equal(state.busy, false);
            if (scenario === 'obsolete-executable-locked') assert.equal(error, undefined, 'successful activation must not report failed update solely because obsolete cleanup is locked');
            if (unlock) { await unlock(); unlock = null; }
            helper?.dispose(); helper = null;
            const retried = await manager.install(); assert.equal(retried.version, '0.1.2');
            const fresh = createHelper(retried.executable, () => {});
            try { assert.equal((await fresh.request({ action: 'hello', protocolMajor: 1 })).componentVersion, '0.1.2'); } finally { fresh.dispose(); }
            results.push({ scenario, status: 'PASS', observedVersion: state.version, error, retryVersion: retried.version });
        } catch (e) { results.push({ scenario, status: 'FAIL', error: e.message, state: await manager.status().then(({ executable, ...s }) => s).catch(() => null) }); }
        finally { if (unlock) await unlock(); helper?.dispose(); installer?.kill(); }
        console.log(JSON.stringify(results.at(-1)));
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    }
    if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
(process.argv[2] === '--child' ? child() : main()).catch(e => { console.error(e); process.exitCode = 1; });
