import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';

// test/unit/onlineMusic/spotifySoloistPcmProxy.test.ts: real HTTP exercises the prepared PCM transport.
const { createSoloistPcmProxy } = createRequire(import.meta.url)('../../../electron/spotify/soloistPcmProxy.cjs');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
function proxy() {
    const media = createSoloistPcmProxy();
    cleanup.push(() => media.close());
    return media;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
async function* finite(...buffers: Buffer[]) { yield* buffers; }

describe('Soloist one-reader PCM proxy', () => {
    it('does not open on HEAD, OPTIONS, nonzero range or untrusted origin; emits exact prepared WAV on first GET', async () => {
        const media = proxy(), close = vi.fn(), pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
        const open = vi.fn(async () => finite(pcm));
        const handle = await media.add({ open, close });
        const head = await fetch(handle.url, { method: 'HEAD' });
        expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBeNull();
        expect(head.headers.get('content-type')).toBe('audio/wav');
        expect((await fetch(handle.url, { method: 'OPTIONS' })).status).toBe(204);
        for (const range of ['bytes=1-', 'bytes=-8', 'bytes=0-1,4-5', 'garbage'])
            expect((await fetch(handle.url, { headers: { Range: range } })).status).toBe(416);
        expect((await fetch(handle.url, { headers: { Origin: 'https://example.com' } })).status).toBe(403);
        expect(open).not.toHaveBeenCalled();
        const response = await fetch(handle.url, { headers: { Range: 'bytes=0-15' } });
        expect(response.status).toBe(200); expect(response.headers.get('accept-ranges')).toBe('none');
        expect(response.headers.get('content-length')).toBeNull(); expect(response.headers.get('cache-control')).toBe('no-store');
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.subarray(0, 4).toString()).toBe('RIFF'); expect(bytes.readUInt32LE(4)).toBe(0xffffffff);
        expect(bytes.subarray(8, 16).toString()).toBe('WAVEfmt ');
        expect(bytes.readUInt16LE(20)).toBe(1); expect(bytes.readUInt16LE(22)).toBe(2);
        expect(bytes.readUInt32LE(24)).toBe(44100); expect(bytes.readUInt16LE(34)).toBe(32);
        expect(bytes.readUInt32LE(40)).toBe(0xffffffff); expect(bytes.subarray(44)).toEqual(pcm);
        expect(open).toHaveBeenCalledTimes(1); expect(handle.activeReaders()).toBe(0);
        await expect(handle.completed).resolves.toEqual({ natural: true, bytes: 8 });
        expect(close).not.toHaveBeenCalled();
        await handle.revoke(); expect(close).toHaveBeenCalledTimes(1);
        expect((await fetch(handle.url)).status).toBe(404);
    });

    it('reserves the reader before asynchronous open and rejects a concurrent reader without another source start', async () => {
        const media = proxy(), gate = deferred<AsyncIterable<Buffer>>(), close = vi.fn();
        const open = vi.fn(() => gate.promise);
        const handle = await media.add({ open, close });
        const first = fetch(handle.url);
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
        expect(handle.activeReaders()).toBe(1);
        expect((await fetch(handle.url)).status).toBe(409);
        gate.resolve(finite(Buffer.alloc(8, 4)));
        expect((await (await first).arrayBuffer()).byteLength).toBe(52);
        expect((await fetch(handle.url)).status).toBe(409);
        expect(close).not.toHaveBeenCalled();
    });

    it('waits between chunks without synthesizing EOF and copies buffers that the producer reuses', async () => {
        const media = proxy(), gate = deferred<void>(), close = vi.fn();
        async function* produce() {
            const scratch = Buffer.alloc(8, 1);
            yield scratch;
            await gate.promise;
            scratch.fill(2); yield scratch;
        }
        const handle = await media.add({ open: async () => produce(), close });
        const response = await fetch(handle.url), reader = response.body!.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size < 52) { const next = await reader.read(); chunks.push(next.value!); size += next.value!.length; }
        let settled = false;
        const tail = reader.read().then(value => { settled = true; return value; });
        await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false);
        expect(handle.activeReaders()).toBe(1);
        gate.resolve(); chunks.push((await tail).value!);
        expect((await reader.read()).done).toBe(true);
        const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
        expect(bytes.subarray(44)).toEqual(Buffer.concat([Buffer.alloc(8, 1), Buffer.alloc(8, 2)]));
        await expect(handle.completed).resolves.toEqual({ natural: true, bytes: 16 });
        expect(close).not.toHaveBeenCalled();
    });

    it('revokes an active reader, aborts its producer and rejects completion instead of reporting natural EOF', async () => {
        const media = proxy(), close = vi.fn();
        let producerSignal!: AbortSignal;
        const handle = await media.add({ open: async ({ signal }: { signal: AbortSignal }) => {
            producerSignal = signal;
            return (async function* () {
                yield Buffer.alloc(8);
                await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            })();
        }, close });
        const response = await fetch(handle.url), reader = response.body!.getReader(); await reader.read();
        const tail = reader.read(); const ended = expect(handle.completed).rejects.toMatchObject({ code: 'SOLOIST_PCM_REVOKED' });
        await handle.revoke();
        expect(producerSignal.aborted).toBe(true); expect(handle.activeReaders()).toBe(0);
        await expect(tail).rejects.toThrow(); await ended;
        expect(close).toHaveBeenCalledTimes(1); await handle.revoke(); expect(close).toHaveBeenCalledTimes(1);
        expect((await fetch(handle.url)).status).toBe(404);
    });

    it('cancels a late open without sending PCM or reopening a revoked source', async () => {
        const media = proxy(), gate = deferred<AsyncIterable<Buffer>>(), close = vi.fn();
        const open = vi.fn(() => gate.promise), handle = await media.add({ open, close });
        const request = fetch(handle.url).catch(() => null);
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
        await handle.revoke(); gate.resolve(finite(Buffer.alloc(8)));
        expect(await request).toBeNull(); expect(close).toHaveBeenCalledTimes(1);
        await expect(handle.completed).rejects.toMatchObject({ code: 'SOLOIST_PCM_REVOKED' });
        expect((await fetch(handle.url)).status).toBe(404);
    });

    it('rejects producer failures and invalid PCM tails without leaking their message or completing a song', async () => {
        const media = proxy(), close = vi.fn();
        const failed = await media.add({ open: async () => { throw new Error('private-upstream-message'); }, close });
        const response = await fetch(failed.url);
        expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-upstream-message');
        await expect(failed.completed).rejects.toMatchObject({ code: 'SOLOIST_PCM_SOURCE_FAILED' });
        expect((await fetch(failed.url)).status).toBe(404);
        const tail = await media.add({ open: async () => finite(Buffer.alloc(3)), close });
        const invalid = fetch(tail.url).then(response => response.arrayBuffer());
        await expect(invalid).rejects.toThrow();
        await expect(tail.completed).rejects.toMatchObject({ code: 'SOLOIST_PCM_SOURCE_FAILED' });
    });

    it('applies real socket backpressure rather than draining a paused reader into memory', async () => {
        const media = proxy(), close = vi.fn();
        let pulled = 0, signal!: AbortSignal;
        const total = 4096;
        const handle = await media.add({ open: async (options: { signal: AbortSignal }) => {
            signal = options.signal;
            return (async function* () { for (; pulled < total; pulled++) yield Buffer.alloc(65536, 7); })();
        }, close });
        const request = http.get(handle.url);
        const [response] = await once(request, 'response') as [http.IncomingMessage];
        response.pause();
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(pulled).toBeLessThan(total); expect(handle.activeReaders()).toBe(1);
        response.destroy(); request.destroy();
        await vi.waitFor(() => expect(signal.aborted).toBe(true));
        await expect(handle.completed).rejects.toMatchObject({ code: 'SOLOIST_PCM_REVOKED' });
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    });

    it('shutdown closes pending and unread sources and refuses future additions', async () => {
        const media = proxy(), close = vi.fn();
        const handle = await media.add({ open: async () => finite(Buffer.alloc(8)), close });
        await media.close(); expect(close).toHaveBeenCalledTimes(1);
        await expect(handle.completed).rejects.toMatchObject({ code: 'SOLOIST_PCM_REVOKED' });
        await expect(media.add({ open: async () => finite(), close })).rejects.toMatchObject({ code: 'SOLOIST_PCM_PROXY_CLOSED' });
        await expect(fetch(handle.url)).rejects.toThrow();
    });
});
