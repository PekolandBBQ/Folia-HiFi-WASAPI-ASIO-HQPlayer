import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const roots: string[] = [];
const sha = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
const entryPath = path.resolve('packaging/exclusive/exclusive-entry.cjs');
const pointer = (release: any) => ({ archiveSha256: release.sha256, executableSha256: release.entrySha256 });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-exclusive-entry-')); roots.push(root);
    const appData = path.join(root, 'appdata'), profile = path.join(appData, 'FoliaEntryTest');
    const resourceRoot = path.join(root, 'resources'), bundled = path.join(resourceRoot, 'exclusive-native-audio');
    await fs.mkdir(bundled, { recursive: true }); await fs.mkdir(profile, { recursive: true });
    const nativeReleases: any[] = [], hqpReleases: any[] = [];
    async function publishNative(version: string) {
        const archive = `native-${version}.zip`, bytes = zipSync({
            'folia-audio.exe': Buffer.from(`non-executed native fixture ${version}`),
            'component.json': Buffer.from(JSON.stringify({ id: 'native-audio', version, protocolMajor: 1 })),
        });
        await fs.writeFile(path.join(bundled, archive), bytes);
        nativeReleases.unshift({ version, protocolMajor: 1, platform: 'win32-x64', archive, sha256: sha(bytes) });
    }
    async function publishHqp(version: string, extra: Record<string, Uint8Array> = {}, helpers = true) {
        const files: Record<string, Uint8Array> = {
            'hqplayer-component.cjs': Buffer.from(`throw new Error('Must never execute fixture ${version}');`),
            'component.json': Buffer.from(JSON.stringify({ id: 'hqplayer', version, protocolMajor: 1, entry: 'hqplayer-component.cjs' })),
            'LICENSE.txt': Buffer.from('Fixture license'), 'NOTICE.txt': Buffer.from('Fixture notice'),
            ...(helpers ? { 'folia-hqplayer-launch.exe': Buffer.from('non-executed launcher'),
                'folia-hqplayer-window.dll': Buffer.from('non-executed guard'), 'Detours-LICENSE.txt': Buffer.from('Fixture Detours license') } : {}),
            ...extra,
        };
        const archive = `hqplayer-${version}.zip`, bytes = zipSync(files);
        await fs.writeFile(path.join(bundled, archive), bytes);
        const release = { version, protocolMajor: 1, platform: 'win32-x64', archive, sha256: sha(bytes), entrySha256: sha(files['hqplayer-component.cjs']) };
        hqpReleases.unshift(release); return { release, files };
    }
    const hqpDirectory = path.join(profile, 'components', 'hqplayer');
    async function seedHqp(value: { release: any; files: Record<string, Uint8Array> }) {
        const directory = path.join(hqpDirectory, `${value.release.version}-${value.release.sha256.slice(0, 12)}`);
        await fs.mkdir(directory, { recursive: true });
        for (const [name, bytes] of Object.entries(value.files)) await fs.writeFile(path.join(directory, name), bytes);
        await fs.writeFile(path.join(hqpDirectory, 'active.json'), JSON.stringify(pointer(value.release)));
    }
    const mainRequested = vi.fn(), errorBox = vi.fn(), storeSet = vi.fn(), verifyStaged = vi.fn(async () => {});
    const hqpModule = { ...require('../../../electron/hqplayer/componentManager.cjs') };
    const actualCreate = hqpModule.createHQPlayerComponentManager;
    hqpModule.createHQPlayerComponentManager = (options: any) => actualCreate({ ...options, verifyStaged });
    const appPaths: Record<string, string> = { appData, userData: profile };
    const app = { isPackaged: true, getPath: (name: string) => appPaths[name], setPath: (name: string, value: string) => { appPaths[name] = value; },
        setName: vi.fn(), exit: vi.fn() };
    function execute() {
        const localRequire = (id: string) => {
            if (['node:fs', 'node:path', 'node:crypto', 'fflate'].includes(id)) return require(id);
            if (id === 'electron') return { app, dialog: { showErrorBox: errorBox } };
            if (id === './profile.cjs') return require('../../../packaging/exclusive/profile.cjs');
            if (id === './exclusive-approved.json') return { releases: nativeReleases };
            if (id === './hqplayer-approved.json') return { releases: hqpReleases };
            if (id === './release.json') return { version: '0.7.12', upstreamVersion: '0.7.12', productName: 'FoliaEntryTest', profile: 'FoliaEntryTest', legacyProfile: 'FoliaEntryLegacy' };
            if (id === './nativeAudio/componentManager.cjs') return { createComponentManager: vi.fn() };
            if (id === './hqplayer/archiveContract.cjs') return require('../../../electron/hqplayer/archiveContract.cjs');
            if (id === './hqplayer/componentManager.cjs') return hqpModule;
            if (id === 'electron-store') return class { set = storeSet; };
            if (id === './main.cjs') { mainRequested(); return {}; }
            throw new Error(`Unexpected packaging entry dependency: ${id}`);
        };
        // Run the actual saved CJS entry with only Electron/main replaced; ZIP/filesystem/profile are real.
        const context = vm.createContext({ require: localRequire, Buffer, process: { resourcesPath: resourceRoot, env: {} } });
        new vm.Script(`(function () {\n${syncFs.readFileSync(entryPath, 'utf8')}\n})()`, { filename: entryPath }).runInContext(context);
    }
    await publishNative('0.1.1'); await publishNative('0.1.2');
    return { root, profile, hqpDirectory, publishHqp, seedHqp, execute, mainRequested, errorBox, verifyStaged, storeSet,
        manager: () => hqpModule.createHQPlayerComponentManager({ app, catalogPath: path.join(profile, 'hqplayer-component-catalog.json') }) };
}

