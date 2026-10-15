import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/livePcmService.test.ts — only a main-owned registration can select the no-file native route.
const require = createRequire(import.meta.url);
const { registerNativeAudio } = require('../../../electron/nativeAudio/service.cjs');
const filesystem = require('node:fs/promises') as typeof import('node:fs/promises');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture({ streaming = true, portable = false, hqPrepare = async () => {} } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-live-service-'));
    const app = Object.assign(new EventEmitter(), { isPackaged: false, getAppPath: () => directory, getPath: () => directory });
    const sender = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const capabilities = ['integer-pcm', 'replaygain', 'format-telemetry', ...(streaming ? ['streaming-pcm-v1'] : [])];
    const helper = { dispose: vi.fn(), request: vi.fn(async (request: any) => request.action === 'hello'
        ? { protocolMajor: 1, capabilities }
        : { session: request.session, duration: 120 }) };
    const source = { sampleRate: 44100, channels: 2, durationMs: 120000, openReadable: vi.fn(), pause: vi.fn() };
    const url = 'http://127.0.0.1:31573/owned.wav';
    const resolveLivePcmSource = vi.fn((value: string) => value === url ? source : null);
    const live = { prepare: vi.fn(async () => ({ session: 'known', streaming: true, streamGeneration: 1,
        position: 0, duration: 120, pipeName: 'must-remain-main-only', sourceCodec: 'PCM' })),
        command: vi.fn(async () => ({ session: 'known', position: 15 })), observe: vi.fn(() => true), close: vi.fn(async () => {}) };
    const liveStreamFactory = vi.fn((_options: any) => live);
    const decode = vi.fn(async (_exe: string, input: string) => input), download = vi.fn(async () => {});
    const mkdtempSpy = vi.spyOn(filesystem, 'mkdtemp'), writeFile = vi.spyOn(filesystem, 'writeFile');
    // Snapshot the platform gate for this portable IPC-only test. No Windows
    // process, driver, decoder or device is invoked by these injected factories.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    if (portable) Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    let service: any, hqCallbacks: any;
    try { service = registerNativeAudio({ app, ipcMain: { handle: vi.fn() }, isTrustedSender: (value: unknown) => value === sender,
        componentManager: { status: async () => ({ available: true, executable: 'helper.exe' }) }, helperFactory: () => helper,
        decoderResolver: async () => 'decoder.exe', decode, download, resolveLivePcmSource, liveStreamFactory,
        hqplayerFactory: (callbacks: any) => (hqCallbacks = callbacks, { dispose: vi.fn(), prepare: hqPrepare, supportsStreaming: async () => true, stop: vi.fn() }) }); }
    finally { if (portable) Object.defineProperty(process, 'platform', platform); }
    const request = (payload: Record<string, unknown>) => service.handle({ sender, senderFrame: sender.mainFrame }, payload);
    cleanups.push(async () => {
        app.emit('before-quit'); await new Promise(resolve => setTimeout(resolve, 25));
        await rm(directory, { recursive: true, force: true });
    });
    return { request, app, source, live, liveStreamFactory, hqCallbacks, decode, download, mkdtempSpy, writeFile, directory, helper, url };
}

