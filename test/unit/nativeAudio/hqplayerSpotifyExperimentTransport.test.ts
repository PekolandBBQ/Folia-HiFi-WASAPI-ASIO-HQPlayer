import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioTransport } from '../../../src/services/nativeAudio/NativeAudioTransport';
import { loadNativeOnlineSource } from '../../../src/services/nativeAudio/loadOnlineSource';
import { useHQPlayerSettingsStore } from '../../../src/stores/useHQPlayerSettingsStore';
import { usePlaybackLoadStore } from '../../../src/stores/usePlaybackLoadStore';
import { HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS as defaults } from '../../../src/utils/hqplayerSpotifyExperiment';
import type { NativeAudioApi, NativeAudioBackend, NativeAudioEvent, NativeAudioState } from '../../../src/types/nativeAudio';

// test/unit/nativeAudio/hqplayerSpotifyExperimentTransport.test.ts — begin-time opt-in never becomes an automatic restart or live settings command.
const dispose: Array<() => void> = [];
beforeEach(() => { useHQPlayerSettingsStore.setState({ spotifyExperiment: { ...defaults } }); });
afterEach(() => {
    dispose.splice(0).forEach(cleanup => cleanup());
    usePlaybackLoadStore.setState({ owner: '', startedAt: 0, progress: null });
    vi.unstubAllGlobals();
});
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function fixture(backend: NativeAudioBackend = 'hqplayer', getFile: () => Promise<File | null> = async () => null) {
    let state: NativeAudioState = { session: '', position: 0, duration: 60, playing: false, ended: false,
        streaming: true, bufferedStart: 0, bufferedEnd: 2, producerComplete: false, buffering: false,
        sampleRate: 48000, channels: 2, latency: 0, backend, deviceId: 'test' };
    let listener: (event: NativeAudioEvent) => void = () => {};
    const request = vi.fn(async (input: Parameters<NativeAudioApi['request']>[0]) => {
        if (input.action === 'begin') state = { ...state, session: input.session!, position: 0, playing: false };
        if (input.action === 'play') state = { ...state, playing: true };
        if (input.action === 'pause') state = { ...state, playing: false };
        return { ...state };
    });
    const api: NativeAudioApi = { supported: true, request, onEvent: receive => { listener = receive; return () => {}; } };
    const transport = new NativeAudioTransport(api, backend, 'test', 'compatibility', getFile);
    dispose.push(() => transport.dispose());
    return { transport, api, request, progress: (progress: NativeAudioEvent['progress']) => listener({ event: 'progress', session: state.session, progress }) };
}

describe('HQPlayer Spotify experiment renderer contract', () => {
    it('forwards a disabled default, stays paused during preparation, and only plays on the explicit call', async () => {
        const { transport, request } = fixture();
        transport.setSource('https://example.com/spotify-live'); await flush();
        expect(request.mock.calls[0][0]).toMatchObject({ action: 'begin', hqplayerSpotifyExperiment: defaults });
        expect(transport.paused).toBe(true);
        expect(request.mock.calls.some(([input]) => input.action === 'play')).toBe(false);
        await transport.play();
        expect(request.mock.calls.filter(([input]) => input.action === 'play')).toHaveLength(1);
    });
    it('snapshots opt-in and timings before an asynchronous prepare, including subsequent setting changes', async () => {
        let resolve!: (file: File | null) => void;
        const file = new Promise<File | null>(ready => { resolve = ready; });
        const { transport, request } = fixture('hqplayer', () => file);
        useHQPlayerSettingsStore.getState().setSpotifyExperiment({ enabled: true, prebufferMs: 1250, startupDelayMs: 600 });
        transport.setSource('https://example.com/spotify-live');
        useHQPlayerSettingsStore.getState().resetSpotifyExperiment();
        resolve(null); await flush();
        expect(request.mock.calls[0][0]).toMatchObject({ hqplayerSpotifyExperiment: { enabled: true, prebufferMs: 1250, startupDelayMs: 600 } });
        expect(transport.paused).toBe(true);
    });
    it('keeps an active session unchanged after disabling or resetting, and uses new values only after explicit reprepare', async () => {
        const { transport, request } = fixture();
        useHQPlayerSettingsStore.getState().setSpotifyExperiment({ enabled: true, prebufferMs: 1500, startupDelayMs: 500 });
        transport.setSource('https://example.com/spotify-live'); await transport.play();
        const count = request.mock.calls.length;
        useHQPlayerSettingsStore.getState().setSpotifyExperiment({ enabled: false, prebufferMs: 2000 });
        useHQPlayerSettingsStore.getState().resetSpotifyExperiment(); await flush();
        expect(request.mock.calls).toHaveLength(count);
        expect(transport.paused).toBe(false);
        transport.pause(); await flush(); await transport.play();
        expect(request.mock.calls.filter(([input]) => input.action === 'begin')).toHaveLength(1);
        transport.setSource(''); transport.setSource('https://example.com/spotify-live'); await flush();
        const begins = request.mock.calls.filter(([input]) => input.action === 'begin');
        expect(begins).toHaveLength(2);
        expect(begins[1][0].hqplayerSpotifyExperiment).toEqual(defaults);
        expect(transport.paused).toBe(true);
        expect(request.mock.calls.filter(([input]) => input.action === 'play')).toHaveLength(2);
    });
    it.each(['asio', 'wasapi-exclusive', 'browser'] as const)('never sends experiment configuration to %s', async backend => {
        const { transport, request } = fixture(backend);
        useHQPlayerSettingsStore.getState().setSpotifyExperiment({ enabled: true, prebufferMs: 2000, startupDelayMs: 1000 });
        transport.setSource('https://example.com/spotify-live'); await flush();
        expect(request.mock.calls[0][0]).not.toHaveProperty('hqplayerSpotifyExperiment');
    });
    it('normalizes corrupt runtime input before strict main-process validation', async () => {
        const { api, request } = fixture();
        await loadNativeOnlineSource(api, 'test', 'https://example.com/spotify-live', 'hqplayer', 'test',
            new AbortController().signal, 'compatibility', -2, undefined, false,
            { enabled: 'true', prebufferMs: Infinity, startupDelayMs: 300.7 } as never);
        expect(request.mock.calls[0][0].hqplayerSpotifyExperiment).toEqual({ enabled: false, prebufferMs: 350, startupDelayMs: 301 });
    });
    it('keeps additional startup waiting in milliseconds without inventing progress bytes', async () => {
        const { transport, progress } = fixture();
        transport.setSource('https://example.com/spotify-live'); await flush();
        const update = { stage: 'buffer' as const, loaded: 350, total: 350, unit: 'milliseconds' as const,
            startupDelayMs: 500, startupElapsedMs: 200 };
        progress(update);
        expect(usePlaybackLoadStore.getState().progress).toEqual(update);
        expect(transport.paused).toBe(true);
    });
});
