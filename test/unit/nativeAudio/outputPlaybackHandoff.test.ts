// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type { NativeAudioApi, NativeAudioBackend, NativeAudioState } from '@/types/nativeAudio';
import { createRoot, type Root } from 'react-dom/client';
import { useOutputPlaybackHandoff } from '@/hooks/useOutputPlaybackHandoff';
import { prepareOutputHandoff } from '@/services/nativeAudio/outputHandoff';
import { NativeAudioTransport } from '@/services/nativeAudio/NativeAudioTransport';

// A batched round trip back to the mounted engine must spend the pending checkpoint.
const state = vi.hoisted(() => ({ audioSrc: 'blob:track', playerState: 'PLAYING' }));
vi.mock('@/stores/usePlaybackStore', () => ({ usePlaybackStore: { getState: () => state }, setPlayerState: (value: string) => { state.playerState = value; } }));
vi.mock('@/stores/useAudioSettingsStore', () => ({ useAudioSettingsStore: { getState: () => ({ volume: .2, isMuted: false }) } }));
vi.mock('@/services/playbackFade', () => ({ playbackFade: { isFadingOut: () => false, cancel: () => {} } }));
vi.mock('@/services/nativeAudio/loadOnlineSource', () => ({
  loadNativeOnlineSource: (api: NativeAudioApi, session: string) => api.request({ action: 'begin', session }),
}));
let root: Root | undefined, host: HTMLDivElement;
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; state.audioSrc = 'blob:track'; });
describe('output playback handoff', () => {
  it.each([
    { autoplay: true, request: 'none', expected: true },
    { autoplay: false, request: 'none', expected: false },
    { autoplay: true, request: 'pause', expected: false },
    { autoplay: false, request: 'play', expected: true },
  ])('preserves initial preparation intent during an output change (autoplay=$autoplay, request=$request)', async ({ autoplay, request: control, expected }) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.playerState = 'IDLE';
    let completePreparation!: () => void;
    const preparation = new Promise<void>(resolve => { completePreparation = resolve; });
    const request = vi.fn(async (input: Parameters<NativeAudioApi['request']>[0]) => {
      if (input.action === 'begin') await preparation;
      return { session: input.session!, position: 0, duration: 120, playing: false, ended: false,
        sampleRate: 44100, channels: 2, latency: 0, backend: 'hqplayer', deviceId: 'test' } as NativeAudioState;
    });
    const previous = new NativeAudioTransport({ supported: true, request, onEvent: () => () => {} },
      'hqplayer', 'test', 'compatibility', async () => null);
    const browser = document.createElement('audio'); browser.setAttribute('src', state.audioSrc);
    Object.defineProperty(browser, 'readyState', { value: 1 }); Object.defineProperty(browser, 'duration', { value: 120 });
    const play = vi.spyOn(browser, 'play').mockResolvedValue();
    const audioRef = { current: previous.asMediaElement() }, resume = { current: null as number | null }, autoPlay = { current: autoplay };
    function Probe({ backend }: { backend: NativeAudioBackend }) {
      useOutputPlaybackHandoff(audioRef, backend, backend === 'hqplayer' ? 'test' : '', state.audioSrc, resume, autoPlay); return null;
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    try {
      previous.setSource(state.audioSrc);
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'begin' })));
      if (control === 'pause') previous.pause();
      if (control === 'play') void previous.play().catch(() => {});
      expect(previous.readyState).toBe(0);
      await act(async () => root!.render(React.createElement(Probe, { backend: 'hqplayer' })));
      await act(async () => { prepareOutputHandoff('browser', ''); state.playerState = 'PAUSED'; });
      previous.dispose('handoff'); audioRef.current = browser;
      await act(async () => root!.render(React.createElement(Probe, { backend: 'browser' })));
      expect(play).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(resume.current).toBeNull(); expect(autoPlay.current).toBe(false);
    } finally { previous.dispose(); await act(async () => { completePreparation(); }); }
  });
  it.each([{ playing: true, pending: 'seek', requestBeforeSwitch: 'none' }, { playing: false, pending: 'seek', requestBeforeSwitch: 'none' },
    { playing: true, pending: 'play', requestBeforeSwitch: 'none' }, { playing: true, pending: 'seek', requestBeforeSwitch: 'pause' },
    { playing: true, pending: 'play', requestBeforeSwitch: 'pause' }, { playing: false, pending: 'seek', requestBeforeSwitch: 'play' },
    { playing: true, pending: 'seek', requestBeforeSwitch: 'seek' }])(
    'preserves the checkpoint through another output change during a pending streaming $pending (playing=$playing, newer=$requestBeforeSwitch)', async ({ playing, pending, requestBeforeSwitch }) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.playerState = playing ? 'PLAYING' : 'PAUSED';
    const previous = document.createElement('audio'), browser = document.createElement('audio');
    for (const audio of [previous, browser]) audio.setAttribute('src', state.audioSrc);
    previous.currentTime = 37;
    Object.defineProperty(previous, 'paused', { value: !playing });
    Object.defineProperty(browser, 'duration', { value: 120 });
    Object.defineProperty(browser, 'readyState', { value: 1 });
    vi.spyOn(previous, 'pause').mockImplementation(() => { state.playerState = 'PAUSED'; });
    const play = vi.spyOn(browser, 'play').mockResolvedValue();
    let release!: () => void;
    const refill = new Promise<void>(resolve => { release = resolve; });
    let nativeState: NativeAudioState = { session: '', position: 0, duration: 120, playing: false, ended: false,
      streaming: true, buffering: false, bufferedStart: 0, bufferedEnd: .5, producerComplete: false,
      sampleRate: 48000, channels: 2, latency: .02, backend: 'asio', deviceId: 'test' };
    const request = vi.fn(async (input: Parameters<NativeAudioApi['request']>[0]) => {
      if (input.action === 'begin') nativeState = { ...nativeState, session: input.session! };
      if (input.action === pending || (requestBeforeSwitch === 'play' && input.action === 'play')) await refill;
      if (input.action === 'seek') nativeState = { ...nativeState, position: input.position! };
      if (input.action === 'play') nativeState = { ...nativeState, playing: true };
      return { ...nativeState };
    });
    const intermediate = new NativeAudioTransport({ supported: true, request, onEvent: () => () => {} },
      'asio', 'test', 'compatibility', async () => null);
    const audioRef = { current: previous }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe({ backend }: { backend: NativeAudioBackend }) {
      useOutputPlaybackHandoff(audioRef, backend, backend === 'asio' ? 'test' : '', state.audioSrc, resume, autoPlay); return null;
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    try {
      await act(async () => root!.render(React.createElement(Probe, { backend: 'hqplayer' })));
      await act(async () => { prepareOutputHandoff('asio', 'test'); });
      intermediate.setSource(state.audioSrc);
      await vi.waitFor(() => expect(intermediate.readyState).toBeGreaterThanOrEqual(1));
      audioRef.current = intermediate.asMediaElement();
      await act(async () => root!.render(React.createElement(Probe, { backend: 'asio' })));
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 37 }));
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: pending }));
      expect(intermediate.currentTime).toBe(pending === 'seek' ? 0 : 37); expect(intermediate.paused).toBe(true);
      if (requestBeforeSwitch === 'pause') intermediate.pause();
      if (requestBeforeSwitch === 'seek') {
        intermediate.currentTime = 5;
        expect(intermediate.currentTime).toBe(5);
      }
      if (requestBeforeSwitch === 'play') {
        await act(async () => { void intermediate.play().catch(() => {}); });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'play' }));
        expect(intermediate.paused).toBe(true);
      }
      await act(async () => { prepareOutputHandoff('wasapi-exclusive', 'test'); prepareOutputHandoff('browser', ''); });
      audioRef.current = browser; intermediate.dispose();
      await act(async () => root!.render(React.createElement(Probe, { backend: 'browser' })));
      expect(browser.currentTime).toBe(requestBeforeSwitch === 'seek' ? 5 : 37);
      expect(play).toHaveBeenCalledTimes(requestBeforeSwitch === 'play' || (playing && requestBeforeSwitch !== 'pause') ? 1 : 0);
      expect(resume.current).toBeNull();
    } finally {
      intermediate.dispose();
      await act(async () => { release(); });
    }
  });
  it.each(['checkpoint', 'source'])('ignores a rejected old restore after a newer %s reuses the same deck', async replacement => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.playerState = 'PLAYING';
    const audio = document.createElement('audio'); audio.setAttribute('src', state.audioSrc); audio.currentTime = 37;
    let paused = false, rejectOld!: (error: Error) => void;
    Object.defineProperty(audio, 'paused', { get: () => paused });
    Object.defineProperty(audio, 'readyState', { value: 1 });
    vi.spyOn(audio, 'pause').mockImplementation(() => { paused = true; state.playerState = 'PAUSED'; });
    const oldPlay = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const play = vi.spyOn(audio, 'play').mockImplementation(async () => { paused = false; state.playerState = 'PLAYING'; });
    play.mockImplementationOnce(() => { paused = false; state.playerState = 'PLAYING'; return oldPlay; });
    const audioRef = { current: audio }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe() { useOutputPlaybackHandoff(audioRef, 'browser', '', state.audioSrc, resume, autoPlay); return null; }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Probe)));
    await act(async () => { prepareOutputHandoff('browser', ''); });
    expect(play).toHaveBeenCalledOnce();
    if (replacement === 'checkpoint') {
      await act(async () => { prepareOutputHandoff('asio', 'test'); prepareOutputHandoff('browser', ''); });
      expect(play).toHaveBeenCalledTimes(2);
    } else {
      state.audioSrc = 'blob:new-track'; audio.setAttribute('src', state.audioSrc);
      await act(async () => root!.render(React.createElement(Probe)));
    }
    expect(state.playerState).toBe('PLAYING');
    await act(async () => { rejectOld(new Error('Old output play failed')); });
    expect(state.playerState).toBe('PLAYING'); expect(paused).toBe(false);
  });
  it('does not recover an old checkpoint after changing away from and back to the same source URL', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.playerState = 'PLAYING';
    const audio = document.createElement('audio'); audio.setAttribute('src', state.audioSrc); audio.currentTime = 37;
    let paused = false, finishOld!: () => void;
    Object.defineProperty(audio, 'paused', { get: () => paused });
    Object.defineProperty(audio, 'readyState', { value: 1 });
    vi.spyOn(audio, 'pause').mockImplementation(() => { paused = true; state.playerState = 'PAUSED'; });
    const oldPlay = new Promise<void>(resolve => { finishOld = resolve; });
    const play = vi.spyOn(audio, 'play').mockImplementation(async () => { paused = false; state.playerState = 'PLAYING'; });
    play.mockImplementationOnce(() => oldPlay);
    const audioRef = { current: audio }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe() { useOutputPlaybackHandoff(audioRef, 'browser', '', state.audioSrc, resume, autoPlay); return null; }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Probe)));
    await act(async () => { prepareOutputHandoff('browser', ''); });
    state.audioSrc = 'blob:other-track'; audio.setAttribute('src', state.audioSrc);
    await act(async () => root!.render(React.createElement(Probe)));
    state.audioSrc = 'blob:track'; audio.setAttribute('src', state.audioSrc); audio.currentTime = 5;
    paused = false; state.playerState = 'PLAYING';
    await act(async () => root!.render(React.createElement(Probe)));
    await act(async () => { prepareOutputHandoff('browser', ''); });
    expect(audio.currentTime).toBe(5); expect(play).toHaveBeenCalledTimes(2);
    await act(async () => { finishOld(); });
    expect(audio.currentTime).toBe(5); expect(state.playerState).toBe('PLAYING');
  });
  it.each([true, false])('keeps the current-song checkpoint when a previous output has an error marker (playing=%s)', async playing => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.playerState = playing ? 'PLAYING' : 'PAUSED';
    const previous = document.createElement('audio'), browser = document.createElement('audio');
    for (const audio of [previous, browser]) audio.setAttribute('src', state.audioSrc);
    previous.currentTime = 24.4;
    Object.defineProperty(previous, 'error', { value: { code: 4 } });
    Object.defineProperty(previous, 'paused', { value: !playing });
    Object.defineProperty(browser, 'duration', { value: 120 });
    Object.defineProperty(browser, 'readyState', { value: 1 });
    vi.spyOn(previous, 'pause').mockImplementation(() => { state.playerState = 'PAUSED'; });
    const play = vi.spyOn(browser, 'play').mockResolvedValue();
    const audioRef = { current: previous }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe({ backend }: { backend: NativeAudioBackend }) { useOutputPlaybackHandoff(audioRef, backend, backend === 'hqplayer' ? 'hqplayer-local' : '', state.audioSrc, resume, autoPlay); return null; }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Probe, { backend: 'hqplayer' })));
    await act(async () => { prepareOutputHandoff('browser', ''); state.playerState = 'PAUSED'; });
    audioRef.current = browser;
    await act(async () => root!.render(React.createElement(Probe, { backend: 'browser' })));
    expect(play).toHaveBeenCalledTimes(playing ? 1 : 0); expect(browser.currentTime).toBe(24.4);
  });
  it('restores a delayed browser metadata checkpoint after HQPlayer shutdown changes the store to paused', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.playerState = 'PLAYING';
    const previous = document.createElement('audio'), browser = document.createElement('audio');
    for (const audio of [previous, browser]) audio.setAttribute('src', state.audioSrc);
    previous.currentTime = 25; let previousPaused = false, browserPaused = true, ready = 0;
    Object.defineProperty(previous, 'paused', { get: () => previousPaused });
    Object.defineProperty(previous, 'readyState', { value: 4 });
    Object.defineProperty(browser, 'paused', { get: () => browserPaused });
    Object.defineProperty(browser, 'readyState', { get: () => ready });
    Object.defineProperty(browser, 'duration', { value: 120 });
    vi.spyOn(previous, 'pause').mockImplementation(() => { previousPaused = true; state.playerState = 'PAUSED'; });
    const play = vi.spyOn(browser, 'play').mockImplementation(async () => { browserPaused = false; state.playerState = 'PLAYING'; });
    const audioRef = { current: previous }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe({ backend }: { backend: NativeAudioBackend }) { useOutputPlaybackHandoff(audioRef, backend, backend === 'hqplayer' ? 'hqplayer-local' : '', state.audioSrc, resume, autoPlay); return null; }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Probe, { backend: 'hqplayer' })));
    await act(async () => { prepareOutputHandoff('browser', ''); });
    expect(state.playerState).toBe('PAUSED');
    audioRef.current = browser;
    await act(async () => root!.render(React.createElement(Probe, { backend: 'browser' })));
    expect(play).not.toHaveBeenCalled();
    await act(async () => { ready = 4; browser.dispatchEvent(new Event('loadedmetadata')); });
    expect(play).toHaveBeenCalledOnce(); expect(browser.currentTime).toBe(25);
    expect(browserPaused).toBe(false); expect(resume.current).toBeNull();
  });
  it('owns metadata restoration until its one seek-and-play checkpoint is consumed', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.playerState = 'PLAYING';
    const previous = document.createElement('audio'), next = document.createElement('audio');
    for (const audio of [previous, next]) audio.setAttribute('src', state.audioSrc);
    previous.currentTime = 22.2; let ready = 0, position = 0, ownsCheckpoint = () => false;
    Object.defineProperty(previous, 'paused', { value: false });
    Object.defineProperty(next, 'duration', { value: 120 });
    Object.defineProperty(next, 'readyState', { get: () => ready });
    const seeks: number[] = [];
    Object.defineProperty(next, 'currentTime', { get: () => position, set: value => { seeks.push(value); position = value; } });
    vi.spyOn(previous, 'pause').mockImplementation(() => { state.playerState = 'PAUSED'; });
    const play = vi.spyOn(next, 'play').mockResolvedValue();
    const audioRef = { current: previous }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe({ backend }: { backend: NativeAudioBackend }) { ownsCheckpoint = useOutputPlaybackHandoff(audioRef, backend, backend === 'hqplayer' ? 'hqplayer-local' : '', state.audioSrc, resume, autoPlay); return null; }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Probe, { backend: 'hqplayer' })));
    expect(ownsCheckpoint()).toBe(false);
    await act(async () => { prepareOutputHandoff('browser', ''); });
    expect(ownsCheckpoint()).toBe(true);
    // App's metadata handler runs before the handoff listener and may consume its display ref.
    next.addEventListener('loadedmetadata', () => {
      expect(ownsCheckpoint()).toBe(true);
      if (!ownsCheckpoint()) next.currentTime = resume.current!;
      resume.current = null;
    });
    audioRef.current = next;
    await act(async () => root!.render(React.createElement(Probe, { backend: 'browser' })));
    await act(async () => { ready = 1; next.dispatchEvent(new Event('loadedmetadata')); });
    expect(seeks).toEqual([22.2]); expect(play).toHaveBeenCalledOnce(); expect(ownsCheckpoint()).toBe(false);
  });
  it.each([true, false])('preserves intent through a same-batch round trip (playing=%s)', async playing => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.playerState = playing ? 'PLAYING' : 'PAUSED';
    const audio = document.createElement('audio'); audio.setAttribute('src', state.audioSrc); audio.currentTime = 37;
    let paused = !playing;
    Object.defineProperty(audio, 'paused', { get: () => paused });
    Object.defineProperty(audio, 'readyState', { value: 1 });
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => { paused = true; });
    const play = vi.spyOn(audio, 'play').mockImplementation(async () => { paused = false; });
    const audioRef = { current: audio }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe() { useOutputPlaybackHandoff(audioRef, 'browser', '', state.audioSrc, resume, autoPlay); return null; }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Probe)));
    await act(async () => {
      prepareOutputHandoff('wasapi-exclusive', 'test');
      prepareOutputHandoff('asio', 'test');
      prepareOutputHandoff('browser', '');
    });
    expect(pause).toHaveBeenCalledTimes(3); expect(play).toHaveBeenCalledTimes(playing ? 1 : 0);
    expect(audio.currentTime).toBe(37); expect(audio.paused).toBe(!playing); expect(resume.current).toBeNull();
  });
});
