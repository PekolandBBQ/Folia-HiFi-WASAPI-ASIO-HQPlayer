import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// Crash cleanup is constrained by process ownership, file names and the filesystem link boundary.
const { sweepTemporaryAudio, closeTemporaryAudioDirectory } = createRequire(import.meta.url)('../../../electron/spotify/temporaryAudio.cjs');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(pid = 42) {
  const root = await mkdtemp(path.join(tmpdir(), 'folia-orphan-test-')); roots.push(root);
  const folder = path.join(root, 'playback-ABC123'); await mkdir(folder);
  await writeFile(path.join(folder, 'owner.json'), JSON.stringify({ format: 1, pid }));
  await writeFile(path.join(folder, `${randomUUID()}.wav`), 'temporary PCM'); return { root, folder };
}
describe('Spotify crash cleanup', () => {
  it('retains the owner marker when a file could not be cleaned on close', async () => {
    const { root, folder } = await fixture();
    await closeTemporaryAudioDirectory(folder);
    expect(await readdir(folder)).toContain('owner.json');
    await sweepTemporaryAudio(root, { alive: () => false });
    expect(await readdir(root)).toEqual([]);
  });
  it('reclaims dead sessions but preserves live sessions', async () => {
    const { root, folder } = await fixture();
    await sweepTemporaryAudio(root, { alive: () => true }); expect(await readdir(folder)).toHaveLength(2);
    await sweepTemporaryAudio(root, { alive: () => false }); expect(await readdir(root)).toEqual([]);
  });
  it('does not remove unexpected files or traverse linked workspaces', async () => {
    const { root, folder } = await fixture();
    await writeFile(path.join(folder, 'keep.txt'), 'unrelated');
    const external = await mkdtemp(path.join(tmpdir(), 'folia-external-test-')); roots.push(external);
    await writeFile(path.join(external, 'owner.json'), JSON.stringify({ format: 1, pid: 42 }));
    const audio = `${randomUUID()}.wav`; await writeFile(path.join(external, audio), 'must stay');
    await symlink(external, path.join(root, 'playback-DEF456'), process.platform === 'win32' ? 'junction' : 'dir');
    await sweepTemporaryAudio(root, { alive: () => false });
    expect(await readdir(folder)).toEqual(['keep.txt']); expect(await readdir(external)).toContain(audio);
  });
  it('preserves recent legacy folders and malformed ownership', async () => {
    const { root, folder } = await fixture(); await writeFile(path.join(folder, 'owner.json'), '{invalid');
    await sweepTemporaryAudio(root, { alive: () => false }); expect(await readdir(folder)).toHaveLength(2);
    await rm(path.join(folder, 'owner.json')); await sweepTemporaryAudio(root, { alive: () => false }); expect(await readdir(folder)).toHaveLength(1);
  });
});
