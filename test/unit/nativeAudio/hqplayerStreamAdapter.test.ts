import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// The adapter reuses the native progressive decoder contract without installing or launching WASAPI/ASIO.
const { createHQPlayerStreamAdapter } = createRequire(import.meta.url)('../../../electron/nativeAudio/hqplayerStreamAdapter.cjs');
const pipeName = 'folia-audio-01234567-89ab-cdef-0123-456789abcdef';
function fixture() {
    const current = { id: 'hq-stream', abort: new AbortController(), durationHint: 180, hqplayerGainDb: -2,
        trackKey: 'song', hqplayerDefaults: { mode: 1 }, sourceInfo: { sourceBitsPerSample: 24 } };
    let generation = 1, position = 12, playing = false;
    const status = () => ({ session: current.id, generation, ready: true, bufferedSeconds: 0.7, durationHint: 180,
        producerComplete: false, state: { position, duration: 180, playing, ended: false }, pipeName: `\\\\.\\pipe\\${pipeName}` });
    const hqplayer = { supportsStreaming: vi.fn(async () => true),
        streamPrepare: vi.fn(async () => ({ ...status(), ready: false, state: null })),
        streamStatus: vi.fn(async () => status()),
        streamReset: vi.fn(async (spec: any) => { generation++; position = spec.position0; playing = false; return status(); }),
        streamClose: vi.fn(async () => ({ ok: true })), command: vi.fn(async (_session: string, action: string) => {
            if (action === 'play') playing = true; if (action === 'pause') playing = false; return status().state;
        }) };
    return { current, hqplayer, adapter: createHQPlayerStreamAdapter({ hqplayer, current }) };
}
it('passes source metadata, settings, private pipe and checkpoints to HQ preparation', async () => {
    const { adapter, current, hqplayer } = fixture();
    const state = await adapter.request({ action: 'stream-load', session: current.id, sampleRate: 96000, channels: 2,
        pipeName, position: 12, duration: 180 });
    expect(hqplayer.streamPrepare).toHaveBeenCalledWith(expect.objectContaining({ session: current.id,
        sourceKind: 'finite', sampleRate: 96000, channels: 2, bits32: true, position0: 12, durationHint: 180,
        pipeName: `\\\\.\\pipe\\${pipeName}`, gainDb: -2, defaults: current.hqplayerDefaults, sourceBitsPerSample: 24 }), { allowUnverifiedRaw: false });
    expect(state).toMatchObject({ backend: 'hqplayer', streaming: true, streamGeneration: 1, ready: false, pipeName });
    expect(state.bufferedEnd).toBe(state.position);
    expect(await adapter.request({ action: 'status', session: current.id })).toMatchObject({ position: 12, bufferedStart: 12, bufferedEnd: 12.7 });
});
it('keeps play intent explicit when resetting a paused source and maps all gain controls', async () => {
    const { adapter, current, hqplayer } = fixture();
    await adapter.request({ action: 'stream-load', session: current.id, sampleRate: 44100, channels: 2, pipeName, position: 12 });
    const reset = await adapter.request({ action: 'stream-reset', session: current.id, sampleRate: 44100, channels: 2, pipeName, position: 65 });
    expect(reset).toMatchObject({ position: 65, playing: false, streamGeneration: 2 });
    expect(hqplayer.streamReset).toHaveBeenCalledWith(expect.objectContaining({ defaults: undefined }));
    expect(hqplayer.command).not.toHaveBeenCalled();
    expect(hqplayer.streamReset.mock.calls[0][0].gainDb).toBeUndefined();
    for (const action of [{ action: 'play' }, { action: 'pause' }, { action: 'volume', volume: 0.6 },
        { action: 'replaygain', gain: 0.8 }, { action: 'gain', gainDb: -5 }]) await adapter.request({ ...action, session: current.id });
    expect(hqplayer.command).toHaveBeenCalledWith(current.id, 'volume', 0.6);
    expect(hqplayer.command).toHaveBeenCalledWith(current.id, 'replaygain', 0.8);
    expect(hqplayer.command).toHaveBeenCalledWith(current.id, 'gain', -5);
    await adapter.close(); expect(hqplayer.streamClose).toHaveBeenCalledWith(current.id, 2);
});
it('rejects stale sessions, unsafe pipe names and an obsolete status reply after cancellation', async () => {
    const { adapter, current, hqplayer } = fixture();
    await expect(adapter.request({ action: 'status', session: 'old' })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(adapter.request({ action: 'stream-load', session: current.id, pipeName: 'other-private-pipe' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    hqplayer.streamStatus.mockImplementationOnce(async () => { current.abort.abort(); return {} as any; });
    await expect(adapter.request({ action: 'status', session: current.id })).rejects.toMatchObject({ code: 'CANCELLED' });
    await adapter.close(); expect(hqplayer.streamClose).toHaveBeenCalledOnce();
});
it('surfaces stream preparation failures using fixed public error codes', async () => {
    const { adapter, current, hqplayer } = fixture();
    hqplayer.streamStatus.mockResolvedValueOnce({ errorCode: 'DECODE_FAILED' } as any);
    await expect(adapter.request({ action: 'status', session: current.id })).rejects.toMatchObject({ code: 'DECODE_FAILED' });
});
it('counts decoded PCM already held inside HQPlayer even when the HTTP queue is empty', async () => {
    const { adapter, current, hqplayer } = fixture();
    hqplayer.streamStatus.mockResolvedValueOnce({ ready: true, position0: 12, decodedSeconds: 1,
        bufferedSeconds: 0, state: { position: 12.25, playing: true } } as any);
    expect(await adapter.request({ action: 'status', session: current.id })).toMatchObject({ bufferedStart: 12.25, bufferedEnd: 13 });
});
it.each([false, true])('derives the finite/live category only from the main-owned source (live=%s)', async live => {
    const { adapter, current, hqplayer } = fixture();
    Object.assign(current, { livePcmSource: live ? {} : null, hqplayerSpotifyExperiment: { enabled: true } });
    await adapter.request({ action: 'stream-load', session: current.id, sampleRate: 44100, channels: 2, pipeName,
        sourceKind: live ? 'finite' : 'spotify-live', allowUnverifiedRaw: !live });
    expect(hqplayer.streamPrepare).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: live ? 'spotify-live' : 'finite' }),
        { allowUnverifiedRaw: live });
    await adapter.request({ action: 'stream-reset', session: current.id, sampleRate: 44100, channels: 2, pipeName,
        sourceKind: live ? 'finite' : 'spotify-live' });
    expect(hqplayer.streamReset).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: live ? 'spotify-live' : 'finite' }));
    await adapter.supportsStreaming();
    if (live) expect(hqplayer.supportsStreaming).toHaveBeenCalledWith({ sourceKind: 'spotify-live', allowUnverifiedRaw: true });
    else expect(hqplayer.supportsStreaming).toHaveBeenCalledWith();
});
