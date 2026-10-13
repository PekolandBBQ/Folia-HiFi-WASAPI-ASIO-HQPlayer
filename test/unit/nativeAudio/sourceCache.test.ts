import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real original-file reads cover pending download reuse, bounded retention and cleanup leases.
const { createSourceCache } = createRequire(import.meta.url)('../../../electron/nativeAudio/sourceCache.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(options = {}) {
    const cache = createSourceCache(options), directories: string[] = [];
    cleanups.push(async () => { await cache.dispose(); await Promise.all(directories.map(directory => rm(directory, { force: true, recursive: true }))); });
    async function track(index: number, completion = Promise.resolve(), size = 128) {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-native-audio-cache-test-')); directories.push(directory);
        const file = path.join(directory, 'input.audio'); await writeFile(file, Buffer.alloc(size, index));
        const input = { url: `https://cdn.invalid/${index}.flac`, trackKey: `online:netease:${index}`, directory, file,
            completion, contentType: 'audio/flac' };
        return { input, reference: cache.track(input), directory };
    }
    return { cache, track };
}
it('waits for the same pending download and publishes a reusable finite local source', async () => {
    const { cache, track } = await fixture(); let complete!: () => void;
    const { input, reference, directory } = await track(7, new Promise<void>(resolve => { complete = resolve; }));
    let settled = false; const pending = cache.read(input).then((value: any) => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false);
    complete(); const source = await pending;
    expect(source).toEqual({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\.wav$/) });
    const response = await fetch(source.url); expect(response.headers.get('content-type')).toBe('audio/flac');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(128, 7));
    expect(await cache.read(input)).toEqual(source); expect(await cache.read({ ...input, trackKey: 'wrong' })).toBeNull();
    cache.release(reference); expect((await stat(directory)).isDirectory()).toBe(true);
    await cache.dispose(); await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not publish a cancelled or truncated staging source and removes its released directory', async () => {
    const { cache, track } = await fixture(); let cancel!: () => void;
    const { input, reference, directory } = await track(1, new Promise<void>((_resolve, reject) => { cancel = () => reject(new Error('Cancelled')); }));
    const pending = cache.read(input); cache.release(reference); cancel(); expect(await pending).toBeNull();
    await vi.waitFor(async () => { await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' }); });
    const tiny = await track(2, Promise.resolve(), 10); cache.release(tiny.reference); expect(await cache.read(tiny.input)).toBeNull();
});
it('retains only three released originals and expires idle files without touching the active staging directory', async () => {
    const { cache, track } = await fixture({ maxEntries: 3, ttlMs: 100, leaseMs: 10 });
    const sources: Awaited<ReturnType<typeof track>>[] = [];
    for (let index = 1; index <= 4; index++) { const source = await track(index); await source.reference.ready; cache.release(source.reference); sources.push(source); }
    expect(await cache.read(sources[0].input)).toBeNull();
    await vi.waitFor(async () => { await expect(stat(sources[0].directory)).rejects.toMatchObject({ code: 'ENOENT' }); });
    const active = await track(5); await active.reference.ready;
    await new Promise(resolve => setTimeout(resolve, 150)); expect((await stat(active.directory)).isDirectory()).toBe(true);
    for (const source of sources.slice(1)) expect(await cache.read(source.input)).toBeNull();
});
it('keeps a returned HTTP lease readable when a same-source output handoff replaces its map entry', async () => {
    const { cache, track } = await fixture({ leaseMs: 150, ttlMs: 500 });
    const first = await track(3); const local = await cache.read(first.input); cache.release(first.reference);
    const replacement = await track(3); await replacement.reference.ready;
    expect(Buffer.from(await (await fetch(local.url)).arrayBuffer())).toEqual(Buffer.alloc(128, 3));
    await new Promise(resolve => setTimeout(resolve, 180));
    await vi.waitFor(async () => { await expect(stat(first.directory)).rejects.toMatchObject({ code: 'ENOENT' }); });
});
it.each(['download', 'publication'])('starts the returned source lease after a slow %s', async delayAt => {
    let now = Date.now(), complete!: () => void;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const handle = { url: 'http://127.0.0.1/synthetic-source', activeReaders: () => 0, retire: vi.fn(), revoke: vi.fn() };
    const media = { add: vi.fn(async () => { if (delayAt === 'publication') await pending; return handle; }), close: vi.fn() };
    try {
        const { cache, track } = await fixture({ media, leaseMs: 1000, ttlMs: 20000 });
        const first = await track(6, delayAt === 'download' ? pending : Promise.resolve());
        const reading = cache.read(first.input);
        if (delayAt === 'publication') await vi.waitFor(() => expect(media.add).toHaveBeenCalledOnce());
        now += 2000; complete();
        expect(await reading).toEqual({ url: handle.url });
        await cache.release(first.reference);
        const replacement = await track(6); await replacement.reference.ready;
        // The consumer gets a full first-request lease even when preparing the
        // original took longer than that lease. No HTTP request is needed here.
        expect(handle.retire).not.toHaveBeenCalled();
        expect(handle.revoke).not.toHaveBeenCalled();
        expect((await stat(first.directory)).isDirectory()).toBe(true);
    } finally { complete(); clock.mockRestore(); }
});
it.each(['download', 'publication'])('does not exceed the lease limit when a slow %s finishes after its reservation expires', async delayAt => {
    let now = Date.now(), complete!: () => void;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pending = new Promise<void>(resolve => { complete = resolve; });
    let firstFile: string;
    const media = { add: vi.fn(async (file: string) => {
        if (delayAt === 'publication' && file === firstFile) await pending;
        return { url: `http://127.0.0.1/${path.basename(path.dirname(file))}`, activeReaders: () => 0, retire: vi.fn(), revoke: vi.fn() };
    }), close: vi.fn() };
    try {
        const { cache, track } = await fixture({ media, maxEntries: 1, leaseMs: 1000, ttlMs: 20000 });
        const first = await track(6, delayAt === 'download' ? pending : Promise.resolve());
        firstFile = first.input.file;
        const reading = cache.read(first.input);
        if (delayAt === 'publication') await vi.waitFor(() => expect(media.add).toHaveBeenCalledOnce());
        now += 2000;
        const second = await track(7);
        expect(await cache.read(second.input)).toMatchObject({ url: expect.any(String) });
        complete();
        expect(await reading).toBeNull();
    } finally { complete(); clock.mockRestore(); }
});
it('counts retired HTTP leases against the limit during rapid same-source output handoffs', async () => {
    const { cache, track } = await fixture({ maxEntries: 3, leaseMs: 10000, ttlMs: 20000 });
    const sources: Awaited<ReturnType<typeof track>>[] = [];
    for (let index = 0; index < 4; index++) {
        const source = await track(9); sources.push(source);
        const local = await cache.read(source.input);
        if (index < 3) expect(local).toMatchObject({ url: expect.any(String) });
        else expect(local).toBeNull();
        await cache.release(source.reference);
    }
    // A source remains owned while its returned URL can still be opened, even after replacement.
    for (const source of sources.slice(0, 3)) expect((await stat(source.directory)).isDirectory()).toBe(true);
});
