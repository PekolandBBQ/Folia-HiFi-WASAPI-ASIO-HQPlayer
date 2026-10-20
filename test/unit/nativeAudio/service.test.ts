import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/service.test.ts — file lifetime, caller validation and load cancellation.
const { registerNativeAudio } = createRequire(import.meta.url)('../../../electron/nativeAudio/service.cjs');
const filesystem = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(decode: (exe: string, input: string, directory: string, signal: AbortSignal) => Promise<unknown>
    = vi.fn(async (_exe, input) => input), download?: (...args: any[]) => Promise<unknown>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-native-service-test-'));
    const app = Object.assign(new EventEmitter(), { isPackaged: false, getAppPath: () => directory, getPath: () => directory });
    const frame = {};
    const sender = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const event = { sender, senderFrame: frame };
    const helper = { request: vi.fn(async request => (request.action === 'hello' ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry'] } : { session: request.session, duration: 4 })), dispose: vi.fn() };
    // Only snapshot the controller platform gate; drivers/processes/decoder remain injected fakes.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    let service: any;
    try { service = registerNativeAudio({ app, ipcMain: { handle: vi.fn() }, isTrustedSender: (value: unknown) => value === sender,
        componentManager: { status: async () => ({ available: true, executable: 'test.exe' }) }, decoderResolver: async () => 'ffmpeg.exe', helperFactory: () => helper, decode, download }); }
    finally { Object.defineProperty(process, 'platform', platform); }
    cleanups.push(async () => {
        app.emit('before-quit');
        // Quit cleanup removes cached originals asynchronously; a fixed delay races it on Windows.
        await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]), { timeout: 3500 });
        await rm(directory, { recursive: true, force: true });
    });
    const request = (payload: Record<string, unknown>) => service.handle(event, payload);
    const begin = (session: string) => request({ action: 'begin', session, backend: 'asio', deviceId: 'driver' });
    return { request, begin, service, event, helper, directory, app };
}

