import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/hqplayerDiscovery.test.ts — discovery fixtures do not imply playback validation of older versions.
const { discoverHQPlayers, createExecutablePreference, validExecutable } = createRequire(import.meta.url)('../../../electron/nativeAudio/hqplayerDiscovery.cjs');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'folia-hqp-discovery-')); roots.push(root);
    const paths: string[] = [];
    for (const version of [4, 5, 6]) {
        const directory = path.join(root, 'Signalyst', `HQPlayer ${version} Desktop`); await mkdir(directory, { recursive: true });
        const executable = path.join(directory, `HQPlayer${version}Desktop.exe`); await writeFile(executable, 'fixture'); paths.push(executable);
    }
    return { root, paths };
}
describe('HQPlayer Desktop program discovery', () => {
    it('finds multiple versions, de-duplicates shortcut targets and prefers the highest numbered version', async () => {
        const { root, paths } = await fixture();
        const exec = vi.fn(async () => ({ stdout: paths[0] + '\r\n' + paths[2] + '\r\nC:\\unrelated.exe\r\n' }));
        expect(await discoverHQPlayers({ roots: [root], exec })).toEqual([paths[2], paths[1], paths[0]]);
    });
    it('persists a manually selected older version and supports resetting to automatic discovery', async () => {
        const { root, paths } = await fixture(); const config = path.join(root, 'hqplayer.json');
        const preference = createExecutablePreference(config);
        expect(await preference.read()).toBeNull(); await preference.set(paths[0]);
        expect(await createExecutablePreference(config).read()).toBe(paths[0]);
        await preference.set(null); expect(await createExecutablePreference(config).read()).toBeNull();
    });
    it('rejects missing, unrelated and network executables without replacing the working selection', async () => {
        const { root, paths } = await fixture(); const preference = createExecutablePreference(path.join(root, 'hqplayer.json'));
        await preference.set(paths[2]);
        for (const value of [path.join(root, 'missing.exe'), path.join(root, 'HQPlayer7Desktop.exe'), '\\\\server\\HQPlayer6Desktop.exe', 'https://example.com/HQPlayer6Desktop.exe']) {
            expect(await validExecutable(value)).toBeFalsy();
            await expect(preference.set(value)).rejects.toMatchObject({ code: 'HQPLAYER_PATH_INVALID' });
            expect(await preference.read()).toBe(paths[2]);
        }
    });
});
