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
    const nativeReleases: any[] = [], legacyNativeReleases: any[] = [], hqpReleases: any[] = [], legacyHqpReleases: any[] = [];
    async function publishNative(version: string) {
        const archive = `native-${version}.zip`, files = {
            'folia-audio.exe': Buffer.from(`non-executed native fixture ${version}`),
            'component.json': Buffer.from(JSON.stringify({ id: 'native-audio', version, protocolMajor: 1 })),
        }, bytes = zipSync(files);
        await fs.writeFile(path.join(bundled, archive), bytes);
        const release = { version, protocolMajor: 1, platform: 'win32-x64', archive, sha256: sha(bytes), entrySha256: sha(files['folia-audio.exe']) };
        nativeReleases.unshift(release); return { release, files };
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
    const nativeModule = { ...require('../../../electron/nativeAudio/componentManager.cjs') };
    const nativeDirectory = path.join(profile, 'components', 'native-audio');
    async function seedNative(value: { release: any; files: Record<string, Uint8Array> }, disabled = false) {
        const directory = path.join(nativeDirectory, `${value.release.version}-${value.release.sha256.slice(0, 12)}`);
        await fs.mkdir(directory, { recursive: true });
        for (const [name, bytes] of Object.entries(value.files)) await fs.writeFile(path.join(directory, name), bytes);
        await fs.writeFile(path.join(nativeDirectory, disabled ? 'inactive.json' : 'active.json'), JSON.stringify(pointer(value.release)));
    }
    function execute() {
        const localRequire = (id: string) => {
            if (['node:fs', 'node:path', 'node:crypto', 'fflate'].includes(id)) return require(id);
            if (id === 'electron') return { app, dialog: { showErrorBox: errorBox } };
            if (id === './profile.cjs') return require('../../../packaging/exclusive/profile.cjs');
            if (id === './exclusive-approved.json') return { releases: nativeReleases };
            if (id === './hqplayer-approved.json') return { releases: hqpReleases };
            if (id === './release.json') return { version: '0.7.19', upstreamVersion: '0.7.19', productName: 'FoliaEntryTest', profile: 'FoliaEntryTest', legacyProfile: 'FoliaEntryLegacy', compatibleNativeReleases: legacyNativeReleases, compatibleHQPlayerReleases: legacyHqpReleases };
            if (id === './nativeAudio/componentManager.cjs') return nativeModule;
            if (id === './hqplayer/archiveContract.cjs') return require('../../../electron/hqplayer/archiveContract.cjs');
            if (id === './hqplayer/bundledUpgrade.cjs') return require('../../../electron/hqplayer/bundledUpgrade.cjs');
            if (id === './hqplayer/componentManager.cjs') return hqpModule;
            if (id === 'electron-store') return class { set = storeSet; get = () => undefined; };
            if (id === './main.cjs') { mainRequested(); return {}; }
            throw new Error(`Unexpected packaging entry dependency: ${id}`);
        };
        // Run the actual saved CJS entry with only Electron/main replaced; ZIP/filesystem/profile are real.
        const context = vm.createContext({ global: {}, require: localRequire, Buffer, process: { resourcesPath: resourceRoot, env: {} } });
        new vm.Script(`(function () {\n${syncFs.readFileSync(entryPath, 'utf8')}\n})()`, { filename: entryPath }).runInContext(context);
    }
    await publishNative('0.1.1'); await publishNative('0.1.2');
    return { root, profile, hqpDirectory, publishHqp, seedHqp, execute, mainRequested, errorBox, verifyStaged, storeSet,
        nativeDirectory, publishNative, seedNative, nativeReleases, legacyNativeReleases, hqpReleases, legacyHqpReleases,
        nativeManager: () => nativeModule.createComponentManager({ app }),
        manager: () => hqpModule.createHQPlayerComponentManager({ app, catalogPath: path.join(profile, 'hqplayer-component-catalog.json') }) };
}

