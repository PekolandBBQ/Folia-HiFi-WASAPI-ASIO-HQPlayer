import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Mock component RPC verifies host authority and ACK handling, not real HQPlayer decoding.
const require = createRequire(import.meta.url);
const { createHQPlayerComponentHost } = require('../../../electron/hqplayer/client.cjs');
const { createHQPlayerStreamAdapter } = require('../../../electron/nativeAudio/hqplayerStreamAdapter.cjs');
const { LIVE_PCM_TRANSPORT: transport } = require('../../../electron/nativeAudio/livePcmFormat.cjs');
const { installPreviewDiagnosticSink } = require('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { projectEvent } = require('../../../electron/debug/privatePreviewDiagnosticSchema.cjs');
const baseCapabilities = ['local-file', 'playback-control', 'dsp-settings', 'single-instance', 'launch-options', 'pcm-streaming', 'pcm32-named-pipe'];
const pipe = 'folia-audio-01234567-89ab-cdef-0123-456789abcdef';
const spec = { session: 'live', sourceKind: 'spotify-live', sampleRate: 44100, channels: 2, bits32: true,
    pipeName: `\\\\.\\pipe\\${pipe}`, transport };
const deferred = <T = any>() => { let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture({ version = '0.1.4-preview.6', capability = true, releaseCapability = true } = {}) {
    let generation = 0, event: (value: any) => void = () => {};
    const reply = (extra = {}) => ({ session: 'live', generation, pipeName: spec.pipeName, transport,
        ready: false, receiverInput: null, ...extra });
    const request = vi.fn(async (action: string, _payload: any): Promise<any> => {
        if (action === 'hello') return { id: 'hqplayer', protocolMajor: 1, componentVersion: version,
            capabilities: [...baseCapabilities, ...(capability ? ['live-pcm-s32le-v1'] : []), ...(releaseCapability ? ['confirmed-stop-owner-v1'] : [])] };
        if (action === 'stream-prepare' || action === 'stream-reset') { generation++; return reply(); }
        if (action === 'stream-status') return reply();
        return { ok: true };
    });
    const rpc = { request, dispose: vi.fn(async () => {}) };
    const manager = { status: async () => ({ available: true, version, executable: 'verified-preview.cjs' }) };
    const host = createHQPlayerComponentHost({ manager, rpcFactory: (_path: string, options: any) => { event = options.onEvent; return rpc; } });
    cleanups.push(() => host.dispose());
    return { host, request, reply, event: (value: any) => event(value) };
}

it.each([{ version: '0.1.4-preview.3' }, { version: '0.1.4-preview.4' }, { version: '0.1.4-preview.5' }, { version: '0.1.4-preview.7' }, { capability: false }, { releaseCapability: false }])
('requires the exact component version and live contract capability: %j', async options => {
    const f = fixture(options);
    expect(await f.host.supportsStreaming({ sourceKind: 'spotify-live' })).toBe(false);
    await expect(f.host.streamPrepare(spec)).rejects.toMatchObject({ code: 'HQPLAYER_RAW_FORMAT_UNVERIFIED' });
    expect(f.request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
});

it.each([undefined, null, {}, { ...transport, sampleFormat: 'f32le' }, { ...transport, framing: 'wav' },
    { ...transport, sampleRate: 48000 }, { ...transport, frameBytes: 4 }, { ...transport, channels: '2' },
    { ...transport, originalSourceVerified: true }])('rejects absent or malformed expected transport %j', async value => {
    const f = fixture();
    await expect(f.host.streamPrepare({ ...spec, transport: value })).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    expect(f.request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
});

it('accepts the independently observed matching input and passes only the exact wire descriptor', async () => {
    const f = fixture(); await f.host.streamPrepare(spec);
    expect(f.request).toHaveBeenCalledWith('stream-prepare', { args: [expect.objectContaining({ transport })] });
    expect(f.request.mock.calls.find(([action]) => action === 'stream-prepare')?.[1].args[0]).not.toHaveProperty('sourceKind');
    f.request.mockResolvedValueOnce(f.reply({ ready: true, receiverInput: { sampleRate: 44100, channels: 2, containerBits: 32 },
        state: { sampleRate: 705600, bitDepth: 32 } }));
    expect(await f.host.streamStatus('live', 1)).toMatchObject({ ready: true,
        receiverInput: { sampleRate: 44100, channels: 2, containerBits: 32 } });
});

it.each([{ ready: true, receiverInput: null }, { ready: true, receiverInput: { sampleRate: 705600, channels: 2, containerBits: 32 } },
    { ready: true, receiverInput: { sampleRate: 44100, channels: 2, containerBits: 24 } },
    { transport: { ...transport, sampleFormat: 'f32le' } }])('rejects false readiness or changed receiver format %j', async change => {
    const f = fixture(); await f.host.streamPrepare(spec);
    f.request.mockResolvedValueOnce(f.reply(change));
    await expect(f.host.streamStatus('live', 1)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
});

it.each([{ session: 'old' }, { generation: 2 }, { pipeName: 'another-pipe' }])('rejects mismatched reply identity %j', async change => {
    const f = fixture(); await f.host.streamPrepare(spec); f.request.mockResolvedValueOnce(f.reply(change));
    await expect(f.host.streamStatus('live', 1)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.request).toHaveBeenCalledWith('stream-close', { args: ['live'] });
    await expect(f.host.streamStatus('live', 1)).rejects.toMatchObject({ code: 'CANCELLED' });
});

it('rejects a generation-one status that completes after reset creates generation two', async () => {
    const f = fixture(); await f.host.streamPrepare(spec);
    const wait = deferred(), old = f.reply(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation((action, payload) => action === 'stream-status' ? wait.promise : original(action, payload));
    const pending = f.host.streamStatus('live', 1), rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.request.mock.calls.some(([action]) => action === 'stream-status')).toBe(true));
    expect(await f.host.streamReset({ ...spec, generation: 1 })).toMatchObject({ generation: 2 });
    wait.resolve(old); await rejected;
    await expect(f.host.streamReset({ ...spec, generation: 1 })).rejects.toMatchObject({ code: 'CANCELLED' });
});

it('requires a fresh reset descriptor and an explicit current generation', async () => {
    const f = fixture(); await f.host.streamPrepare(spec);
    await expect(f.host.streamReset({ ...spec, transport: undefined, generation: 1 })).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    await expect(f.host.streamStatus('live')).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.host.streamReset(spec)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.request.mock.calls.some(([action]) => action === 'stream-reset')).toBe(false);
});

it('closes a malformed reset ACK from the still-current owner without retaining old authority', async () => {
    const f = fixture(); await f.host.streamPrepare(spec);
    f.request.mockResolvedValueOnce(f.reply({ generation: 2, pipeName: 'wrong-pipe' }));
    await expect(f.host.streamReset({ ...spec, generation: 1 })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.request).toHaveBeenCalledWith('stream-close', { args: ['live'] });
    await expect(f.host.streamStatus('live', 1)).rejects.toMatchObject({ code: 'CANCELLED' });
});

it.each(['stream-prepare', 'stream-reset'])('stop invalidates an in-flight %s and closes its current session', async action => {
    const f = fixture(); if (action === 'stream-reset') await f.host.streamPrepare(spec);
    const wait = deferred(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation((name, payload) => name === action ? wait.promise : original(name, payload));
    const pending = action === 'stream-prepare' ? f.host.streamPrepare(spec) : f.host.streamReset({ ...spec, generation: 1 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.request.mock.calls.some(([name]) => name === action)).toBe(true));
    await f.host.streamClose('live', action === 'stream-reset' ? 1 : undefined);
    expect(f.request).toHaveBeenCalledWith('stream-close', { args: ['live', undefined] });
    wait.resolve(f.reply({ generation: 2 })); await rejected;
    await expect(f.host.streamStatus('live', 2)).rejects.toMatchObject({ code: 'CANCELLED' });
});

it.each(['configure', 'load', 'crash'])('revokes normal live authority after %s', async action => {
    const f = fixture(); await f.host.streamPrepare(spec);
    if (action === 'crash') f.event({ event: 'error', errorCode: 'COMPONENT_CRASHED' });
    else if (action === 'load') await f.host.load({ session: 'file' });
    else await f.host.configure({});
    await expect(f.host.streamReset({ ...spec, generation: 1 })).rejects.toMatchObject({ code: 'CANCELLED' });
});

it('never uses renderer-supplied transport or a copied reader as main-owned reader authority', async () => {
    const f = fixture(), reader = Object.freeze({ transport });
    let valid = true;
    const source = { assertReader: (value: any) => { if (!valid || value !== reader) throw Object.assign(new Error('stale'), { code: 'CANCELLED' }); } };
    const current = { id: 'live', abort: new AbortController(), livePcmSource: source, hqplayerSpotifyExperiment: { enabled: false } };
    const adapter = createHQPlayerStreamAdapter({ current, hqplayer: f.host });
    const request = { action: 'stream-load', session: 'live', pipeName: pipe, sampleRate: 44100, channels: 2 };
    await expect(adapter.request({ ...request, transport, sourceKind: 'finite', allowUnverifiedRaw: true })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(adapter.request({ ...request, livePcmReader: { ...reader } })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
    await adapter.request({ ...request, livePcmReader: reader });
    valid = false;
    await expect(adapter.request({ action: 'status', session: 'live' })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.request.mock.calls.some(([action]) => action === 'stream-status')).toBe(false);
});

it('rejects a replaced reader after the HQ preparation await before it becomes playable', async () => {
    const f = fixture(), reader = Object.freeze({ transport }), wait = deferred();
    let valid = true;
    const source = { assertReader: (value: any) => { if (!valid || value !== reader) throw Object.assign(new Error('stale'), { code: 'CANCELLED' }); } };
    const current = { id: 'live', abort: new AbortController(), livePcmSource: source, connection: wait.promise };
    const adapter = createHQPlayerStreamAdapter({ current, hqplayer: f.host });
    const pending = adapter.request({ action: 'stream-load', session: 'live', pipeName: pipe, sampleRate: 44100, channels: 2, livePcmReader: reader });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' }); valid = false; wait.resolve(null); await rejected;
    expect(f.request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
});

it('closes newly prepared HQ output if the main reader is revoked while the component replies', async () => {
    const f = fixture(), reader = Object.freeze({ transport }); let valid = true;
    const source = { assertReader: (value: any) => { if (!valid || value !== reader) throw Object.assign(new Error('stale'), { code: 'CANCELLED' }); } };
    const current = { id: 'live', abort: new AbortController(), livePcmSource: source };
    const adapter = createHQPlayerStreamAdapter({ current, hqplayer: f.host }), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (action, payload) => {
        const reply = await original(action, payload); if (action === 'stream-prepare') valid = false; return reply;
    });
    await expect(adapter.request({ action: 'stream-load', session: 'live', pipeName: pipe, sampleRate: 44100, channels: 2,
        livePcmReader: reader })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.request).toHaveBeenCalledWith('stream-close', { args: ['live', undefined] });
    await expect(f.host.streamStatus('live', 1)).rejects.toMatchObject({ code: 'CANCELLED' });
});

it('keeps paused volume/replaygain/status usable but resumes playback only with a fresh reader generation', async () => {
    const f = fixture(); let valid = true, reader: any = Object.freeze({ transport });
    const source = { assertReader: (value: any) => { if (!valid || value !== reader) throw Object.assign(new Error('stale'), { code: 'CANCELLED' }); } };
    const current = { id: 'live', abort: new AbortController(), livePcmSource: source };
    const adapter = createHQPlayerStreamAdapter({ current, hqplayer: f.host });
    const load = { session: 'live', pipeName: pipe, sampleRate: 44100, channels: 2 };
    await adapter.request({ ...load, action: 'stream-load', livePcmReader: reader });
    await adapter.request({ action: 'pause', session: 'live' }); valid = false;
    for (const message of [{ action: 'volume', volume: 1 }, { action: 'replaygain', gain: 1 }, { action: 'gain', gainDb: -2 }, { action: 'status' }])
        await expect(adapter.request({ ...message, session: 'live' })).resolves.toMatchObject({ streamGeneration: 1 });
    await expect(adapter.request({ action: 'play', session: 'live' })).rejects.toMatchObject({ code: 'CANCELLED' });
    reader = Object.freeze({ transport: Object.freeze({ ...transport }) }); valid = true;
    await expect(adapter.request({ ...load, action: 'stream-reset', livePcmReader: reader })).resolves.toMatchObject({ streamGeneration: 2 });
    await expect(adapter.request({ action: 'play', session: 'live' })).resolves.toMatchObject({ streamGeneration: 2 });
    valid = false; await adapter.close();
    expect(f.request).toHaveBeenCalledWith('stream-close', { args: ['live', 2] });
});

it('records one actual HQ input acceptance per generation without original encoding or private fields', async () => {
    const events: any[] = [], uninstall = installPreviewDiagnosticSink({ enabled: () => true, record: (type: string, fields: any) => events.push({ type, fields }) });
    try {
        const f = fixture(); await f.host.streamPrepare(spec); expect(events).toEqual([]);
        const ready = () => f.reply({ ready: true, receiverInput: { sampleRate: 44100, channels: 2, containerBits: 32 },
            state: { sampleRate: 705600 }, trackId: 'SECRET', url: 'SECRET', samples: [1, 2] });
        f.request.mockResolvedValueOnce(ready()); await f.host.streamStatus('live', 1);
        f.request.mockResolvedValueOnce(ready()); await f.host.streamStatus('live', 1);
        expect(events).toEqual([{ type: 'native.hq-input', fields: { phase: 'accepted', sessionRef: 1, generation: 1,
            inputSampleRate: 44100, inputChannels: 2, inputContainerBits: 32 } }]);
        await f.host.streamReset({ ...spec, generation: 1 });
        f.request.mockResolvedValueOnce(ready()); await f.host.streamStatus('live', 2);
        expect(events).toHaveLength(2); expect(events[1].fields.generation).toBe(2);
        expect(JSON.stringify(events)).not.toMatch(/SECRET|705600|source|samples/);
    } finally { uninstall(); }
});

it('whitelists rejected input diagnostics and never substitutes expected values for an absent actual input', async () => {
    const events: any[] = [], uninstall = installPreviewDiagnosticSink({ enabled: () => true, record: (type: string, fields: any) => events.push({ type, fields }) });
    try {
        const f = fixture(); await f.host.streamPrepare(spec);
        f.request.mockResolvedValueOnce(f.reply({ ready: true, receiverInput: null }));
        await expect(f.host.streamStatus('live', 1)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
        expect(events[0]).toEqual({ type: 'native.hq-input', fields: { sessionRef: 1, generation: 1, phase: 'rejected', errorCode: 'FORMAT_UNSUPPORTED' } });
        expect(projectEvent('native.hq-input', { sessionRef: 1, generation: 1, phase: 'accepted', inputSampleRate: Infinity,
            inputChannels: -1, inputContainerBits: '32', transport, token: 'SECRET', uri: 'SECRET' }).fields)
            .toEqual({ sessionRef: 1, generation: 1, phase: 'accepted' });
    } finally { uninstall(); }
});

it('preserves actual rejected playlist input once while ignoring premature acceptance and stale component diagnostics', async () => {
    const events: any[] = [], uninstall = installPreviewDiagnosticSink({ enabled: () => true, record: (type: string, fields: any) => events.push({ type, fields }) });
    try {
        const f = fixture(); await f.host.streamPrepare(spec);
        const detail = { event: 'live-pcm-input', session: 'live', generation: 1, phase: 'accepted',
            inputSampleRate: 48000, inputChannels: 2, inputContainerBits: 24, uri: 'SECRET' };
        f.event({ event: 'diagnostic', detail }); expect(events).toEqual([]);
        f.event({ event: 'diagnostic', detail: { ...detail, phase: 'rejected', session: 'old' } });
        f.event({ event: 'diagnostic', detail: { ...detail, phase: 'rejected', generation: 9 } }); expect(events).toEqual([]);
        f.event({ event: 'diagnostic', detail: { ...detail, phase: 'rejected' } });
        f.request.mockResolvedValueOnce(f.reply({ errorCode: 'FORMAT_UNSUPPORTED' }));
        await expect(f.host.streamStatus('live', 1)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
        expect(events).toEqual([{ type: 'native.hq-input', fields: { sessionRef: 1, generation: 1, phase: 'rejected',
            errorCode: 'FORMAT_UNSUPPORTED', inputSampleRate: 48000, inputChannels: 2, inputContainerBits: 24 } }]);
    } finally { uninstall(); }
});


it.each([{ version: '0.1.4-preview.4' }, { releaseCapability: false }])('raw experiment cannot bypass confirmed Stop ownership: %j', async options => {
    const f = fixture(options);
    expect(await f.host.supportsStreaming({ sourceKind: 'spotify-live', allowUnverifiedRaw: true })).toBe(false);
    await expect(f.host.streamPrepare({ session: 'manual', sourceKind: 'spotify-live' }, { allowUnverifiedRaw: true }))
        .rejects.toMatchObject({ code: 'HQPLAYER_RAW_FORMAT_UNVERIFIED' });
    expect(f.request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
});
