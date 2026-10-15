import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// hqplayerSpotifyExperiment.test.ts — settings, session authority and private numeric observations without audio or sockets.
const require = createRequire(import.meta.url);
const { createHQPlayerComponentHost } = require('../../../electron/hqplayer/client.cjs');
const { validateHQPlayerSpotifyExperiment, createHQPlayerExperimentDiagnostics } = require('../../../electron/nativeAudio/hqplayerSpotifyExperiment.cjs');
const { projectEvent } = require('../../../electron/debug/privatePreviewDiagnosticSchema.cjs');
afterEach(() => vi.restoreAllMocks());
const settings = { enabled: true, prebufferMs: 2000, startupDelayMs: 1000 };
const required = ['local-file', 'playback-control', 'dsp-settings', 'single-instance', 'launch-options'];
function hostFixture(capabilities = ['pcm-streaming', 'pcm32-named-pipe']) {
    const request = vi.fn(async (action: string) => action === 'hello'
        ? { id: 'hqplayer', protocolMajor: 1, componentVersion: '0.1.4-preview.7', capabilities: [...required, 'confirmed-stop-owner-v1', ...capabilities] } : { ok: true });
    const rpc = { request, dispose: vi.fn(async () => {}) };
    const manager = { status: vi.fn(async () => ({ available: true, version: '0.1.4-preview.7', executable: 'unused.cjs' })) };
    const host = createHQPlayerComponentHost({ manager, rpcFactory: () => rpc, configPath: 'unused.json' });
    return { host, request, rpc, manager };
}

it('defaults off and copies only the exact bounded experiment fields', () => {
    expect(validateHQPlayerSpotifyExperiment()).toEqual({ enabled: false, prebufferMs: 350, startupDelayMs: 0 });
    const copy = validateHQPlayerSpotifyExperiment({ ...settings, privateUrl: 'SECRET' });
    expect(copy).toEqual(settings); expect(copy).not.toBe(settings);
});
it.each([null, true, {}, { ...settings, enabled: 1 }, { ...settings, prebufferMs: 99 }, { ...settings, prebufferMs: 2001 },
    { ...settings, prebufferMs: 350.5 }, { ...settings, prebufferMs: '350' }, { ...settings, startupDelayMs: NaN },
    { ...settings, startupDelayMs: -1 }, { ...settings, startupDelayMs: 1001 }, { ...settings, startupDelayMs: Infinity }])
