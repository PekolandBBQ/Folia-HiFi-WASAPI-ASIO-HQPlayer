// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useCallback, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlaybackDeck from '@/components/app/playback/PlaybackDeck';
import { useOutputPlaybackHandoff } from '@/hooks/useOutputPlaybackHandoff';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { setPlayerState, usePlaybackStore } from '@/stores/usePlaybackStore';
import { usePlaybackLoadStore } from '@/stores/usePlaybackLoadStore';
import type { NativeAudioApi, NativeAudioBackend, NativeAudioEvent, NativeAudioState } from '@/types/nativeAudio';
import { PlayerState, type SongResult } from '@/types';
import { beginPlaybackSourceRequest, finishPlaybackSourceRequest, cancelPlaybackSourceRequest } from '@/services/playbackSourceRequest';

// Actual settings store → React deck → handoff → native transport lifecycle. Only the IPC
// device boundary is simulated; source loading, intents, store commits and effects are real.
vi.mock('@/services/playbackFade', () => ({ playbackFade: { isFadingOut: () => false, cancel: () => {} } }));
const song = { id: 1, name: 'Retained song', artists: [], durationMs: 180000,
    sourceRef: { kind: 'online', providerId: 'netease', trackId: '1' } } as unknown as SongResult;
let root: Root | null = null, host: HTMLDivElement;
let currentAudio: HTMLAudioElement | null = null;
let checkpoint: React.MutableRefObject<number | null>;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    localStorage.clear();
    usePlaybackStore.setState({ currentSong: song, audioSrc: 'https://example.test/current.flac', playerState: PlayerState.PAUSED });
    usePlaybackLoadStore.setState({ owner: '', progress: null });
    useAudioSettingsStore.setState({ nativeAudioOutputRevision: 0, volume: .4, isMuted: false });
});
afterEach(async () => {
    cancelPlaybackSourceRequest();
    if (root) await act(async () => root!.unmount());
    root = null; host?.remove(); currentAudio = null;
    vi.restoreAllMocks();
});
function fixture(backend: NativeAudioBackend) {
    const listeners = new Set<(event: NativeAudioEvent) => void>();
    const states = new Map<string, NativeAudioState>();
    let shutdown: Promise<void> | null = null;
    let beginBarrier: Promise<void> | null = null;
    const request = vi.fn(async (input: Parameters<NativeAudioApi['request']>[0]) => {
        if (input.action === 'hqplayer-shutdown') { if (shutdown) await shutdown; return {}; }
        if (input.action === 'stop') return {};
        if (input.action === 'begin') {
            if (beginBarrier) await beginBarrier;
            states.set(input.session!, { session: input.session!, position: input.position ?? 0, duration: 180,
                playing: false, ended: false, sampleRate: 44100, channels: 2, latency: 0,
                backend: input.backend!, deviceId: input.deviceId!, streaming: true, buffering: false,
                bufferedStart: input.position ?? 0, bufferedEnd: (input.position ?? 0) + 3, producerComplete: false });
        }
        const state = states.get(input.session!);
        if (!state) throw Object.assign(new Error('Stale session'), { code: 'CANCELLED' });
        if (input.action === 'seek') { state.position = input.position!; state.bufferedStart = state.position; state.bufferedEnd = state.position + 3; }
        if (input.action === 'play') state.playing = true;
        if (input.action === 'pause') state.playing = false;
        return { ...state };
    });
    Object.assign(window, { electron: { nativeAudio: { supported: true, request,
        onEvent: (listener: (event: NativeAudioEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } } });
    useAudioSettingsStore.setState({ nativeAudioBackend: backend, nativeAudioDeviceId: backend });
    function Probe() {
        const audioRef = useRef<HTMLAudioElement | null>(null), resume = useRef<number | null>(null), autoPlay = useRef(false);
        checkpoint = resume;
        const selected = useAudioSettingsStore(state => state.nativeAudioBackend);
        const device = useAudioSettingsStore(state => state.nativeAudioDeviceId);
        const revision = useAudioSettingsStore(state => state.nativeAudioOutputRevision);
        const source = usePlaybackStore(state => state.audioSrc);
        useOutputPlaybackHandoff(audioRef, selected, device, source, resume, autoPlay, revision);
        const register = useCallback((audio: HTMLAudioElement | null) => { audioRef.current = audio; currentAudio = audio; }, []);
        return React.createElement(PlaybackDeck, { register, nativeBackend: selected, nativeDeviceId: device,
            nativeProcessingMode: 'compatibility', initialPosition: resume.current ?? undefined,
            outputRevision: revision, getLocalFile: async () => null, src: source ?? undefined,
            onPlay: () => setPlayerState(PlayerState.PLAYING), onPause: () => setPlayerState(PlayerState.PAUSED) });
    }
    return { request, listeners, states,
        delayShutdown() { let release!: () => void; shutdown = new Promise(resolve => { release = resolve; }); return release; },
        delayBegin() { let release!: () => void; beginBarrier = new Promise(resolve => { release = resolve; }); return release; },
        emit(event: NativeAudioEvent) { for (const listener of listeners) listener(event); },
        async mount(playing: boolean) {
            host = document.createElement('div'); document.body.append(host); root = createRoot(host);
            await act(async () => root!.render(React.createElement(React.StrictMode, null, React.createElement(Probe))));
            await vi.waitFor(() => expect(currentAudio?.readyState).toBeGreaterThan(0));
            await act(async () => { currentAudio!.currentTime = 37; });
            await flush();
            if (playing) await act(async () => { await currentAudio!.play(); });
            request.mockClear();
        },
    };
}
const nativeBackends = ['wasapi-exclusive', 'asio', 'hqplayer'] as const;
const directions = nativeBackends.flatMap(from => nativeBackends.filter(to => to !== from).map(to => ({ from, to })));
describe('settings output lifecycle', () => {
    it('waits for a resolving queue selection instead of reopening the previous track at its old position', async () => {
        const f = fixture('wasapi-exclusive'); await f.mount(true);
        const sourceRequest = beginPlaybackSourceRequest();
        let change!: Promise<unknown>;
        await act(async () => { change = Promise.resolve(useAudioSettingsStore.getState().handleSetNativeAudioOutput('asio', 'asio')); });
        expect(useAudioSettingsStore.getState().nativeAudioBackend).toBe('wasapi-exclusive');
        expect(f.request.mock.calls).toEqual([]);
        const release = f.delayBegin();
        await act(async () => { usePlaybackStore.setState({ currentSong: { ...song, id: 2 }, audioSrc: 'https://example.test/next.flac' }); });
        await flush();
        expect(currentAudio!.readyState).toBe(0);
        void currentAudio!.play().catch(() => {});
        await act(async () => { finishPlaybackSourceRequest(sourceRequest); await change; });
        expect(useAudioSettingsStore.getState().nativeAudioBackend).toBe('asio');
        expect(checkpoint.current).not.toBe(37);
        await act(async () => { release(); });
        await flush();
        await vi.waitFor(() => expect(currentAudio!.paused).toBe(false));
        expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'begin', backend: 'asio', position: 0 }));
    });
    it.each(directions)('automatically resumes the same heard position $from → $to', async ({ from, to }) => {
        const f = fixture(from); await f.mount(true);
        await act(async () => { await useAudioSettingsStore.getState().handleSetNativeAudioOutput(to, to); });
        await vi.waitFor(() => expect(currentAudio?.paused).toBe(false));
        expect(currentAudio!.currentTime).toBeGreaterThanOrEqual(37);
        expect(currentAudio!.currentTime).toBeLessThan(37.3);
        expect(usePlaybackStore.getState().currentSong).toBe(song);
        expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'begin', backend: to, position: 37 }));
        expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop', reason: 'handoff' }));
        if (from === 'hqplayer') expect(f.request).toHaveBeenCalledWith({ action: 'hqplayer-shutdown', reason: 'handoff' });
    });
    it.each(directions)('keeps a paused $from → $to selection lazy until explicit Play', async ({ from, to }) => {
        const f = fixture(from); await f.mount(false);
        await act(async () => { await useAudioSettingsStore.getState().handleSetNativeAudioOutput(to, to); });
        await flush();
        expect(currentAudio!.paused).toBe(true); expect(currentAudio!.currentTime).toBe(37);
        expect(currentAudio!.readyState).toBe(0);
        expect(f.request.mock.calls.filter(([request]) => ['begin', 'finish', 'seek', 'play'].includes(request.action))).toEqual([]);
        expect(usePlaybackLoadStore.getState().progress).toBeNull();
        await act(async () => { currentAudio!.currentTime = 43; currentAudio!.volume = .2; currentAudio!.muted = true; });
        expect(f.request.mock.calls.filter(([request]) => ['begin', 'seek', 'volume'].includes(request.action))).toEqual([]);
        await act(async () => { await currentAudio!.play(); });
        expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'begin', backend: to, position: 43 }));
        expect(currentAudio!.paused).toBe(false); expect(currentAudio!.currentTime).toBeGreaterThanOrEqual(43);
        expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'volume', volume: 0 }));
    });
    it('transfers the native heard checkpoint rather than the HQ lyric interpolation lead', async () => {
        const f = fixture('hqplayer'); await f.mount(true);
        vi.mocked(performance.now).mockReturnValue(1900);
        expect(currentAudio!.currentTime).toBeCloseTo(37.9, 3);
        await act(async () => { await useAudioSettingsStore.getState().handleSetNativeAudioOutput('asio', 'asio'); });
        expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'begin', backend: 'asio', position: 37 }));
        expect(currentAudio!.currentTime).toBe(37);
    });
    it('honors a newer Pause while HQPlayer shutdown is still pending', async () => {
        const f = fixture('hqplayer'); await f.mount(true); const release = f.delayShutdown();
        let change!: Promise<unknown>;
        await act(async () => { change = Promise.resolve(useAudioSettingsStore.getState().handleSetNativeAudioOutput('asio', 'asio')); });
        await act(async () => { currentAudio!.pause(); });
        await act(async () => { release(); await change; });
        expect(currentAudio!.paused).toBe(true); expect(currentAudio!.currentTime).toBe(37);
        expect(f.request.mock.calls.filter(([request]) => ['begin', 'finish', 'seek', 'play'].includes(request.action))).toEqual([]);
        expect(usePlaybackLoadStore.getState().progress).toBeNull();
    });
    it('reopens only the final engine after a rapid HQPlayer → ASIO → HQPlayer round trip', async () => {
        const f = fixture('hqplayer'); await f.mount(true); const release = f.delayShutdown();
        let away!: Promise<unknown>, back!: Promise<unknown>;
        await act(async () => {
            away = Promise.resolve(useAudioSettingsStore.getState().handleSetNativeAudioOutput('asio', 'asio'));
            back = Promise.resolve(useAudioSettingsStore.getState().handleSetNativeAudioOutput('hqplayer', 'hqplayer'));
        });
        expect(f.request.mock.calls.filter(([request]) => request.action === 'begin')).toEqual([]);
        await act(async () => { release(); await Promise.all([away, back]); });
        await vi.waitFor(() => expect(currentAudio!.paused).toBe(false));
        expect(useAudioSettingsStore.getState().nativeAudioBackend).toBe('hqplayer');
        expect(useAudioSettingsStore.getState().nativeAudioOutputRevision).toBe(1);
        expect(f.request.mock.calls.filter(([request]) => request.action === 'begin')).toHaveLength(1);
        expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'begin', backend: 'hqplayer', position: 37 }));
    });
    it('cancels initial preparation immediately on Pause and keeps the checkpoint for a fresh Play', async () => {
        const f = fixture('asio'); await f.mount(true); const release = f.delayBegin();
        await act(async () => { await useAudioSettingsStore.getState().handleSetNativeAudioOutput('hqplayer', 'hqplayer'); });
        const begin = f.request.mock.calls.find(([request]) => request.action === 'begin')![0];
        expect(currentAudio!.readyState).toBe(0);
        await act(async () => { currentAudio!.pause(); });
        expect(f.request).toHaveBeenCalledWith({ action: 'stop', session: begin.session, reason: 'handoff' });
        expect(currentAudio!.currentTime).toBe(37); expect(currentAudio!.paused).toBe(true);
        expect(usePlaybackLoadStore.getState().progress).toBeNull();
        await act(async () => { release(); });
        expect(f.request.mock.calls.filter(([request]) => request.action === 'play')).toEqual([]);
        expect(checkpoint.current).toBeNull();
        await act(async () => { await currentAudio!.play(); });
        const preparations = f.request.mock.calls.filter(([request]) => request.action === 'begin');
        expect(preparations).toHaveLength(2);
        expect(preparations[1][0].session).not.toBe(begin.session);
        expect(preparations[1][0].position).toBe(37);
        expect(currentAudio!.paused).toBe(false);
    });
    it('does not play after a target preparation finishes following unmount', async () => {
        const f = fixture('asio'); await f.mount(true); const release = f.delayBegin();
        await act(async () => { await useAudioSettingsStore.getState().handleSetNativeAudioOutput('wasapi-exclusive', 'wasapi-exclusive'); });
        await act(async () => root!.unmount()); root = null;
        await act(async () => { release(); });
        expect(f.request.mock.calls.filter(([request]) => request.action === 'play')).toEqual([]);
        expect(usePlaybackLoadStore.getState().progress).toBeNull();
        expect(checkpoint.current).toBeNull();
    });
});
