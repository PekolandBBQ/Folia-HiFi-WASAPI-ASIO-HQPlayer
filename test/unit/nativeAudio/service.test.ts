import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/service.test.ts — file lifetime, caller validation and load cancellation.
const { registerNativeAudio } = createRequire(import.meta.url)('../../../electron/nativeAudio/service.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(decode: (exe: string, input: string, directory: string, signal: AbortSignal) => Promise<unknown>
    = vi.fn(async (_exe, input) => input), download?: (...args: any[]) => Promise<unknown>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-native-service-test-'));
    const app = Object.assign(new EventEmitter(), { isPackaged: false, getAppPath: () => directory, getPath: () => directory });
    const frame = {};
    const sender = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const event = { sender, senderFrame: frame };
    const helper = { request: vi.fn(async request => (request.action === 'hello' ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry'] } : { session: request.session, duration: 4 })), dispose: vi.fn() };
    const service = registerNativeAudio({ app, ipcMain: { handle: vi.fn() }, isTrustedSender: (value: unknown) => value === sender,
        componentManager: { status: async () => ({ available: true, executable: 'test.exe' }) }, decoderResolver: async () => 'ffmpeg.exe', helperFactory: () => helper, decode, download });
    cleanups.push(async () => {
        app.emit('before-quit');
        await new Promise(resolve => setTimeout(resolve, 20));
        await rm(directory, { recursive: true, force: true });
    });
    const request = (payload: Record<string, unknown>) => service.handle(event, payload);
    const begin = (session: string) => request({ action: 'begin', session, backend: 'asio', deviceId: 'driver' });
    return { request, begin, service, event, helper, directory };
}

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('native service', () => {
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

});