describe('native service with portable fake output boundaries', () => {
    it('holds real application quit until native cleanup finishes and handles repeated quit requests once', async () => {
        const { begin, request, app, directory } = await fixture();
        const quit = vi.fn(); Object.assign(app, { quit });
        await begin('quitting');
        const first = { preventDefault: vi.fn() }, second = { preventDefault: vi.fn() };
        app.emit('before-quit', first); app.emit('before-quit', second);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(second.preventDefault).toHaveBeenCalledOnce();
        expect(quit).not.toHaveBeenCalled();
        await expect(request({ action: 'begin', session: 'late', backend: 'asio', deviceId: 'driver' })).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
        expect(await readdir(directory)).toEqual([]);
        const final = { preventDefault: vi.fn() }; app.emit('before-quit', final);
        expect(final.preventDefault).not.toHaveBeenCalled();
        expect(quit).toHaveBeenCalledOnce();
    });
    it('exits at the cleanup deadline even when resource creation hangs, and still handles late cleanup', async () => {
        const { begin, app, directory } = await fixture();
        const quit = vi.fn(); Object.assign(app, { quit });
        const originalCreate = filesystem.mkdtemp; let complete!: () => void;
        const create = vi.spyOn(filesystem, 'mkdtemp').mockImplementation(prefix => new Promise(resolve => {
            complete = () => { void originalCreate(prefix).then(resolve); };
        }));
        const rejected = expect(begin('quit-deadline')).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        vi.useFakeTimers();
        try {
            app.emit('before-quit', { preventDefault: vi.fn() });
            await vi.advanceTimersByTimeAsync(2499); expect(quit).not.toHaveBeenCalled();
            app.emit('before-quit', { preventDefault: vi.fn() });
            await vi.advanceTimersByTimeAsync(1); expect(quit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(500); expect(quit).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
        // Keep the fake app alive long enough to verify late completion is still cleaned.
        complete(); await rejected;
        await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
        expect(quit).toHaveBeenCalledOnce();
    });
    it('cleans a staging directory whose creation finishes after application shutdown', async () => {
        const { begin, app, directory } = await fixture();
        const originalCreate = filesystem.mkdtemp;
        let complete!: () => void;
        const create = vi.spyOn(filesystem, 'mkdtemp').mockImplementation(prefix => new Promise(resolve => {
            complete = () => { void originalCreate(prefix).then(resolve); };
        }));
        const rejected = expect(begin('shutdown')).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        app.emit('before-quit');
        await new Promise(resolve => setTimeout(resolve, 20));
        complete(); await rejected;
        await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
    });
    it('does not tear down a ready session when device enumeration fails', async () => {
        const { request, begin, helper } = await fixture();
        await begin('playing'); await request({ action: 'finish', session: 'playing' });
        helper.request.mockRejectedValueOnce(Object.assign(new Error('DEVICE_UNAVAILABLE'), { code: 'DEVICE_UNAVAILABLE' }));
        await expect(request({ action: 'devices' })).rejects.toMatchObject({ code: 'DEVICE_UNAVAILABLE' });
        expect(helper.dispose).not.toHaveBeenCalled();
        await request({ action: 'play', session: 'playing' });
        expect(helper.request.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'play', session: 'playing' });
    });
    it('rejects unrelated renderers, subframes and non-local sources', async () => {
        const { service, event, request } = await fixture();
        await expect(service.handle({ ...event, sender: {} }, { action: 'devices' })).rejects.toThrow('Untrusted');
        await expect(service.handle({ ...event, senderFrame: {} }, { action: 'devices' })).rejects.toThrow('Untrusted');
        await expect(request({ action: 'begin', session: 'a', backend: 'asio', deviceId: 'driver', path: 'https://example.com/a' })).rejects.toThrow('local');
        await expect(request({ action: 'begin', session: '../escape', backend: 'asio', deviceId: 'driver' })).rejects.toThrow('session');
    });
    it('stages bounded chunks and removes the temporary file after releasing the driver', async () => {
        const { request, begin, directory, helper } = await fixture();
        await begin('first');
        await request({ action: 'chunk', session: 'first', data: new Uint8Array([1, 2, 3]) });
        await request({ action: 'finish', session: 'first' });
        expect(helper.request.mock.calls.some(([value]) => value.action === 'load')).toBe(true);
        await expect(request({ action: 'volume', session: 'first', volume: NaN })).rejects.toThrow('volume');
        await request({ action: 'replaygain', session: 'first', gain: 0.5 });
        expect(helper.request.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'replaygain', gain: 0.5 });
        expect(helper.dispose).not.toHaveBeenCalled();
        await expect(request({ action: 'seek', session: 'first', position: -1 })).rejects.toThrow('seek');
        await request({ action: 'stop', session: 'first' });
        expect(await readdir(directory)).toEqual([]);
        expect(helper.request.mock.calls.at(-1)?.[0].action).toBe('stop');
    });
    it('cancels an old decoder before a new song can claim the helper', async () => {
        const decode = vi.fn((_exe, input, _directory, signal) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }));
        const { request, begin, helper } = await fixture(decode);
        await begin('first');
        const first = request({ action: 'finish', session: 'first' });
        const rejected = expect(first).rejects.toThrow('cancelled');
        await begin('second'); await rejected;
        expect(helper.request.mock.calls.some(([value]) => value.action === 'load')).toBe(false);
        await expect(request({ action: 'play', session: 'first' })).rejects.toThrow('Stale');
    });
    it('rejects duplicate finishes, oversized chunks and unsupported actions', async () => {
        const { request, begin } = await fixture();
        await begin('first');
        await expect(request({ action: 'chunk', session: 'first', data: new Uint8Array(1024 * 1024 + 1) })).rejects.toThrow('upload');
        await request({ action: 'finish', session: 'first' });
        await expect(request({ action: 'finish', session: 'first' })).rejects.toThrow('already');
        await expect(request({ action: 'shell', session: 'first' })).rejects.toThrow('ready');
    });
    it('waits for the entire remote source before decode/load and rejects early play', async () => {
        let complete!: () => void;
        const download = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
        const decode = vi.fn(async (_exe, input) => input);
        const { request, helper } = await fixture(decode, download);
        await request({ action: 'begin', session: 'online', backend: 'asio', deviceId: 'driver', url: 'https://example.com/audio?quality=hires' });
        const finish = request({ action: 'finish', session: 'online' });
        await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
        expect((download.mock.calls as unknown[][])[0]?.[0]).toBe('https://example.com/audio?quality=hires');
        expect(decode).not.toHaveBeenCalled();
        await expect(request({ action: 'play', session: 'online' })).rejects.toThrow('not ready');
        complete(); await finish;
        expect(decode).toHaveBeenCalledOnce();
        expect(helper.request.mock.calls.some(([value]) => value.action === 'load')).toBe(true);
    });
    it('cancels a download on next song and never loads its incomplete file', async () => {
        const download = vi.fn((_url, _destination, signal) => new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('download cancelled')), { once: true });
        }));
        const decode = vi.fn(async (_exe, input) => input);
        const { request, begin, directory } = await fixture(decode, download);
        await request({ action: 'begin', session: 'online', backend: 'asio', deviceId: 'driver', url: 'https://example.com/audio' });
        const rejected = expect(request({ action: 'finish', session: 'online' })).rejects.toThrow('download cancelled');
        await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
        await begin('next'); await rejected;
        expect(decode).not.toHaveBeenCalled();
        await request({ action: 'stop', session: 'next' });
        expect(await readdir(directory)).toEqual([]);
    });
    it('rejects unsafe or ambiguous remote sources before creating a session', async () => {
        const { request, directory } = await fixture();
        for (const source of [{ url: 'file:///C:/secret' }, { url: 'https://user:password@example.com/song' },
            { url: 'https://example.com/audio', path: 'C:\\song.flac' }]) {
            await expect(request({ action: 'begin', session: 'online', backend: 'asio', deviceId: 'driver', ...source })).rejects.toThrow();
        }
        expect(await readdir(directory)).toEqual([]);
    });
    it('reuses the completed original across output sessions and serves it to the persistent cache without another remote transfer', async () => {
        let remoteTransfers = 0;
        const original = Buffer.alloc(128, 9), url = 'https://cdn.example/song.flac', trackKey = 'online:netease:9';
        const download = vi.fn(async (source: string, destination: string) => {
            const bytes = source === url ? (remoteTransfers++, original) : Buffer.from(await (await fetch(source)).arrayBuffer());
            await writeFile(destination, bytes); return { bytes: bytes.length, contentType: 'audio/flac' };
        });
        const { request } = await fixture(undefined, download);
        for (const session of ['first', 'second']) {
            await request({ action: 'begin', session, backend: 'asio', deviceId: 'driver', url, trackKey });
            await request({ action: 'finish', session });
            const cached = await request({ action: 'cached-source', url, trackKey }) as { url: string };
            expect(Buffer.from(await (await fetch(cached.url)).arrayBuffer())).toEqual(original);
            await request({ action: 'stop', session });
        }
        expect(remoteTransfers).toBe(1); expect(download).toHaveBeenCalledTimes(2);
        expect(download.mock.calls[1][0]).toMatch(/^http:\/\/127\.0\.0\.1:/);
    });
    it('never retains session-bound audio and revokes only the matching provider session', async () => {
        const download = vi.fn(async (_source: string, destination: string) => { await writeFile(destination, Buffer.alloc(128, 8)); });
        const { request, app, helper, directory } = await fixture(undefined, download);
        const url = 'http://127.0.0.1:43820/private.ogg', trackKey = 'online:spotify:track';
        await request({ action: 'begin', session: 'spotify', backend: 'asio', deviceId: 'driver', url, trackKey, sessionBoundAudio: true });
        await request({ action: 'finish', session: 'spotify' });
        expect(await request({ action: 'cached-source', url, trackKey })).toBeNull();
        app.emit('session-bound-audio-revoked', { providerId: 'other' }); await request({ action: 'play', session: 'spotify' });
        app.emit('session-bound-audio-revoked', { providerId: 'spotify' });
        await expect(request({ action: 'play', session: 'spotify' })).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(helper.request).toHaveBeenCalledWith({ action: 'stop', session: 'spotify' }));
        await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
        await request({ action: 'begin', session: 'local', backend: 'asio', deviceId: 'driver' }); await request({ action: 'finish', session: 'local' });
        app.emit('session-bound-audio-revoked', { providerId: 'spotify' }); await request({ action: 'play', session: 'local' });
    });

});
