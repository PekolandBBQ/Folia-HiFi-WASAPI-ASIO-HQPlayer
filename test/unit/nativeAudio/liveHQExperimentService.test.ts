import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import os from 'node:os';

// liveHQExperimentService.test.ts — Windows IPC routing evaluated with inert helpers on Linux; no device, process or socket.
const require = createRequire(import.meta.url);
const servicePath = require.resolve('../../../electron/nativeAudio/service.cjs');
const moduleObject = { exports: {} as any };
runInNewContext(readFileSync(servicePath, 'utf8'), { module: moduleObject, exports: moduleObject.exports,
    require: createRequire(servicePath), process: { platform: 'win32', arch: 'x64' },
    console: { info: () => {}, error: () => {} }, AbortController, URL, Buffer, setTimeout, clearTimeout });
const { registerNativeAudio } = moduleObject.exports;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
const settings = { enabled: true, prebufferMs: 1750, startupDelayMs: 800 };
async function fixture({ streamFailure = null as string | null, failedAfterReady = false } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-experiment-ipc-'));
    const app = Object.assign(new EventEmitter(), { getPath: () => directory });
    const sender = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const source = { sampleRate: 44100, channels: 2, durationMs: 120000, pause: vi.fn(async () => {}), stop: vi.fn(async () => {}),
        openReadable: vi.fn(() => { throw new Error('Must not open a real reader'); }) };
    const url = 'http://127.0.0.1:30000/main-owned-pcm';
    const hqplayer = { prepare: vi.fn(async () => {}), checkExisting: vi.fn(async () => {}), setSilent: vi.fn(),
        supportsStreaming: vi.fn(async (options: any) => {
            if (options?.sourceKind !== 'spotify-live') return true;
            if (options?.allowUnverifiedRaw === true) return true;
            if (options?.required) throw Object.assign(new Error('unverified'), { code: 'HQPLAYER_RAW_FORMAT_UNVERIFIED' });
            return false;
        }), stop: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
        load: vi.fn(async (spec: any) => ({ session: spec.session, position: 0, duration: 120 })),
        streamPrepare: vi.fn(async (spec: any) => ({ session: spec.session, generation: 1, ready: true, bufferedSeconds: 0.5,
            state: { position: 0, duration: 120, playing: false } })), streamClose: vi.fn(async () => ({ ok: true })) };
    const helper = { request: vi.fn(async (request: any) => request.action === 'hello'
        ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry', 'streaming-pcm-v1'] }
        : { session: request.session, position: 0 }), dispose: vi.fn() };
    const sessions: any[] = [];
    const liveStreamFactory = vi.fn((options: any) => {
        const live = { options, prepare: vi.fn(async () => ({ session: options.current.id, duration: 120, position: 0 })),
            command: vi.fn(async () => ({})), close: vi.fn(async () => {}) }; sessions.push(live); return live;
    });
    const finite: any[] = [], downloads: Array<() => Promise<void>> = [];
    const completeDownloads = async () => { for (const complete of downloads.splice(0)) await complete(); };
    const streamFactory = vi.fn((options: any) => {
        let resolve!: () => void;
        const source = { state: { complete: false, available: 0 }, downloaded: new Promise<void>(done => { resolve = done; }) };
        downloads.push(async () => { await writeFile(options.current.input, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(64)]));
            source.state.complete = true; source.state.available = 68; resolve(); });
        const stream = { options, source, close: vi.fn(async () => { await options.helper.close(); }),
            prepare: vi.fn(async () => {
                options.current.loadRequested = true;
                const state = await options.openOutput({ action: 'stream-load', session: options.current.id,
                    pipeName: 'folia-audio-01234567-89ab-cdef-0123-456789abcdef', sampleRate: 44100, channels: 2 });
                if (streamFailure) {
                    const error = Object.assign(new Error('inert stream test'), { code: streamFailure });
                    if (failedAfterReady) options.onError(error);
                    throw error;
                }
                return state;
            }) };
        finite.push(stream); return stream;
    });
    const download = vi.fn(async (_url: string, file: string) => { await writeFile(file, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(64)])); return {}; });
    const service = registerNativeAudio({ app, ipcMain: { handle: vi.fn() }, isTrustedSender: (value: unknown) => value === sender,
        componentManager: { status: async () => ({ available: true, executable: 'never-run.exe' }) }, helperFactory: () => helper,
        decoderResolver: async () => 'never-run.exe', decode: vi.fn(async (_exe: string, file: string) => file), download,
        hqplayerFactory: () => hqplayer, resolveLivePcmSource: (value: string) => value === url ? source : null,
        liveStreamFactory, streamFactory });
    const request = (payload: any) => service.handle({ sender, senderFrame: sender.mainFrame }, payload);
    cleanups.push(async () => { await completeDownloads(); app.emit('before-quit'); await new Promise(resolve => setTimeout(resolve, 10)); await rm(directory, { recursive: true, force: true }); });
    return { service, request, sender, source, url, hqplayer, helper, liveStreamFactory, sessions, streamFactory, download, finite, completeDownloads };
}
const begin = (f: Awaited<ReturnType<typeof fixture>>, session: string, fields = {}) => f.request({ action: 'begin', session,
    backend: 'hqplayer', deviceId: 'hqplayer-local', url: f.url, ...fields });

