import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

// Independent Spotify activation must reject corrupt/incompatible archives without affecting other outputs.
const { createSpotifyComponentManager } = createRequire(import.meta.url)('../../../electron/spotify/componentManager.cjs');
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-spotify-component-')); folders.push(directory);
  const executable = strToU8('fixture executable');
  const bytes = zipSync({ 'folia-spotify-playback.exe': executable, 'component.json': strToU8(JSON.stringify({
    id: 'spotify', entry: 'folia-spotify-playback.exe', version: '0.1.0', protocolMajor: 1 })) });
  const localPath = path.join(directory, 'candidate.zip'), catalogPath = path.join(directory, 'catalog.json');
  await writeFile(localPath, bytes);
  const release = { version: '0.1.0', platform: 'win32-x64', protocolMajor: 1, sha256: digest(bytes), entrySha256: digest(executable), localPath };
  await writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [release] }));
  const verifyStaged = vi.fn(async () => {});
  const manager = createSpotifyComponentManager({ app: { isPackaged: false, getPath: () => directory }, catalogPath, verifyStaged });
  return { manager, directory, localPath, verifyStaged };
}
describe('Spotify component installation', () => {
  it('validates before activation, detects tampering and supports disable/reinstall', async () => {
    const f = await fixture(); expect((await f.manager.status()).available).toBe(false);
    const installed = await f.manager.install(); expect(installed.available).toBe(true);
    expect(installed.executable).toContain(path.join('components', 'spotify'));
    expect(f.verifyStaged).toHaveBeenCalledOnce();
    const original = await readFile(installed.executable);
    await writeFile(installed.executable, 'tampered');
    expect(await f.manager.status()).toMatchObject({ available: false, errorCode: 'COMPONENT_INTEGRITY' });
    await writeFile(installed.executable, original);
    expect((await f.manager.uninstall()).available).toBe(false);
    expect((await f.manager.install()).available).toBe(true);
  });
  it('leaves no active pointer on handshake failure', async () => {
    const f = await fixture(); f.verifyStaged.mockRejectedValue(new Error('native-incompatible'));
    await expect(f.manager.install()).rejects.toThrow('native-incompatible');
    expect(await f.manager.status()).toMatchObject({ installed: false, available: false, busy: false });
  });
  it('rejects a changed archive before executing it', async () => {
    const f = await fixture(); await writeFile(f.localPath, 'corrupt');
    await expect(f.manager.install()).rejects.toThrow('checksum mismatch');
    expect(f.verifyStaged).not.toHaveBeenCalled();
  });
});
