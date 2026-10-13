import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real local HTTP requests exercise seeking, browser origin restrictions and active stream revocation.
const { createMediaServer } = createRequire(import.meta.url)('../../../electron/spotify/mediaServer.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(clean => clean())); });
async function fixture(size = 256) {
  const dir = await mkdtemp(path.join(tmpdir(), 'folia-media-test-'));
  const file = path.join(dir, 'audio.wav'), media = createMediaServer();
  await writeFile(file, Buffer.alloc(size, 7));
  cleanups.push(async () => { media.close(); await rm(dir, { recursive: true, force: true }); });
  return { media, handle: await media.add(file) };
}
describe('Spotify temporary audio server', () => {
  it('supports bounded ranges and HEAD without exposing files', async () => {
    const { handle } = await fixture();
    const response = await fetch(handle.url, { headers: { Range: 'bytes=40-49', Origin: 'http://localhost:3000' } });
    expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe('bytes 40-49/256');
    expect((await response.arrayBuffer()).byteLength).toBe(10);
    const head = await fetch(handle.url, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('256'); expect(await head.text()).toBe('');
    const suffix = await fetch(handle.url, { headers: { Range: 'bytes=-4' } });
    expect((await suffix.arrayBuffer()).byteLength).toBe(4);
    expect((await fetch(handle.url, { headers: { Range: 'bytes=256-' } })).status).toBe(416);
    expect((await fetch(handle.url, { headers: { Origin: 'https://example.com' } })).status).toBe(403);
    expect((await fetch(new URL('/private.wav', handle.url))).status).toBe(404);
  });
  it('revokes URLs and terminates an already open response', async () => {
    const { handle } = await fixture(16 * 1024 * 1024);
    const response = await fetch(handle.url), reader = response.body!.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    handle.revoke();
    const consume = (async () => { while (!(await reader.read()).done) { /* Drain until revocation fails the stream. */ } })();
    await expect(consume).rejects.toThrow();
    expect((await fetch(handle.url)).status).toBe(404);
  });
  it('waits at a growing file tail, then exposes true finite ranges after producer EOF', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'folia-growing-media-test-'));
    const file = path.join(dir, 'source.ogg'), media = createMediaServer();
    await writeFile(file, Buffer.from('early-prefix'));
    cleanups.push(async () => { media.close(); await rm(dir, { recursive: true, force: true }); });
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    const handle = await media.addGrowing(file, { completion, contentType: 'audio/ogg' });
    const response = await fetch(handle.url);
    expect(response.headers.get('content-length')).toBeNull(); expect(response.headers.get('accept-ranges')).toBe('none');
    expect(response.headers.get('content-type')).toBe('audio/ogg');
    const reader = response.body!.getReader(), first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe('early-prefix');
    let tailSettled = false; const next = reader.read().then(value => { tailSettled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100)); expect(tailSettled).toBe(false);
    await appendFile(file, Buffer.from('-later-tail')); complete(); await handle.completed;
    const tail = await next; expect(Buffer.from(tail.value!).toString()).toBe('-later-tail');
    expect((await reader.read()).done).toBe(true);
    const head = await fetch(handle.url, { method: 'HEAD' }); expect(head.headers.get('content-length')).toBe('23');
    const range = await fetch(handle.url, { headers: { Range: 'bytes=12-22' } });
    expect(range.status).toBe(206); expect(await range.text()).toBe('-later-tail');
  });
  it('destroys growing readers and revokes the source on a late producer failure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'folia-growing-error-test-'));
    const file = path.join(dir, 'source.ogg'), media = createMediaServer(); await writeFile(file, Buffer.from('prefix'));
    cleanups.push(async () => { media.close(); await rm(dir, { recursive: true, force: true }); });
    let fail!: (error: Error) => void;
    const completion = new Promise<void>((_, reject) => { fail = reject; });
    const handle = await media.addGrowing(file, { completion });
    const response = await fetch(handle.url), reader = response.body!.getReader(); await reader.read();
    const waiting = reader.read(); fail(new Error('upstream-failed'));
    await expect(waiting).rejects.toThrow(); expect((await fetch(handle.url)).status).toBe(404);
    await expect(handle.completed).rejects.toThrow('upstream-failed');
  });
  it('releases the former browser reader independently and terminates the native reader on logout clear', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'folia-growing-handoff-test-'));
    const file = path.join(dir, 'source.ogg'), media = createMediaServer(); await writeFile(file, Buffer.from('prefix'));
    cleanups.push(async () => { media.close(); await rm(dir, { recursive: true, force: true }); });
    const handle = await media.addGrowing(file, { completion: new Promise<void>(() => {}) });
    const browserAbort = new AbortController();
    const browser = (await fetch(handle.url, { signal: browserAbort.signal })).body!.getReader();
    const native = (await fetch(handle.url)).body!.getReader();
    await browser.read(); await native.read(); expect(handle.activeReaders()).toBe(2);
    browserAbort.abort(); await vi.waitFor(() => expect(handle.activeReaders()).toBe(1));
    await appendFile(file, Buffer.from('-native')); expect(Buffer.from((await native.read()).value!).toString()).toBe('-native');
    const tail = native.read(); media.clear(); await expect(tail).rejects.toThrow();
    await vi.waitFor(() => expect(handle.activeReaders()).toBe(0)); expect((await fetch(handle.url)).status).toBe(404);
  });
});
