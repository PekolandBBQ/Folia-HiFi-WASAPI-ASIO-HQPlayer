import { releasePlaybackProviderOutputs } from '@/services/playbackProviderOutput';
import { afterEach, expect, it, vi } from 'vitest';
import { createSoloistBrowserApi } from '@/services/onlineMusic/SoloistBrowserTransport';
import type { NativeAudioEvent, NativeAudioState } from '@/types/nativeAudio';

// test/unit/onlineMusic/soloistBrowserTransport.test.ts: consumed-frame clocks and renderer control cancellation.
const session = '11111111-1111-4111-8111-111111111111';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });
function fixture(chunks = 20, beforeOutputExit = () => {}) {
    const nodes: any[] = []; let producerGeneration = 0, pulled = 0;
    const suspend = vi.fn(async () => {}), resume = vi.fn(async () => {}), close = vi.fn(async () => {}), module = vi.fn(async () => {});
    const value = { value: 1 }, gain = { gain: value, connect: vi.fn(() => gain), disconnect: vi.fn() };
    vi.stubGlobal('AudioContext', class { sampleRate = 44100; baseLatency = 0.01; destination = {}; resume = resume; suspend = suspend; close = close;
        audioWorklet = { addModule: module }; createGain() { return gain; } });
    vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: (_: any) => {}, postMessage: vi.fn() }; connect = vi.fn(() => gain); disconnect = vi.fn();
        constructor() { nodes.push(this); } });
    const bridge = { browserPcm: vi.fn(async (input: any) => {
        if (input.action === 'begin') return { generation: ++producerGeneration, durationMs: 60000 };
        if (input.action === 'start') { pulled = 0; return { generation: ++producerGeneration, positionMs: input.positionMs }; }
        if (input.action === 'position') return { generation: ++producerGeneration, positionMs: input.positionMs + 25 };
        if (input.action === 'pull') { const done = pulled++ >= chunks; return { generation: input.generation, data: new Uint8Array(done ? 0 : 65536), complete: done }; }
        return { paused: true };
    }) };
    const api = createSoloistBrowserApi(bridge, beforeOutputExit), events: NativeAudioEvent[] = [];
    api.onEvent(event => events.push(event)); cleanup.push(() => api.dispose());
    const request = (action: string, extra = {}) => api.request({ action, session, ...extra }) as Promise<NativeAudioState>;
    const ready = () => request('begin', { url: 'http://127.0.0.1/opaque', sourceMetadata: { requestedQuality: 'lossless', playbackTransport: 'soloist-pcm' } });
    const message = (frames: number) => {
        const node = nodes.at(-1), reset = node.port.postMessage.mock.calls.filter((call: any[]) => call[0].type === 'reset').at(-1)[0];
        node.port.onmessage({ data: { type: 'state', generation: reset.generation, frames } });
    };
    return { api, bridge, request, ready, events, nodes, message, value, close, module, suspend };
}
it('prepares without consuming audio, bounds outstanding PCM and advances only consumed frames', async () => {
    const f = fixture(); expect(await f.ready()).toMatchObject({ backend: 'browser', requestedQuality: 'lossless', position: 0, preparedSource: true, sourceEncodingVerified: false });
    expect(f.bridge.browserPcm.mock.calls.map(call => call[0].action)).toEqual(['begin']);
    expect(await f.request('play')).toMatchObject({ playing: true, buffering: true });
    await vi.waitFor(() => expect(f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'pull')).toHaveLength(4));
    expect((await f.request('status')).position).toBe(0);
    expect((await f.request('status')).bufferedEnd).toBeCloseTo(32768 / 44100);
    f.message(1024); expect((await f.request('status')).position).toBeCloseTo(1024 / 44100);
    // Stale/backward callback is ignored, including its implied buffering clock.
    f.message(512); expect((await f.request('status')).position).toBeCloseTo(1024 / 44100);
    expect(f.nodes[0].port.postMessage.mock.calls.filter((call: any[]) => call[0].type === 'block').every((call: any[]) => call[0].data.byteLength === 65536)).toBe(true);
});
it('reports received PCM before initialization and observed Web Audio rate and gain only after initialization', async () => {
    const f = fixture();
    const prepared = await f.ready();
    expect(prepared).toMatchObject({ preparedAudio: { representation: 's32le', sampleRate: 44100, bitDepth: 32, channels: 2 },
        sourceEncodingVerified: false, requestedQuality: 'lossless', outputRateReported: false, sampleRate: 0 });
    expect(prepared.sourceQuality).toBeUndefined(); expect(prepared.sourceSampleRate).toBeUndefined();
    expect(prepared.sourceBitsPerSample).toBeUndefined(); expect(prepared.outputFormat).toBeUndefined();
    expect(prepared.effectiveGain).toBeUndefined();
    const playing = await f.request('play');
    expect(playing).toMatchObject({ sampleRate: 44100, outputRateReported: true, outputFormat: 'Web Audio float32', effectiveGain: 1 });
    await f.request('volume', { volume: 0.5 });
    expect(await f.request('replaygain', { gain: 0.5 })).toMatchObject({ effectiveGain: 0.25 });
    expect(f.value.value).toBe(0.25);
    expect(await f.request('status')).toMatchObject({ sourceEncodingVerified: false });
});
it('pause flushes queued content while preserving the heard position and resumes from that checkpoint', async () => {
    const f = fixture(); await f.ready(); await f.request('play'); await vi.waitFor(() => expect(f.events.length).toBeGreaterThan(0));
    f.message(4096); const heard = (await f.request('status')).position;
    expect(await f.request('pause')).toMatchObject({ playing: false, position: heard, bufferedEnd: heard });
    await f.request('play');
    expect(f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'start').at(-1)?.[0].positionMs).toBe(Math.floor(heard * 1000));
});
it('paused seek reports the real confirmed origin without starting producer playback and applies gain locally', async () => {
    const f = fixture(); await f.ready();
    expect(await f.request('seek', { position: 12 })).toMatchObject({ position: 12.025, playing: false });
    expect(f.bridge.browserPcm.mock.calls.some(call => call[0].action === 'start' || call[0].action === 'pull')).toBe(false);
    await f.request('volume', { volume: 0.2 }); await f.request('replaygain', { gain: 2 }); await f.request('play');
    expect(f.value.value).toBe(0.4);
    expect(f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'start').at(-1)?.[0].positionMs).toBe(12025);
});
it('producer EOF keeps playing until the queued PCM is actually consumed', async () => {
    const f = fixture(1); await f.ready(); await f.request('play');
    await vi.waitFor(() => expect(f.events.at(-1)?.state?.producerComplete).toBe(true));
    expect(await f.request('status')).toMatchObject({ playing: true, ended: false });
    f.message(8192); expect(await f.request('status')).toMatchObject({ playing: false, ended: true });
    f.message(8192); expect(await f.request('status')).toMatchObject({ playing: false, ended: true });
    expect(f.nodes[0].port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'play', playing: false });
    expect(await f.request('play')).toMatchObject({ playing: true, ended: false, position: 0 });
    expect(f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'start').at(-1)?.[0].positionMs).toBe(0);
});
it('a stale main cancellation is an AbortError and a late old pull cannot fail the resumed stream', async () => {
    const f = fixture(); await f.ready();
    let release!: (value: any) => void;
    const original = f.bridge.browserPcm.getMockImplementation()!;
    f.bridge.browserPcm.mockImplementationOnce(original).mockImplementationOnce((input: any) => new Promise(resolve => { release = resolve; }));
    await f.request('play'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.request('pause'); await f.request('play');
    release({ spotifyError: { code: 'unavailable', message: 'Spotify: request-cancelled' } });
    await Promise.resolve(); await Promise.resolve();
    expect(f.events.filter(event => event.event === 'error')).toHaveLength(0); expect((await f.request('status')).playing).toBe(true);
});
it('overlapping playing seeks keep the latest target playing when the superseded position reply arrives late', async () => {
    const f = fixture(); await f.ready(); await f.request('play');
    let release!: (value: any) => void;
    const original = f.bridge.browserPcm.getMockImplementation()!;
    f.bridge.browserPcm.mockImplementation((input: any) => input.action === 'position' && input.positionMs === 12000
        ? new Promise(resolve => { release = resolve; }) : original(input));
    const earlier = f.request('seek', { position: 12 });
    const cancelled = expect(earlier).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
        expect(await f.request('seek', { position: 25 })).toMatchObject({ position: 25.025, playing: true });
        expect(f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'start').at(-1)?.[0].positionMs).toBe(25025);
    } finally { release({ generation: 3, positionMs: 12025 }); await cancelled; }
    expect(await f.request('status')).toMatchObject({ position: 25.025, playing: true });
    expect(f.events.filter(event => event.event === 'error')).toHaveLength(0);
});
it('a newer seek also keeps playback intent while the previous seek is waiting to restart audio', async () => {
    const f = fixture(); await f.ready(); await f.request('play');
    let release!: (value: any) => void;
    const original = f.bridge.browserPcm.getMockImplementation()!;
    f.bridge.browserPcm.mockImplementation((input: any) => input.action === 'start' && input.positionMs === 12025
        ? new Promise(resolve => { release = resolve; }) : original(input));
    const earlier = f.request('seek', { position: 12 });
    const cancelled = expect(earlier).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try { expect(await f.request('seek', { position: 25 })).toMatchObject({ position: 25.025, playing: true }); }
    finally { release({ generation: 4, positionMs: 12025 }); await cancelled; }
    expect(await f.request('status')).toMatchObject({ position: 25.025, playing: true });
});
it('explicit play replaces the paused intent of an older seek before the next seek starts', async () => {
    const f = fixture(); await f.ready();
    let release!: (value: any) => void;
    const original = f.bridge.browserPcm.getMockImplementation()!;
    f.bridge.browserPcm.mockImplementation((input: any) => input.action === 'position' && input.positionMs === 12000
        ? new Promise(resolve => { release = resolve; }) : original(input));
    const earlier = f.request('seek', { position: 12 });
    const cancelled = expect(earlier).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
        expect(await f.request('play')).toMatchObject({ playing: true });
        expect(await f.request('seek', { position: 25 })).toMatchObject({ position: 25.025, playing: true });
    } finally { release({ generation: 2, positionMs: 12025 }); await cancelled; }
    expect(await f.request('status')).toMatchObject({ position: 25.025, playing: true });
});
it.each(['paused', 'pause', 'stop', 'begin', 'dispose'])('overlapping seeks cannot resume playback after %s', async interruption => {
    const f = fixture(); await f.ready();
    const nextSession = '22222222-2222-4222-8222-222222222222';
    if (interruption !== 'paused') await f.request('play');
    let release!: (value: any) => void;
    const original = f.bridge.browserPcm.getMockImplementation()!;
    f.bridge.browserPcm.mockImplementation((input: any) => input.action === 'position' && input.positionMs === 12000
        ? new Promise(resolve => { release = resolve; }) : original(input));
    const earlier = f.request('seek', { position: 12 });
    const cancelled = expect(earlier).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const starts = f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'start').length;
    try {
        if (interruption === 'dispose') f.api.dispose();
        else if (interruption === 'begin') await f.request('begin', { session: nextSession, url: 'http://127.0.0.1/replacement' });
        else if (interruption !== 'paused') await f.request(interruption);
        if (!['dispose', 'stop'].includes(interruption))
            expect(await f.request('seek', { position: 25, session: interruption === 'begin' ? nextSession : session }))
                .toMatchObject({ position: 25.025, playing: false });
    } finally { release({ generation: 3, positionMs: 12025 }); await cancelled; }
    expect(f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'start')).toHaveLength(starts);
});
it('a failed seek does not carry its old playback intent into a later paused seek', async () => {
    const f = fixture(); await f.ready(); await f.request('play');
    const original = f.bridge.browserPcm.getMockImplementation()!;
    f.bridge.browserPcm.mockImplementation((input: any) => input.action === 'position' && input.positionMs === 12000
        ? Promise.reject(new Error('position-failed')) : original(input));
    await expect(f.request('seek', { position: 12 })).rejects.toThrow('position-failed');
    expect(await f.request('seek', { position: 25 })).toMatchObject({ position: 25.025, playing: false });
    expect(f.bridge.browserPcm.mock.calls.filter(call => call[0].action === 'start')).toHaveLength(1);
});