it('waits for Desktop connection before starting the bounded live producer', async () => {
    let connected!: () => void;
    const connection = new Promise<void>(resolve => { connected = resolve; });
    const f = await fixture({ portable: true, hqPrepare: () => connection });
    await f.request({ action: 'begin', session: 'known', backend: 'hqplayer', deviceId: 'hqplayer-local', url: f.url });
    const pending = f.request({ action: 'finish', session: 'known' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.liveStreamFactory).not.toHaveBeenCalled();
    connected();
    await pending;
    expect(f.live.prepare).toHaveBeenCalledOnce();
    await f.request({ action: 'stop', session: 'known' });
});

it('drops renderer encoding and transport claims for a registered live source before any output authorization', async () => {
    const f = await fixture({ portable: true });
    await f.request({ action: 'begin', session: 'known', backend: 'asio', deviceId: 'test', url: f.url,
        transport: { contract: 'live-pcm-s32le-v1' }, livePcmReader: { claimed: true }, sourceKind: 'spotify-live', allowUnverifiedRaw: true,
        sourceMetadata: { requestedQuality: 'lossless', quality: 'lossless', providerLevel: 'lossless',
            sourceFormat: { codec: 'FLAC', sampleRate: 192000, bitsPerSample: 24 } } });
    const state = await f.request({ action: 'finish', session: 'known' });
    expect(state).toMatchObject({ sourceEncodingVerified: false, requestedQuality: 'lossless', preparedSource: true });
    expect(state.sourceCodec).toBeUndefined(); expect(state.sourceSampleRate).toBeUndefined(); expect(state.sourceQuality).toBeUndefined();
    const current = f.liveStreamFactory.mock.calls[0][0].current;
    expect(current).not.toHaveProperty('transport'); expect(current).not.toHaveProperty('livePcmReader');
    expect(current.sourceMetadata).not.toHaveProperty('sourceFormat');
    await f.request({ action: 'stop', session: 'known' }); expect(f.live.close).toHaveBeenCalledOnce();
});

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('main-owned live PCM route', () => {
    it('prepares registered PCM without filesystem, download or decoder work and preserves unknown original encoding', async () => {
        const f = await fixture();
        await f.request({ action: 'begin', session: 'known', backend: 'asio', deviceId: 'test', url: f.url,
            trackKey: 'online:spotify:test', sourceMetadata: { requestedQuality: 'lossless' } });
        const state = await f.request({ action: 'finish', session: 'known' });
        expect(f.mkdtempSpy).not.toHaveBeenCalled(); expect(f.writeFile).not.toHaveBeenCalled();
        expect(f.download).not.toHaveBeenCalled(); expect(f.decode).not.toHaveBeenCalled();
        expect(f.liveStreamFactory).toHaveBeenCalledOnce();
        expect(f.liveStreamFactory.mock.calls[0][0]).toMatchObject({ source: f.source,
            current: { sessionBoundAudio: true, directory: null, durationHint: 120,
                sourceMetadata: { preparedAudio: { representation: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 } } } });
        expect(state).toMatchObject({ requestedQuality: 'lossless', sourceEncodingVerified: false, preparedSource: true });
        expect(state.sourceCodec).toBeUndefined(); expect(state.pipeName).toBeUndefined();
        await f.request({ action: 'pause', session: 'known' });
        expect(f.live.command).toHaveBeenCalledWith('pause', expect.objectContaining({ session: 'known' }));
        await f.request({ action: 'stop', session: 'known' }); expect(f.live.close).toHaveBeenCalledOnce();
        expect(await readdir(f.directory)).toEqual([]);
    });

    it('does not accept a renderer claim or lookalike URL as a trusted live source', async () => {
        const f = await fixture({ streaming: false });
        await f.request({ action: 'begin', session: 'unknown', backend: 'asio', deviceId: 'test',
            url: f.url + '?lookalike=1', sessionBoundAudio: true, livePcmSource: true });
        await f.request({ action: 'finish', session: 'unknown' });
        expect(f.liveStreamFactory).not.toHaveBeenCalled();
        expect(f.mkdtempSpy).toHaveBeenCalledOnce(); expect(f.writeFile).toHaveBeenCalledOnce();
        expect(f.download).toHaveBeenCalledOnce(); expect(f.decode).toHaveBeenCalledOnce();
        await f.request({ action: 'stop', session: 'unknown' });
    });

    it('fails closed for an old output component instead of buffering live PCM to disk', async () => {
        const f = await fixture({ streaming: false });
        await f.request({ action: 'begin', session: 'known', backend: 'asio', deviceId: 'test', url: f.url });
        await expect(f.request({ action: 'finish', session: 'known' })).rejects.toMatchObject({ code: 'COMPONENT_INCOMPATIBLE' });
        expect(f.liveStreamFactory).not.toHaveBeenCalled(); expect(f.mkdtempSpy).not.toHaveBeenCalled();
        expect(f.download).not.toHaveBeenCalled(); expect(f.decode).not.toHaveBeenCalled();
        await f.request({ action: 'stop', session: 'known' });
    });
});

it('Stop still restores the exact active source after its late producer failure aborted playback', async () => {
    const f = await fixture({ portable: true });
    await f.request({ action: 'begin', session: 'failed-owner', backend: 'asio', deviceId: 'test', url: f.url });
    await f.request({ action: 'finish', session: 'failed-owner' });
    const options = f.liveStreamFactory.mock.calls[0][0];
    options.onError(Object.assign(new Error('synthetic source failure'), { code: 'SOURCE_UNAVAILABLE' }));
    expect(options.current.abort.signal.aborted).toBe(true);
    await f.request({ action: 'stop', session: 'unrelated-owner' }); expect(f.live.close).not.toHaveBeenCalled();
    await expect(f.request({ action: 'stop', session: 'failed-owner' })).resolves.toMatchObject({ ok: true });
    expect(f.live.close).toHaveBeenCalledOnce();
    expect(f.live.close).toHaveBeenCalledWith({ retainSource: false });
});

it('a replaced live reader cancellation does not fail or abort the current output, but a real fault still does', async () => {
 const f=await fixture({portable:true});await f.request({action:'begin',session:'known',backend:'asio',deviceId:'test',url:f.url});await f.request({action:'finish',session:'known'});
 const options=f.liveStreamFactory.mock.calls[0][0];const send=options.current.sender.send;send.mockClear();
 for(const error of [Object.assign(Error('cancel'),{code:'CANCELLED'}),new DOMException('aborted','AbortError'),Object.assign(Error('Spotify: request-cancelled'),{code:'unavailable'})])options.onError(error);
 expect(options.current.abort.signal.aborted).toBe(false);expect(send).not.toHaveBeenCalled();
 await expect(f.request({action:'seek',session:'known',position:15})).resolves.toBeDefined();
 options.onError(Object.assign(Error('real failure'),{code:'SOURCE_UNAVAILABLE'}));expect(options.current.abort.signal.aborted).toBe(true);expect(send).toHaveBeenCalled();
});

it('HQPlayer callback cancellation is silent while genuine control rejection is still sent',async()=>{
 const f=await fixture({portable:true});await f.request({action:'begin',session:'known',backend:'hqplayer',deviceId:'hqplayer-local',url:f.url});await f.request({action:'finish',session:'known'});
 const send=f.liveStreamFactory.mock.calls[0][0].current.sender.send;send.mockClear();
 f.hqCallbacks.onError(Object.assign(Error('retired'),{code:'CANCELLED'}));expect(send).not.toHaveBeenCalled();
 f.hqCallbacks.onError(Object.assign(Error('rejected'),{code:'HQPLAYER_COMMAND_REJECTED'}));expect(send).toHaveBeenCalledWith('native-audio:event',expect.objectContaining({errorCode:'HQPLAYER_COMMAND_REJECTED'}));
});
