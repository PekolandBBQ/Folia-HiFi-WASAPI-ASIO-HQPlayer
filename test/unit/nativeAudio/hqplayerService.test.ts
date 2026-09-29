import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/hqplayerService.test.ts — HQPlayer must work with the native component disabled.
const { registerNativeAudio } = createRequire(import.meta.url)('../../../electron/nativeAudio/service.cjs');
it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('keeps HQPlayer independent while preserving IPC caller and gain validation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'folia-hqp-service-'));
    const app = Object.assign(new EventEmitter(), { getPath: () => root });
    const sender = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const componentManager = { status: vi.fn(async () => ({ available: false, installed: false })) };
    let helperEvent: (event: unknown) => void = () => {};
    const helperFactory = vi.fn((_executable, callback) => { helperEvent = callback; return { request: vi.fn(async () => ({ protocolMajor: 1, capabilities: ['integer-pcm','replaygain','format-telemetry'] })), dispose: vi.fn() }; });
    const hqplayer = { device: async () => ({ id: 'hqplayer-local' }), load: vi.fn(async request => ({ session: request.session })),
        command: vi.fn(async session => ({ session })), stop: vi.fn(async () => {}), shutdown: vi.fn(async () => ({ ok: true })), dispose: vi.fn(),
        dspSettings: vi.fn(async (_settings, when, session) => when === 'current' ? ({ session, position: 37, playing: true }) : ({ ok: true })) };
    const service = registerNativeAudio({ app, ipcMain: { handle: vi.fn() }, isTrustedSender: (value: unknown) => value === sender,
        componentManager, helperFactory, hqplayerFactory: () => hqplayer, decoderResolver: async () => 'ffmpeg.exe' });
    const request = (body: Record<string, unknown>) => service.handle({ sender, senderFrame: sender.mainFrame }, body);
    try {
        expect(await request({ action: 'status' })).toMatchObject({ available: false });
        expect(await request({ action: 'hqplayer-status' })).toMatchObject({ available: true });
        await expect(service.handle({ sender: {} }, { action: 'hqplayer-status' })).rejects.toThrow('Untrusted');
        const source = path.join(root, 'source.wav'); await writeFile(source, 'RIFF');
        componentManager.status.mockResolvedValueOnce({ available: true, installed: true, executable: 'helper.exe' } as any);
        await request({ action: 'begin', session: 'warm', backend: 'asio', deviceId: 'test', path: source });
        await request({ action: 'begin', session: 'hq', backend: 'hqplayer', deviceId: 'hqplayer-local', path: source });
        await request({ action: 'finish', session: 'hq' });
        sender.send.mockClear();
        await request({ action: 'hqplayer-dsp-apply', session: 'hq', when: 'next', settings: {} });
        expect(sender.send).not.toHaveBeenCalled();
        await request({ action: 'hqplayer-dsp-apply', session: 'hq', when: 'current', settings: {} });
        expect(sender.send).toHaveBeenCalledWith('native-audio:event', expect.objectContaining({
            event: 'resume', session: 'hq', state: expect.objectContaining({ position: 37, playing: true }),
        }));
        await request({ action: 'replaygain', session: 'hq', gain: 0.5 });
        expect(hqplayer.command).toHaveBeenCalledWith('hq', 'replaygain', 0.5);
        await expect(request({ action: 'gain', session: 'hq', gainDb: 4 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(helperFactory).toHaveBeenCalledTimes(1);
        sender.send.mockClear();
        helperEvent({ event: 'error', errorCode: 'COMPONENT_CRASHED' });
        expect(sender.send).not.toHaveBeenCalled();
        await request({ action: 'hqplayer-shutdown' });
        expect(hqplayer.stop).toHaveBeenCalledWith('hq');
        expect(hqplayer.shutdown).toHaveBeenCalledOnce();
        expect(helperFactory.mock.results[0].value.dispose).toHaveBeenCalledOnce();
        await expect(request({ action: 'play', session: 'hq' })).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally { app.emit('before-quit'); await new Promise(resolve => setTimeout(resolve, 30)); await rm(root, { recursive: true, force: true }); }
});