it('provider exit flushes and suspends browser output before main-owned recovery, while ordinary pause remains reusable', async () => {
    const f = fixture(); await f.ready(); await f.request('play');
    await f.request('pause'); expect(f.suspend).not.toHaveBeenCalled(); await f.request('play');
    let resolve!: () => void;
    f.suspend.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const exiting = releasePlaybackProviderOutputs('spotify');
    await vi.waitFor(() => expect(f.suspend).toHaveBeenCalledOnce());
    expect(f.nodes[0].port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'reset', playing: false });
    expect(f.bridge.browserPcm.mock.calls.filter(([input]) => input.action === 'stop')).toHaveLength(0);
    resolve(); await exiting;
    expect(f.bridge.browserPcm.mock.calls.filter(([input]) => input.action === 'stop')).toHaveLength(0);
    await releasePlaybackProviderOutputs('spotify');
    expect(f.bridge.browserPcm.mock.calls.filter(([input]) => input.action === 'stop')).toHaveLength(0);
});

it('marks a provider-exit pause before publishing it so the arriving song keeps its autoplay intent', async () => {
    const order: string[] = [], f = fixture(20, () => { order.push('programmatic'); });
    await f.ready(); await f.request('play');
    f.api.onEvent(event => { if (event.state?.playing === false) order.push('paused'); });
    await releasePlaybackProviderOutputs('spotify');
    expect(order.slice(0, 2)).toEqual(['programmatic', 'paused']);
});