it('defaults off before any live factory, reader or output preparation can be created', async () => {
    const f = await fixture(); await begin(f, 'off');
    await expect(f.request({ action: 'finish', session: 'off' })).rejects.toMatchObject({ code: 'HQPLAYER_RAW_FORMAT_UNVERIFIED' });
    expect(f.hqplayer.supportsStreaming).toHaveBeenCalledWith({ required: true, sourceKind: 'spotify-live', allowUnverifiedRaw: false });
    expect(f.liveStreamFactory).not.toHaveBeenCalled(); expect(f.source.openReadable).not.toHaveBeenCalled();
});
it.each(['fragment', 'short-ip', 'short-ip-fragment'])('keeps canonical live URL aliases behind the default-off gate: %s', async spelling => {
    const f = await fixture();
    let url = spelling.startsWith('short-ip') ? f.url.replace('127.0.0.1', '127.1') : f.url;
    if (spelling.includes('fragment')) url += '#ignored';
    await begin(f, 'off-alias', { url, sourceKind: 'finite' });
    await expect(f.request({ action: 'finish', session: 'off-alias' })).rejects.toMatchObject({ code: 'HQPLAYER_RAW_FORMAT_UNVERIFIED' });
    expect(f.liveStreamFactory).not.toHaveBeenCalled(); expect(f.streamFactory).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
    await begin(f, 'on-alias', { url, hqplayerSpotifyExperiment: settings });
    await f.request({ action: 'finish', session: 'on-alias' });
    expect(f.liveStreamFactory).toHaveBeenCalledOnce(); expect(f.streamFactory).not.toHaveBeenCalled();
});
it.each(['localhost', 'localhost.'])('rejects a registered private live route spelled through %s instead of treating it as finite', async hostname => {
    const f = await fixture(); const url = f.url.replace('127.0.0.1', hostname) + '#ignored';
    await expect(begin(f, 'alias', { url })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.request({ action: 'finish', session: 'alias' })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.liveStreamFactory).not.toHaveBeenCalled(); expect(f.streamFactory).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
});
it('passes an immutable-by-copy begin snapshot only to the main-owned live HQPlayer preparation', async () => {
    const f = await fixture(); const input = { ...settings };
    await begin(f, 'hq', { hqplayerSpotifyExperiment: input }); input.prebufferMs = 100;
    await f.request({ action: 'finish', session: 'hq' });
    expect(f.liveStreamFactory).toHaveBeenCalledOnce();
    expect(f.liveStreamFactory.mock.calls[0][0]).toMatchObject({ source: f.source, experiment: settings,
        current: { hqplayerSpotifyExperiment: settings, directory: null, sessionBoundAudio: true } });
    expect(f.hqplayer.supportsStreaming).toHaveBeenCalledWith({ required: true, sourceKind: 'spotify-live', allowUnverifiedRaw: true });
    expect(f.download).not.toHaveBeenCalled();
});
it('ignores experiment settings for existing ASIO live output and leaves its options unchanged', async () => {
    const f = await fixture(); await begin(f, 'asio', { backend: 'asio', deviceId: 'test', hqplayerSpotifyExperiment: settings });
    await f.request({ action: 'finish', session: 'asio' });
    expect(f.liveStreamFactory.mock.calls[0][0].experiment).toBeUndefined();
    expect(f.hqplayer.supportsStreaming).not.toHaveBeenCalled();
});
it.each(['qq', 'netease'])('preserves %s finite streaming before full download, ignoring renderer claims and live experiment settings', async provider => {
    const f = await fixture(); await begin(f, provider, { url: f.url + '?lookalike=1', trackKey: `online:${provider}:test`,
        livePcmSource: true, sourceKind: 'spotify-live', sessionBoundAudio: true, hqplayerSpotifyExperiment: settings });
    await f.request({ action: 'finish', session: provider });
    expect(f.hqplayer.supportsStreaming).toHaveBeenCalledWith();
    expect(f.liveStreamFactory).not.toHaveBeenCalled(); expect(f.streamFactory).toHaveBeenCalledOnce();
    expect(f.download).not.toHaveBeenCalled(); expect(f.hqplayer.load).not.toHaveBeenCalled();
    expect(f.finite[0].source.state.complete).toBe(false);
    expect(f.finite[0].options.experiment).toBeUndefined(); expect(f.finite[0].options.startupDelayMs).toBeUndefined();
    expect(f.hqplayer.streamPrepare).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: 'finite', session: provider }), { allowUnverifiedRaw: false });
});
it('retains the initial unknown-container fallback after the existing finite download completes', async () => {
    const f = await fixture({ streamFailure: 'DECODE_FAILED' });
    await begin(f, 'unknown', { url: 'https://example.invalid/container', sessionBoundAudio: true });
    const finishing = f.request({ action: 'finish', session: 'unknown' });
    await vi.waitFor(() => expect(f.finite[0]?.prepare).toHaveBeenCalled());
    expect(f.hqplayer.load).not.toHaveBeenCalled();
    await f.completeDownloads(); await finishing;
    expect(f.finite[0].close).toHaveBeenCalledOnce(); expect(f.hqplayer.load).toHaveBeenCalledOnce();
    expect(f.download).not.toHaveBeenCalled();
});
it.each([{ streamFailure: 'DEVICE_UNAVAILABLE', failedAfterReady: false }, { streamFailure: 'DECODE_FAILED', failedAfterReady: true }])
('does not misroute a device/established-stream failure to whole-file fallback: %j', async options => {
    const f = await fixture(options); await begin(f, 'failure', { url: 'https://example.invalid/audio', sessionBoundAudio: true });
    await expect(f.request({ action: 'finish', session: 'failure' })).rejects.toMatchObject({ code: options.streamFailure });
    expect(f.hqplayer.load).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
});
it('releases the old experiment on output handoff and rejects its late commands', async () => {
    const f = await fixture(); await begin(f, 'old', { hqplayerSpotifyExperiment: settings }); await f.request({ action: 'finish', session: 'old' });
    const old = f.sessions[0];
    await begin(f, 'new', { backend: 'asio', deviceId: 'test' }); await f.request({ action: 'finish', session: 'new' });
    expect(old.options.current.abort.signal.aborted).toBe(true); expect(old.close).toHaveBeenCalledOnce();
    expect(f.hqplayer.stop).toHaveBeenCalledWith('old');
    await expect(f.request({ action: 'play', session: 'old' })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(old.command).not.toHaveBeenCalled(); expect(f.sessions[1].options.experiment).toBeUndefined();
});
it('rejects malformed configuration before replacing a valid playing session', async () => {
    const f = await fixture(); await begin(f, 'valid', { hqplayerSpotifyExperiment: settings }); await f.request({ action: 'finish', session: 'valid' });
    await expect(begin(f, 'invalid', { hqplayerSpotifyExperiment: { ...settings, startupDelayMs: 1001 } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.sessions[0].close).not.toHaveBeenCalled(); expect(f.sessions[0].options.current.abort.signal.aborted).toBe(false);
    await expect(f.service.handle({ sender: {} }, { action: 'begin', hqplayerSpotifyExperiment: settings })).rejects.toThrow('Untrusted');
});
