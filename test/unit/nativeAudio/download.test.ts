import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/download.test.ts — network body integrity and rejected responses.
const { downloadRemoteAudio, MAX_REMOTE_AUDIO_BYTES } = createRequire(import.meta.url)('../../../electron/nativeAudio/download.cjs');
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function destination() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-download-test-'));
    directories.push(directory);
    return path.join(directory, 'source.audio');
}
it('writes all chunks without depending on an extension or MIME type', async () => {
    const file = await destination();
    const stream = new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close();
    } });
    await downloadRemoteAudio('https://example.com/opaque', file, new AbortController().signal, async () => new Response(stream));
    expect([...await readFile(file)]).toEqual([1, 2, 3, 4]);
});
it('rejects HTTP failures, empty files, oversized responses and interrupted bodies', async () => {
    for (const response of [new Response('denied', { status: 403 }), new Response(''),
        new Response('too big', { headers: { 'content-length': String(MAX_REMOTE_AUDIO_BYTES + 1) } }),
        new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection interrupted')); } }))]) {
        await expect(downloadRemoteAudio('https://example.com/song', await destination(), new AbortController().signal, async () => response)).rejects.toThrow();
    }
});
it('preserves the Electron session and distinguishes expiry, network failure and cancellation', async () => {
    const file = await destination();
    const controller = new AbortController();
    await expect(downloadRemoteAudio('https://example.com/song', file, controller.signal, async (_url: string, options: RequestInit) => {
        expect(options.credentials).toBe('include');
        return new Response('', { status: 403 });
    })).rejects.toMatchObject({ code: 'SOURCE_EXPIRED' });
    await expect(downloadRemoteAudio('https://example.com/song', file, controller.signal, async () => { throw new TypeError('fetch failed'); })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    controller.abort();
    await expect(downloadRemoteAudio('https://example.com/song', file, controller.signal, async () => { throw new Error('aborted'); })).rejects.toMatchObject({ code: 'CANCELLED' });
});
