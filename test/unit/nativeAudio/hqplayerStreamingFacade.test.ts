import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Optional capabilities keep the published file-based component usable while protecting new streaming RPC.
const { createHQPlayerComponentHost } = createRequire(import.meta.url)('../../../electron/hqplayer/client.cjs');
const required = ['local-file', 'playback-control', 'dsp-settings', 'single-instance', 'launch-options'];
function fixture(streaming: boolean) {
    let emit: (event: unknown) => void = () => {};
    const version = streaming ? '0.1.4-preview.1' : '0.1.3';
    const request = vi.fn(async (action: string) => action === 'hello'
        ? { id: 'hqplayer', protocolMajor: 1, componentVersion: version,
            capabilities: [...required, ...(streaming ? ['pcm-streaming', 'pcm32-named-pipe'] : [])] } : { ok: true });
    const rpc = { request, dispose: vi.fn(async () => {}) };
    const manager = { status: vi.fn(async () => ({ available: true, version, executable: 'verified-component.cjs' })) };
    return { host: createHQPlayerComponentHost({ manager, rpcFactory: (_entry: string, options: any) => { emit = options.onEvent; return rpc; }, configPath: 'candidate-path.json' }), request, rpc, emit: (event: unknown) => emit(event) };
}
it('keeps old0.1.3 handshake and file loading compatible without claiming PCM streaming', async () => {
    const { host, request } = fixture(false);
    try {
        expect(await host.supportsStreaming()).toBe(false);
        await host.load({ session: 'old', filePath: 'song.flac' });
        expect(request).toHaveBeenCalledWith('load', { args: [{ session: 'old', filePath: 'song.flac' }] });
        await expect(host.streamPrepare({ session: 'old', sourceKind: 'finite' })).rejects.toMatchObject({ code: 'COMPONENT_INCOMPATIBLE' });
        expect(request.mock.calls.some(([action]) => action === 'stream-prepare')).toBe(false);
    } finally { await host.dispose(); }
});

it('forwards WAV request, range and close facts from the worker into the normal runtime log', async () => {
    const { host, emit } = fixture(true), info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const detail = { event: 'wav-http', phase: 'reader-close', session: 'owned-session', streamGeneration: 2,
        requestId: 4, status: 206, start: 44, end: 843, reason: 'peer-disconnected', sourceRetained: true, sentBytes: 800 };
    try {
        await host.supportsStreaming(); emit({ event: 'diagnostic', detail });
        expect(info).toHaveBeenCalledWith('[HQPlayer WAV HTTP]', JSON.stringify(detail));
    } finally { await host.dispose(); info.mockRestore(); }
});
it('preserves finite preview.3 streaming fields and generation controls without a live experiment waiver', async () => {
    const { host, request } = fixture(true);
    try {
        expect(await host.supportsStreaming()).toBe(true);
        const spec = { session: 'pcm', sampleRate: 96000, channels: 2, position0: 12.5, durationHint: 180 };
        await host.streamPrepare({ ...spec, sourceKind: 'finite' }); await host.streamStatus('pcm', 7);
        await host.streamReset({ ...spec, sourceKind: 'finite', generation: 7 }); await host.streamClose('pcm', 8);
        expect(request).toHaveBeenCalledWith('stream-prepare', { args: [spec] });
        expect(request).toHaveBeenCalledWith('stream-status', { args: ['pcm', 7] });
        expect(request).toHaveBeenCalledWith('stream-reset', { args: [{ ...spec, generation: 7 }] });
        expect(request).toHaveBeenCalledWith('stream-close', { args: ['pcm', 8] });
    } finally { await host.dispose(); }
});
it('does not start any worker solely to clean an inactive stream', async () => {
    const manager = { status: vi.fn() }, rpcFactory = vi.fn();
    const host = createHQPlayerComponentHost({ manager, rpcFactory });
    expect(await host.streamClose('cancelled', 1)).toEqual({ ok: true }); expect(rpcFactory).not.toHaveBeenCalled();
});


it('retries an unacknowledged component stream close after playback authority was revoked', async () => {
    const { host, request } = fixture(true);
    try {
        await host.streamPrepare({ session: 'retry', sourceKind: 'finite', sampleRate: 44100, channels: 2 });
        request.mockRejectedValueOnce({ code: 'HQPLAYER_COMMAND_REJECTED' });
        await expect(host.streamClose('retry', 7)).rejects.toMatchObject({ code: 'HQPLAYER_COMMAND_REJECTED' });
        await host.streamClose('retry', 7);
        expect(request.mock.calls.filter(([action]) => action === 'stream-close')).toHaveLength(2);
        await host.streamClose('retry', 7);
        expect(request.mock.calls.filter(([action]) => action === 'stream-close')).toHaveLength(2);
    } finally { await host.dispose(); }
});
