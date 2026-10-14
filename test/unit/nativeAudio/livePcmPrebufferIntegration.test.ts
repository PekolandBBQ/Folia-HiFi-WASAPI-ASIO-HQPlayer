import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { NativeAudioTransport } from '../../../src/services/nativeAudio/NativeAudioTransport';
import { useAudioSettingsStore } from '../../../src/stores/useAudioSettingsStore';
import { useHQPlayerSettingsStore } from '../../../src/stores/useHQPlayerSettingsStore';
import { HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS } from '../../../src/utils/hqplayerSpotifyExperiment';
import type { NativeAudioBackend, NativeAudioEvent } from '../../../src/types/nativeAudio';

// Actual renderer/store → main service → live PCM pump → stream readiness; hardware boundaries are inert fixtures.
const require = createRequire(import.meta.url);
const servicePath = require.resolve('../../../electron/nativeAudio/service.cjs');
const moduleObject = { exports: {} as any };
runInNewContext(readFileSync(servicePath, 'utf8'), { module: moduleObject, exports: moduleObject.exports,
    require: createRequire(servicePath), process: { platform: 'win32', arch: 'x64' },
    console: { info: () => {}, error: () => {} }, AbortController, URL, Buffer, setTimeout, clearTimeout });
const { registerNativeAudio } = moduleObject.exports;
const { createLivePcmSession } = require('../../../electron/nativeAudio/livePcmSession.cjs');
const { LIVE_PCM_TRANSPORT } = require('../../../electron/nativeAudio/livePcmFormat.cjs');
const cleanup: Array<() => Promise<void>> = [];
const rate = 44100, frameBytes = 8;
const backends = ['wasapi-exclusive', 'asio', 'hqplayer'] as const;
beforeEach(() => {
    useAudioSettingsStore.setState({ livePcmPrebufferMs: 350 });
    useHQPlayerSettingsStore.setState({ spotifyExperiment: { ...HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS } });
});
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); vi.restoreAllMocks(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
async function fixture(backend: NativeAudioBackend) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-pcm-target-'));
    const app = Object.assign(new EventEmitter(), { getPath: () => directory });
    let listener = (_event: NativeAudioEvent) => {}, generation = 0, position = 0, playing = false, sessionId = '';
    const pipes: Array<{ chunks: Buffer[]; bytes: number; pipe: Writable }> = [], readers: any[] = [], sessions: any[] = [];
    const state = () => ({ session: sessionId, streamGeneration: generation, streaming: true, ready: true, position,
        duration: 120, playing, ended: false, buffering: false, bufferedStart: position,
        bufferedEnd: position + (pipes[generation - 1]?.bytes || 0) / (rate * frameBytes),
        producerComplete: false, sampleRate: rate, channels: 2, latency: 0, backend, deviceId: backend === 'hqplayer' ? 'hqplayer-local' : 'test' });
    const control = (action: string) => { if (action === 'play') playing = true; if (['pause', 'stop', 'stream-retire'].includes(action)) playing = false; return state(); };
    const open = (request: any) => { generation++; position = request.position ?? request.position0; sessionId = request.session; playing = false; return state(); };
    const helper = { request: vi.fn(async (request: any) => {
        if (Object.hasOwn(request, 'livePcmPrebufferMs')) throw new Error('Unknown field in installed helper protocol');
        return request.action === 'hello'
            ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry', 'streaming-pcm-v1'] }
            : ['stream-load', 'stream-reset'].includes(request.action) ? open(request) : control(request.action);
    }), dispose: vi.fn() };
    const hqState = () => ({ generation, ready: true, position0: position, decodedSeconds: (pipes[generation - 1]?.bytes || 0) / (rate * frameBytes), state: state() });
    const hqplayer = { prepare: vi.fn(async () => {}), checkExisting: vi.fn(async () => {}), setSilent: vi.fn(),
        supportsStreaming: vi.fn(async () => true), stop: vi.fn(async () => { control('stop'); }), dispose: vi.fn(async () => {}),
        streamPrepare: vi.fn(async (spec: any) => { open(spec); return hqState(); }),
        streamReset: vi.fn(async (spec: any) => { open(spec); return hqState(); }),
        streamStatus: vi.fn(async () => hqState()), streamClose: vi.fn(async () => ({ ok: true })),
        command: vi.fn(async (_session: string, action: string) => control(action)) };
    let ownedReader: any;
    const source = { sampleRate: rate, channels: 2, durationMs: 120000,
        pause: vi.fn(async () => {}), stop: vi.fn(async () => {}), seek: vi.fn(async () => {}),
        assertReader: (reader: any) => { if (reader !== ownedReader) throw Object.assign(new Error('Retired reader'), { code: 'CANCELLED' }); reader.signal.throwIfAborted(); },
        openReadable: vi.fn(async ({ positionMs, signal }: any) => {
            const record = { positionMs, signal, queue: [] as Buffer[], wake: () => {}, finished: false,
                push(bytes: Buffer) { this.queue.push(bytes); this.wake(); } }; readers.push(record);
            ownedReader = { signal, transport: LIVE_PCM_TRANSPORT, stream: (async function* () {
                try { while (true) {
                    signal.throwIfAborted();
                    if (record.queue.length) { yield record.queue.shift()!; continue; }
                    await new Promise<void>((resolve, reject) => {
                        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
                        record.wake = () => { signal.removeEventListener('abort', abort); resolve(); };
                        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
                    });
                } } finally { record.finished = true; }
            })() }; return ownedReader;
        }) };
    const url = 'http://127.0.0.1:30000/live-pcm';
    const sender = { mainFrame: {}, isDestroyed: () => false, send: vi.fn((_channel: string, event: NativeAudioEvent) => listener(event)) };
    const service = registerNativeAudio({ app, ipcMain: { handle: vi.fn() }, isTrustedSender: (value: unknown) => value === sender,
        componentManager: { status: async () => ({ available: true, executable: 'never-run.exe' }) }, helperFactory: () => helper,
        decoderResolver: async () => 'never-run.exe', hqplayerFactory: () => hqplayer,
        resolveLivePcmSource: (value: string) => value === url ? source : null,
        liveStreamFactory: (options: any) => {
            const live = createLivePcmSession({ ...options, connectPipe: () => {
                const record = { chunks: [] as Buffer[], bytes: 0, pipe: null as unknown as Writable };
                const pipe = new Writable({ write(bytes, _encoding, done) { record.chunks.push(Buffer.from(bytes)); record.bytes += bytes.length; done(); } });
                record.pipe = pipe; pipes.push(record);
                queueMicrotask(() => pipe.emit('connect')); return pipe;
            } }); sessions.push({ options, live }); return live;
        } });
    const request = vi.fn((input: any) => service.handle({ sender, senderFrame: sender.mainFrame }, input));
    const transport = new NativeAudioTransport({ supported: true, request, onEvent: callback => { listener = callback; return () => { listener = () => {}; }; } },
        backend, backend === 'hqplayer' ? 'hqplayer-local' : 'test', 'compatibility', async () => null);
    cleanup.push(async () => {
        if (sessionId) await request({ action: 'stop', session: sessionId });
        transport.dispose(); app.emit('before-quit'); for (const record of pipes) record.pipe.destroy();
        await rm(directory, { recursive: true, force: true });
    });
    const push = async (frames: number, seed = readers.length) => {
        const bytes = Buffer.alloc(frames * frameBytes, seed);
        for (let offset = 0; offset < bytes.length; offset += 65536) readers.at(-1).push(bytes.subarray(offset, offset + 65536));
        await settle(); return bytes;
    };
    return { transport, request, source, pipes, readers, sessions, sender, push, url, helper, hqplayer };
}

