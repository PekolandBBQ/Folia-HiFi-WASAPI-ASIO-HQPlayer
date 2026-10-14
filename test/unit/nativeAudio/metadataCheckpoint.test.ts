import { afterEach, expect, it, vi } from 'vitest';
import { NativeAudioTransport } from '../../../src/services/nativeAudio/NativeAudioTransport';
import { applyPlaybackMetadataCheckpoint } from '../../../src/services/nativeAudio/metadataCheckpoint';
import type { NativeAudioApi, NativeAudioState } from '../../../src/types/nativeAudio';

// test/unit/nativeAudio/metadataCheckpoint.test.ts — exercise real transport intents and IPC commands at metadata arrival.
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../../src/services/nativeAudio/loadOnlineSource', () => ({ loadNativeOnlineSource: mocks.load }));
const transports: NativeAudioTransport[] = [];
afterEach(() => { transports.splice(0).forEach(audio => audio.dispose()); vi.clearAllMocks(); });

async function nativeFixture(position = 0) {
    let state: NativeAudioState = { session: '', position, duration: 120, playing: false, ended: false,
        streaming: true, buffering: false, bufferedStart: position, bufferedEnd: position + 0.5,
        producerComplete: false, sampleRate: 44100, channels: 2, latency: 0,
        backend: 'wasapi-exclusive', deviceId: 'test' };
    const request = vi.fn(async (input: Parameters<NativeAudioApi['request']>[0]) => {
        if (input.action === 'stop') return {};
        if (input.action === 'seek') state = { ...state, position: input.position! };
        if (input.action === 'play') state = { ...state, playing: true };
        return { ...state };
    });
    mocks.load.mockImplementation(async (_api, session) => { state = { ...state, session }; return { ...state }; });
    const audio = new NativeAudioTransport({ supported: true, request, onEvent: () => () => {} },
        'wasapi-exclusive', 'test', 'compatibility', async () => null);
    transports.push(audio);
    audio.setSource('https://example.test/stream');
    await vi.waitFor(() => expect(audio.readyState).toBeGreaterThan(0));
    return { audio, request };
}

it('keeps initial PCM preparation and Play intact when metadata restores the same zero position', async () => {
    const { audio, request } = await nativeFixture();
    applyPlaybackMetadataCheckpoint(audio.asMediaElement(), 0, false);
    await audio.play();
    expect(request.mock.calls.some(([input]) => input.action === 'seek')).toBe(false);
    expect(audio.error).toBeNull();
    expect(audio.paused).toBe(false);
});

it('applies a different native resume position without turning a paused session into Play', async () => {
    const { audio, request } = await nativeFixture();
    applyPlaybackMetadataCheckpoint(audio.asMediaElement(), 37, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 37 })));
    expect(audio.paused).toBe(true);
});

it('leaves the pending output transfer in charge of its position', async () => {
    const { audio, request } = await nativeFixture(20);
    applyPlaybackMetadataCheckpoint(audio.asMediaElement(), 37, true);
    expect(audio.getOutputPosition()).toBe(20);
    expect(request.mock.calls.some(([input]) => input.action === 'seek')).toBe(false);
});

it('retains ordinary browser metadata positioning', () => {
    const audio = { currentTime: 20 } as HTMLAudioElement;
    applyPlaybackMetadataCheckpoint(audio, 37, false);
    expect(audio.currentTime).toBe(37);
});