('rejects malformed main-process experiment settings: %j', value => {
    expect(() => validateHQPlayerSpotifyExperiment(value)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});
it('requires opt-in only for unverified live preview.5 sources while finite streaming retains its own capability gate', async () => {
    const { host, request } = hostFixture();
    try {
        expect(await host.supportsStreaming()).toBe(true);
        expect(await host.supportsStreaming({ sourceKind: 'spotify-live' })).toBe(false);
        await expect(host.streamPrepare({ sourceKind: 'spotify-live', session: 'default' })).rejects.toMatchObject({ code: 'HQPLAYER_RAW_FORMAT_UNVERIFIED' });
        expect(request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
        expect(await host.supportsStreaming({ required: true, sourceKind: 'spotify-live', allowUnverifiedRaw: true })).toBe(true);
        await host.streamPrepare({ sourceKind: 'spotify-live', session: 'manual' }, { allowUnverifiedRaw: true });
        await host.streamStatus('manual', 1); await host.streamReset({ sourceKind: 'spotify-live', session: 'manual', generation: 1 });
        expect(await host.supportsStreaming()).toBe(true);
        expect(await host.supportsStreaming({ sourceKind: 'spotify-live' })).toBe(false);
        await expect(host.streamStatus('other', 1)).rejects.toMatchObject({ code: 'CANCELLED' });
        await expect(host.streamReset({ sourceKind: 'spotify-live', session: 'other' })).rejects.toMatchObject({ code: 'CANCELLED' });
        await host.streamClose('manual', 2);
        await expect(host.streamStatus('manual', 2)).rejects.toMatchObject({ code: 'CANCELLED' });
        await expect(host.streamReset({ sourceKind: 'spotify-live', session: 'manual', generation: 2 })).rejects.toMatchObject({ code: 'CANCELLED' });
        await host.streamPrepare({ sourceKind: 'finite', session: 'ordinary' });
        await host.streamStatus('ordinary', 1);
        await host.streamReset({ sourceKind: 'finite', session: 'ordinary', generation: 1 });
        await expect(host.streamReset({ sourceKind: 'spotify-live', session: 'ordinary', generation: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(request).toHaveBeenCalledWith('stream-close', { args: ['manual', 2] });
    } finally { await host.dispose(); }
});
it.each([{ capabilities: [] }, { capabilities: ['pcm-raw-identity-v1'] }, { capabilities: ['pcm-streaming'] }])('never invents missing component streaming capabilities: %j', async ({ capabilities }) => {
    const { host, request } = hostFixture(capabilities);
    try {
        await expect(host.streamPrepare({ sourceKind: 'spotify-live', session: 'manual' }, { allowUnverifiedRaw: true })).rejects.toMatchObject({ code: 'COMPONENT_INCOMPATIBLE' });
        expect(request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
    } finally { await host.dispose(); }
});
it('requires a main-owned source category and never lets finite sources borrow live opt-in', async () => {
    const { host, request } = hostFixture();
    try {
        for (const sourceKind of [undefined, null, 'renderer-claimed-live'])
            await expect(host.streamPrepare({ session: 'invalid', sourceKind })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(host.streamPrepare({ session: 'finite', sourceKind: 'finite' }, { allowUnverifiedRaw: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(host.supportsStreaming({ sourceKind: 'finite', allowUnverifiedRaw: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
        await host.streamPrepare({ session: 'live', sourceKind: 'spotify-live' }, { allowUnverifiedRaw: true });
        expect(request).toHaveBeenCalledWith('stream-prepare', { args: [{ session: 'live' }] });
        await expect(host.streamReset({ session: 'live', sourceKind: 'finite' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await host.streamReset({ session: 'live', sourceKind: 'spotify-live' });
        expect(request).toHaveBeenCalledWith('stream-reset', { args: [{ session: 'live' }] });
    } finally { await host.dispose(); }
});
it.each(['stop', 'load', 'shutdown', 'dispose', 'configure'])('revokes the prior live session on %s without leaving permission for reset', async action => {
    const { host, request } = hostFixture();
    try {
        await host.streamPrepare({ sourceKind: 'spotify-live', session: 'manual' }, { allowUnverifiedRaw: true });
        await host[action](action === 'load' ? { session: 'file', filePath: 'unused.flac' } : 'manual');
        await expect(host.streamReset({ sourceKind: 'spotify-live', session: 'manual' })).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(request.mock.calls.some(([name]) => name === 'stream-reset')).toBe(false);
    } finally { await host.dispose(); }
});
it('cannot reactivate an opt-in after a late preparation reply following stop', async () => {
    const { host, request } = hostFixture();
    let resolve!: (value: object) => void;
    const response = new Promise<object>(done => { resolve = done; });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async action => action === 'stream-prepare' ? response as any : original(action));
    try {
        const pending = host.streamPrepare({ sourceKind: 'spotify-live', session: 'manual' }, { allowUnverifiedRaw: true });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(true));
        await host.stop('manual'); resolve({ ok: true }); await rejected;
        await expect(host.streamReset({ sourceKind: 'spotify-live', session: 'manual' })).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally { resolve({}); await host.dispose(); }
});
it('separates actual component queue from decoded lead and counts buffering, not DAC underruns', () => {
    let now = 0;
    const events: any[] = [];
    const observed = createHQPlayerExperimentDiagnostics({ current: { id: 'SECRET_SESSION' }, source: { sampleRate: 44100, channels: 2 },
        settings, clock: () => now, enabled: () => true, publish: (type: string, fields: object) => events.push(projectEvent(type, fields)) });
    observed.observe('configured');
    expect(events[0].fields.componentReady).toBeUndefined(); expect(events[0].fields.buffering).toBeUndefined();
    now = 100; observed.input(35280); now = 200; observed.input(35280);
    now = 2000;
    observed.observe('ready', { bufferedEnd: 2, position: 0, streamQueuedSeconds: 0.6, bufferCapacityBytes: 1058400 },
        { prebufferWaitMs: 1000, startupWaitMs: 1000 });
    expect(events.at(-1).fields).toMatchObject({ phase: 'ready', generation: 1, prebufferMs: 2000, startupDelayMs: 1000,
        inputBytes: 70560, pipeInputBytesPerSecond: 35280, pipeInputMaxGapMs: 1800, estimatedBufferedMs: 2000, queueDepthMs: 600,
        prebufferWaitMs: 1000, startupWaitMs: 1000, pcmFormat: 's32le' });
    for (let index = 0; index < 100; index++) observed.observe(index % 2 ? 'sample' : 'buffering', { buffering: index % 2 === 0, playing: true });
    expect(events).toHaveLength(2);
    now = 3000; observed.finish(); observed.finish();
    expect(events.at(-1).fields.bufferingEvents).toBe(50);
    expect(JSON.stringify(events)).not.toMatch(/SECRET|underrun|rawSample|http|token|filePath/);
});
it('diagnostics omit extra data and invalid measurements, and remain inert when disabled', () => {
    const safe = projectEvent('native.hq-experiment', { phase: 'ready', queueDepthMs: Infinity, inputBytes: -1,
        pcmFormat: 'SECRET', prebufferMs: 5001, startupDelayMs: 1001, url: 'SECRET', samples: new Int32Array([5]) });
    expect(safe.fields).toEqual({ phase: 'ready' });
    const publish = vi.fn();
    const observed = createHQPlayerExperimentDiagnostics({ current: {}, source: {}, settings, enabled: () => false, publish });
    observed.observe('configured'); observed.input(65536); observed.observe('ready'); observed.finish();
    expect(publish).not.toHaveBeenCalled();
});
