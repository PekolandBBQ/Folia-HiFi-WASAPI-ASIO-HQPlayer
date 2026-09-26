import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

// test/unit/nativeAudio/componentManager.test.ts — activation integrity and failed update rollback.
const { createComponentManager } = createRequire(import.meta.url)('../../../electron/nativeAudio/componentManager.cjs');
const { assertCompatibleCatalog } = createRequire(import.meta.url)('../../../electron/nativeAudio/componentVersions.cjs');
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'folia-component-test-')); directories.push(directory);
    const archive = path.join(directory, 'component.zip'), catalogPath = path.join(directory, 'catalog.json');
    const exe = strToU8('test executable');
    const zip = zipSync({ 'folia-audio.exe': exe, 'component.json': strToU8(JSON.stringify({ version: '0.1.0', protocolMajor: 1 })) });
    const sha256 = createHash('sha256').update(zip).digest('hex');
    await writeFile(archive, zip);
    const release = { version: '0.1.0', protocolMajor: 1, platform: 'win32-x64', sha256, localPath: archive };
    const catalog = async (entry = release) => writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [entry] }));
    await catalog();
    const app = { isPackaged: false, getPath: () => directory };
    return { manager: createComponentManager({ app, catalogPath }), directory, archive, catalog, release, catalogPath, app };
}
describe('optional component activation', () => {
    it('allows deactivation before first install and repeated deactivation', async () => {
        const { manager } = await fixture();
        expect((await manager.uninstall()).installed).toBe(false);
        expect((await manager.uninstall()).installed).toBe(false);
    });
    it('rejects dropping an approved compatible version from a later catalog', async () => {
        const { release } = await fixture();
        const old = { releases: [release] };
        expect(() => assertCompatibleCatalog(old, { releases: [] })).toThrow('Keep compatible');
        expect(() => assertCompatibleCatalog(old, { releases: [{ ...release, sha256: 'a'.repeat(64) }] })).toThrow();
        expect(() => assertCompatibleCatalog(old, { releases: [{ ...release, version: '0.1.1' }, release] })).not.toThrow();
    });
    it('retains compatible releases, prunes to two installed versions and can roll back', async () => {
        const { manager, directory, catalogPath, release } = await fixture();
        await manager.install();
        const releases = [release];
        for (const version of ['0.1.1', '0.1.2']) {
            const zip = zipSync({ 'folia-audio.exe': strToU8(version), 'component.json': strToU8(JSON.stringify({ version, protocolMajor: 1 })) });
            const localPath = path.join(directory, `${version}.zip`);
            await writeFile(localPath, zip);
            releases.unshift({ ...release, version, localPath, sha256: createHash('sha256').update(zip).digest('hex') });
            await writeFile(catalogPath, JSON.stringify({ schema: 1, releases }));
            expect((await manager.status()).available).toBe(true);
            expect((await manager.status()).updateAvailable).toBe(true);
            await manager.install();
        }
        const root = path.join(directory, 'components/native-audio');
        expect((await readdir(root)).filter(name => /^0\.1\./.test(name))).toHaveLength(2);
        expect((await manager.rollback()).version).toBe('0.1.1');
        await manager.uninstall();
        expect((await readdir(root)).filter(name => /^0\.1\./.test(name))).toHaveLength(2);
    });
    it('installs a pinned archive, detects tampering, and supports deactivation', async () => {
        const { manager } = await fixture();
        expect((await manager.status()).available).toBe(false);
        const state = await manager.install();
        expect(state.available).toBe(true);
        await writeFile(state.executable, 'tampered');
        expect((await manager.status()).available).toBe(false);
        await manager.uninstall();
        expect((await manager.status()).installed).toBe(false);
    });
    it('preserves the installed version when an update checksum fails', async () => {
        const { manager, archive, directory } = await fixture();
        await manager.install();
        const pointer = path.join(directory, 'components/native-audio/active.json');
        const before = await readFile(pointer, 'utf8');
        await writeFile(archive, 'bad download');
        await expect(manager.install()).rejects.toThrow('checksum');
        expect(await readFile(pointer, 'utf8')).toBe(before);
        expect((await manager.status()).available).toBe(true);
    });
    it('rejects unrecognized protocol and zip traversal before activating anything', async () => {
        const { manager, archive, catalog, release } = await fixture();
        const badZip = zipSync({ '../folia-audio.exe': strToU8('bad') });
        await writeFile(archive, badZip);
        await catalog({ ...release, sha256: createHash('sha256').update(badZip).digest('hex') });
        await expect(manager.install()).rejects.toThrow('path');
        await catalog({ ...release, protocolMajor: 2 });
        await expect(manager.install()).rejects.toThrow('manifest');
    });
    it('does not accept local development archives in a packaged application', async () => {
        const { app, catalogPath } = await fixture();
        const manager = createComponentManager({ app: { ...app, isPackaged: true }, catalogPath });
        await expect(manager.install()).rejects.toThrow('HTTPS');
    });
});