describe('packaged exclusive entry with real approved ZIP artifacts', () => {
    it('upgrades a legacy HQPlayer release absent from the bundled ZIP list and keeps rollback available', async () => {
        const f = await fixture(), old = await f.publishHqp('0.1.3', {}, false); await f.seedHqp(old);
        const previous = { archiveSha256: '3'.repeat(64), executableSha256: '4'.repeat(64) };
        await fs.writeFile(path.join(f.hqpDirectory, 'previous.json'), JSON.stringify(previous));
        const current = await f.publishHqp('0.1.4-preview.5'); f.hqpReleases.splice(1); f.legacyHqpReleases.push(old.release);
        f.execute();
        expect(await f.manager().status()).toMatchObject({ available: true, version: current.release.version, rollbackAvailable: true });
        expect(JSON.parse(await fs.readFile(path.join(f.hqpDirectory, 'upgrade-receipts', `${old.release.sha256}.json`), 'utf8'))).toEqual({ active: pointer(old.release), previous });
        expect(await fs.readFile(path.join(f.hqpDirectory, `${old.release.version}-${old.release.sha256.slice(0, 12)}`, 'hqplayer-component.cjs'))).toEqual(old.files['hqplayer-component.cjs']);
        expect(await f.manager().rollback()).toMatchObject({ available: true, version: old.release.version });
    });
    it('upgrades retained legacy native activation, preserves its files and supports rollback', async () => {
        const f = await fixture(), old = await f.publishNative('0.1.2'); await f.seedNative(old);
        const oldPrevious = { archiveSha256: '1'.repeat(64), executableSha256: '2'.repeat(64) };
        await fs.writeFile(path.join(f.nativeDirectory, 'previous.json'), JSON.stringify(oldPrevious));
        const current = await f.publishNative('0.1.3-preview.2');
        f.nativeReleases.splice(1); f.legacyNativeReleases.push(old.release);
        await f.publishHqp('0.1.4-preview.5'); f.execute();
        expect(await f.nativeManager().status()).toMatchObject({ available: true, version: current.release.version, rollbackAvailable: true });
        expect(await fs.readFile(path.join(f.nativeDirectory, `${old.release.version}-${old.release.sha256.slice(0, 12)}`, 'folia-audio.exe'))).toEqual(old.files['folia-audio.exe']);
        expect(JSON.parse(await fs.readFile(path.join(f.nativeDirectory, 'upgrade-receipts', `${old.release.sha256}.json`), 'utf8'))).toEqual({ active: pointer(old.release), previous: oldPrevious });
        const receipt = await fs.stat(path.join(f.nativeDirectory, 'active.json'));
        f.execute(); expect((await fs.stat(path.join(f.nativeDirectory, 'active.json'))).mtimeMs).toBe(receipt.mtimeMs);
        expect(await f.nativeManager().rollback()).toMatchObject({ available: true, version: old.release.version });
    });
    it('respects explicitly disabled native components on a newer application', async () => {
        const f = await fixture(), old = await f.publishNative('0.1.2'); await f.seedNative(old, true);
        await f.publishNative('0.1.3-preview.2'); await f.publishHqp('0.1.4-preview.5'); f.execute();
        expect(await f.nativeManager().status()).toMatchObject({ available: false, installed: false, installable: true });
        expect(await fs.readFile(path.join(f.nativeDirectory, 'inactive.json'), 'utf8')).toBe(JSON.stringify(pointer(old.release)));
        expect(syncFs.existsSync(path.join(f.nativeDirectory, 'active.json'))).toBe(false);
    });
    it('retains unknown native activation instead of downgrading it', async () => {
        const f = await fixture(), newer = await f.publishNative('0.2.0'); await f.seedNative(newer);
        f.nativeReleases.shift(); await f.publishHqp('0.1.4-preview.5'); f.execute();
        expect(await fs.readFile(path.join(f.nativeDirectory, 'active.json'), 'utf8')).toBe(JSON.stringify(pointer(newer.release)));
    });
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
    it.each(['0.1.3','0.1.4-preview.3','0.1.4-preview.4','0.1.4-preview.5','0.1.4-preview.6','0.1.4-preview.7'])('upgrades known %s activation to the WAV release and retains rollback', async version => {
        const f=await fixture(),old=await f.publishHqp(version);await f.seedHqp(old);
        await f.publishHqp('0.1.4-preview.8');f.execute();
        expect(await f.manager().status()).toMatchObject({available:true,version:'0.1.4-preview.8',rollbackAvailable:true});
        expect(JSON.parse(await fs.readFile(path.join(f.hqpDirectory,'previous.json'),'utf8'))).toEqual(pointer(old.release));
    });
    it('prunes only obsolete known component folders and retains settings, backups, rollback and receipts', async()=>{
        const f=await fixture(),old=await f.publishHqp('0.1.4-preview.4');await f.seedHqp(old);
        const older=await f.publishHqp('0.1.4-preview.6');await f.seedHqp(older);
        const previous=await f.publishHqp('0.1.4-preview.7');await f.seedHqp(previous);
        await fs.writeFile(path.join(f.hqpDirectory,'previous.json'),JSON.stringify(pointer(older.release)));
        await fs.mkdir(path.join(f.hqpDirectory,'backups'));await fs.writeFile(path.join(f.hqpDirectory,'backups/saved.txt'),'keep');
        await fs.writeFile(path.join(f.profile,'hqplayer.json'),'saved DAC and DSP settings');
        const current=await f.publishHqp('0.1.4-preview.8');f.execute();
        for(const r of [old,older])expect(syncFs.existsSync(path.join(f.hqpDirectory,`${r.release.version}-${r.release.sha256.slice(0,12)}`))).toBe(false);
        expect(await fs.readFile(path.join(f.hqpDirectory,'backups/saved.txt'),'utf8')).toBe('keep');
        expect(await fs.readFile(path.join(f.profile,'hqplayer.json'),'utf8')).toBe('saved DAC and DSP settings');
        expect(JSON.parse(await fs.readFile(path.join(f.hqpDirectory,'upgrade-receipts',previous.release.sha256+'.json'),'utf8')).previous).toEqual(pointer(older.release));
        expect(await f.manager().rollback()).toMatchObject({available:true,version:previous.release.version});
        expect(syncFs.existsSync(path.join(f.hqpDirectory,`${current.release.version}-${current.release.sha256.slice(0,12)}`))).toBe(true);
    });
    it('preserves an explicitly disabled HQPlayer component',async()=>{
        const f=await fixture(),old=await f.publishHqp('0.1.4-preview.7');await f.seedHqp(old);
        await fs.rename(path.join(f.hqpDirectory,'active.json'),path.join(f.hqpDirectory,'inactive.json'));
        await f.publishHqp('0.1.4-preview.8');f.execute();
        expect(syncFs.existsSync(path.join(f.hqpDirectory,'active.json'))).toBe(false);
        expect(JSON.parse(await fs.readFile(path.join(f.hqpDirectory,'inactive.json'),'utf8'))).toEqual(pointer(old.release));
    });
});