it.each(backends.flatMap(backend => [25, 350, 1000, 5000].map(target => [backend, target] as const)))
('waits for %s %i ms through the real renderer/main/live stream chain', async (backend, target) => {
    const f = await fixture(backend);
    useAudioSettingsStore.getState().handleSetLivePcmPrebufferMs(target);
    f.transport.setSource(f.url);
    await vi.waitFor(() => expect(f.readers).toHaveLength(1));
    const frames = Math.ceil(target * rate / 1000);
    await f.push(frames - 1);
    expect(f.transport.readyState).toBe(0);
    expect(f.request.mock.calls[0][0]).toMatchObject({ action: 'begin', livePcmPrebufferMs: target });
    expect(f.sessions[0].options.getPrebufferMs()).toBe(target);
    await f.push(1);
    await vi.waitFor(() => expect(f.transport.readyState).toBe(3));
    expect(f.transport.paused).toBe(true);
    expect(f.sender.send.mock.calls.some(([, event]) => event.progress?.total === target)).toBe(true);
    await f.transport.play(); expect(f.transport.paused).toBe(false);
    expect(f.helper.request.mock.calls.every(([request]) => !Object.hasOwn(request, 'livePcmPrebufferMs'))).toBe(true);
});

it.each(backends)('keeps %s playing unchanged, parks paused seek, and applies the next target without old PCM', async backend => {
    const f = await fixture(backend);
    f.transport.setSource(f.url); await vi.waitFor(() => expect(f.readers).toHaveLength(1));
    await f.push(Math.ceil(350 * rate / 1000)); await f.transport.play();
    const count = f.request.mock.calls.length, revision = useAudioSettingsStore.getState().nativeAudioOutputRevision;
    useAudioSettingsStore.getState().handleSetLivePcmPrebufferMs(1000); await settle();
    expect(f.request.mock.calls).toHaveLength(count); expect(f.transport.paused).toBe(false);
    expect(useAudioSettingsStore.getState().nativeAudioOutputRevision).toBe(revision);
    expect(f.sessions[0].options.getPrebufferMs()).toBe(350);
    const active = { streaming: true, streamGeneration: 1, position: 0, playing: true, buffering: false };
    expect(f.sessions[0].live.observe(active)).toBe(true);
    expect(active).toHaveProperty('livePcmPrebufferMs', 350);
    f.transport.pause(); await vi.waitFor(() => expect(f.readers[0].finished).toBe(true));
    f.transport.currentTime = 22; await vi.waitFor(() => expect(f.transport.seeking).toBe(false));
    expect(f.readers).toHaveLength(1); expect(f.transport.paused).toBe(true);
    expect(f.request.mock.calls.filter(([request]) => request.action === 'play')).toHaveLength(1);
    const resumed = f.transport.play(); await vi.waitFor(() => expect(f.readers).toHaveLength(2));
    expect(f.readers[1].positionMs).toBe(22000);
    await f.push(Math.ceil(350 * rate / 1000)); expect(f.transport.paused).toBe(true);
    await f.push(Math.ceil(650 * rate / 1000)); await resumed; expect(f.transport.paused).toBe(false);
    expect(f.readers[0].signal.aborted).toBe(true);
    expect(f.pipes[0].chunks.every(bytes => bytes.every(value => value === 1))).toBe(true);
    expect(f.pipes[1].chunks.every(bytes => bytes.every(value => value === 2))).toBe(true);
    expect(f.sessions[0].live.observe({ streaming: true, streamGeneration: 1, position: 88, playing: true })).toBe(false);
    useAudioSettingsStore.getState().handleSetLivePcmPrebufferMs(25);
    f.transport.currentTime = 44; await vi.waitFor(() => expect(f.readers).toHaveLength(3));
    await f.push(Math.ceil(25 * rate / 1000)); await vi.waitFor(() => expect(f.transport.seeking).toBe(false));
    expect(f.transport.paused).toBe(false); expect(f.readers[2].positionMs).toBe(44000);
    expect(f.pipes[2].chunks.every(bytes => bytes.every(value => value === 3))).toBe(true);
});

