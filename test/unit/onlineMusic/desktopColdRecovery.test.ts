import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Historical receipts remain evidence; inspection never controls Spotify or deletes the file.
const { createDesktopPlaybackControl } = createRequire(import.meta.url)('../../../electron/spotify/desktopPlaybackControl.cjs');
const receipt = { version: 2, session: '12345678-1234-1234-1234-123456789abc', deviceId: 'saved-desktop',
    trackId: '3n3Ppam7vgaVa1iaRUc9Lp', originalVolume: 73, baselineEmpty: false, targetActive: true,
    volumeOnly: true, volumeRequestPending: false, playbackRequestPending: false };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(contents?: string) {
    const directory = await mkdtemp(join(tmpdir(), 'folia-history-')), filename = join(directory, 'cold-volume-recovery.json');
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    if (contents !== undefined) await writeFile(filename, contents);
    const fetcher = vi.fn(async () => { throw new Error('History must not query Spotify'); });
    const vault = { token: vi.fn(), stamp: () => ({ epoch: 5, revision: 17 }), grantedScopes: vi.fn() };
    const control = createDesktopPlaybackControl({ coldBootstrapDirectory: directory, vault, fetcher,
        cooldown: { load: async () => 0, defer: async () => 0 } });
    cleanup.push(() => control.dispose()); return { control, filename, fetcher, vault };
}
it('reports no history without creating a file or reading account state', async () => {
    const f = await fixture();
    expect(await f.control.checkColdRecovery()).toMatchObject({ required: false, recoverable: false, archived: false, sourceControlUnconfirmed: false });
    await expect(readFile(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.vault.token).not.toHaveBeenCalled();
});
it.each([0, 73, 100])('retains historical volume %s byte-for-byte without automatic restoration', async originalVolume => {
    const bytes = JSON.stringify({ ...receipt, originalVolume }, null, 2), f = await fixture(bytes);
    expect(await f.control.inspectColdRecovery()).toMatchObject({ archived: true, required: false, recoverable: false, sourceControlUnconfirmed: false });
    expect(await f.control.checkColdRecovery({ deviceId: 'another-device' })).toMatchObject({ archived: true, required: false });
    expect(await readFile(f.filename, 'utf8')).toBe(bytes);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.vault.token).not.toHaveBeenCalled();
    expect(await f.control.hasOwnedColdRecovery()).toBe(false);
});
it('does not confuse a pending volume write with a pending playback write', async () => {
    const f = await fixture(JSON.stringify({ ...receipt, volumeRequestPending: true }));
    expect(await f.control.inspectLegacyPreparation()).toMatchObject({ historicalVolumeRecord: true, sourceControlUnconfirmed: false });
    expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([true, undefined])('retains unknown playback completion %s as a separate gate', async playbackRequestPending => {
    const bytes = JSON.stringify({ ...receipt, playbackRequestPending }), f = await fixture(bytes);
    expect(await f.control.checkColdRecovery()).toMatchObject({ required: false, recoverable: false, sourceControlUnconfirmed: true });
    expect(await readFile(f.filename, 'utf8')).toBe(bytes); expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(['{malformed', 'null', JSON.stringify({ ...receipt, version: 1 }), JSON.stringify({ ...receipt, originalVolume: 101 })])(
    'preserves invalid or legacy history without acting: %s', async bytes => {
        const f = await fixture(bytes);
        expect(await f.control.inspectLegacyPreparation()).toMatchObject({ sourceControlUnconfirmed: true });
        expect(await readFile(f.filename, 'utf8')).toBe(bytes); expect(f.fetcher).not.toHaveBeenCalled();
    });