describe('packaged exclusive entry with real approved ZIP artifacts', () => {
    it('stages the seven-file helper package into an isolated profile on first startup', async () => {
        const f = await fixture(), current = await f.publishHqp('0.1.4-preview.3'); f.execute();
        const destination = path.join(f.hqpDirectory, `${current.release.version}-${current.release.sha256.slice(0, 12)}`);
        expect((await fs.readdir(destination)).sort()).toEqual(Object.keys(current.files).sort());
        for (const [name, bytes] of Object.entries(current.files)) expect(await fs.readFile(path.join(destination, name))).toEqual(Buffer.from(bytes));
        expect(JSON.parse(await fs.readFile(path.join(f.hqpDirectory, 'active.json'), 'utf8'))).toEqual(pointer(current.release));
        expect(await f.manager().status()).toMatchObject({ available: true, version: '0.1.4-preview.3' });
        expect(f.mainRequested).toHaveBeenCalledOnce(); expect(f.errorBox).not.toHaveBeenCalled();
        expect(f.storeSet).toHaveBeenCalledWith('ENABLE_AUTO_UPDATE', false);
    });
    it('upgrades a known four-file old package and retains a functional rollback pointer', async () => {
        const f = await fixture(), old = await f.publishHqp('0.1.3', {}, false); await f.seedHqp(old);
        const current = await f.publishHqp('0.1.4-preview.3'); f.execute();
        expect(JSON.parse(await fs.readFile(path.join(f.hqpDirectory, 'previous.json'), 'utf8'))).toEqual(pointer(old.release));
        const manager = f.manager(); expect(await manager.status()).toMatchObject({ available: true, version: current.release.version, rollbackAvailable: true });
        expect(await manager.rollback()).toMatchObject({ available: true, version: old.release.version });
        expect(JSON.parse(await fs.readFile(path.join(f.hqpDirectory, 'active.json'), 'utf8'))).toEqual(pointer(old.release));
        expect(f.verifyStaged).toHaveBeenCalledOnce(); expect(f.mainRequested).toHaveBeenCalledOnce();
    });
    it('rejects an extra DLL without changing existing activation or loading main', async () => {
        const f = await fixture(), old = await f.publishHqp('0.1.3', {}, false); await f.seedHqp(old);
        const before = await fs.readFile(path.join(f.hqpDirectory, 'active.json'));
        await f.publishHqp('0.1.4-preview.3', { 'unrelated.dll': Buffer.from('must not be staged') });
        expect(() => f.execute()).toThrow('Unexpected HQPlayer archive entry');
        expect(await fs.readFile(path.join(f.hqpDirectory, 'active.json'))).toEqual(before);
        expect(f.mainRequested).not.toHaveBeenCalled(); expect(f.verifyStaged).not.toHaveBeenCalled();
        expect(await f.manager().status()).toMatchObject({ available: true, version: old.release.version });
    });
});