it('freezes an in-flight preparation despite slider updates and rejects bad IPC before replacing it', async () => {
    const f = await fixture('asio'); f.transport.setSource(f.url);
    await vi.waitFor(() => expect(f.readers).toHaveLength(1));
    useAudioSettingsStore.getState().handleSetLivePcmPrebufferMs(25);
    await f.push(Math.ceil(25 * rate / 1000)); expect(f.transport.readyState).toBe(0);
    for (const value of [null, '350', NaN, Infinity, 24, 5001, 25.5, {}, true]) {
        await expect(f.request({ action: 'begin', session: 'bad', backend: 'asio', deviceId: 'test', url: f.url, livePcmPrebufferMs: value })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(f.readers[0].signal.aborted).toBe(false);
    await f.push(Math.ceil(325 * rate / 1000)); await vi.waitFor(() => expect(f.transport.readyState).toBe(3));
    const session = f.request.mock.calls.find(([request]) => request.action === 'begin')![0].session;
    await expect(f.request({ action: 'seek', session, position: 12, livePcmPrebufferMs: 5001 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.readers).toHaveLength(1);
});

it('uses the shared target even while the legacy HQ experiment is enabled', async () => {
    const f = await fixture('hqplayer');
    useHQPlayerSettingsStore.setState({ spotifyExperiment: { enabled: true, prebufferMs: 2000, startupDelayMs: 0 } });
    useAudioSettingsStore.getState().handleSetLivePcmPrebufferMs(25);
    f.transport.setSource(f.url); await vi.waitFor(() => expect(f.readers).toHaveLength(1));
    await f.push(Math.ceil(25 * rate / 1000)); await vi.waitFor(() => expect(f.transport.readyState).toBe(3));
    expect(f.sessions[0].options.getPrebufferMs()).toBe(25);
});

it('the real renderer/main ASIO chain keeps latest Pause while the previous output Stop is delayed', async () => {
    const f = await fixture('asio'); f.transport.setSource(f.url);
    await vi.waitFor(() => expect(f.readers).toHaveLength(1)); await f.push(Math.ceil(350 * rate / 1000)); await f.transport.play();
    let finishStop!: () => void;
    const stopped = new Promise<void>(resolve => { finishStop = resolve; });
    const original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(async request => { if (request.action === 'stop') await stopped; return original(request); });
    f.transport.pause();
    await vi.waitFor(() => expect(f.helper.request.mock.calls.some(([request]) => request.action === 'stop')).toBe(true));
    const oldPlay = f.transport.play(); const cancelled = expect(oldPlay).rejects.toMatchObject({ name: 'AbortError' });
    f.transport.pause(); finishStop(); await cancelled;
    await settle(); expect(f.transport.paused).toBe(true); expect(f.transport.error).toBeNull(); expect(f.readers).toHaveLength(1);
    expect(f.readers[0].signal.aborted).toBe(true);
    const currentPlay = f.transport.play(); await vi.waitFor(() => expect(f.readers).toHaveLength(2));
    await f.push(Math.ceil(350 * rate / 1000)); await currentPlay;
    expect(f.transport.paused).toBe(false); expect(f.transport.error).toBeNull();
    expect(f.pipes[1].chunks.every(bytes => bytes.every(value => value === 2))).toBe(true);
});

it('the real renderer/main ASIO chain cancels a warming resume and ignores its late retired state', async () => {
    const f = await fixture('asio'); f.transport.setSource(f.url);
    await vi.waitFor(() => expect(f.readers).toHaveLength(1)); await f.push(Math.ceil(350 * rate / 1000)); await f.transport.play();
    f.transport.pause(); await vi.waitFor(() => expect(f.readers[0].finished).toBe(true));
    const oldPlay = f.transport.play(); const cancelled = expect(oldPlay).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.readers).toHaveLength(2));
    f.transport.pause(); await cancelled;
    await vi.waitFor(() => expect(f.readers[1].signal.aborted).toBe(true));
    const retired = { streaming: true, streamGeneration: 2, position: 77, playing: true, ended: true };
    expect(f.sessions[0].live.observe(retired)).toBe(false);
    expect(f.transport.paused).toBe(true); expect(f.transport.error).toBeNull(); expect(f.transport.ended).toBe(false);
    const currentPlay = f.transport.play(); await vi.waitFor(() => expect(f.readers).toHaveLength(3));
    await f.push(Math.ceil(350 * rate / 1000)); await currentPlay;
    expect(f.transport.paused).toBe(false); expect(f.transport.error).toBeNull();
});
