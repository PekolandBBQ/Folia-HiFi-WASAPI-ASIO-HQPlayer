import { afterEach, expect, it, vi } from 'vitest';
import { NativeAudioTransport } from '../../../src/services/nativeAudio/NativeAudioTransport';
import type { NativeAudioApi, NativeAudioEvent, NativeAudioState } from '../../../src/types/nativeAudio';
import { usePlaybackLoadStore } from '../../../src/stores/usePlaybackLoadStore';
import { useDecodeCompatibilityStore } from '../../../src/stores/useDecodeCompatibilityStore';

// test/unit/nativeAudio/streamingTransport.test.ts — buffering must not advance lyrics, finish the song, or invent downloaded audio.
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../../src/services/nativeAudio/loadOnlineSource', () => ({ loadNativeOnlineSource: mocks.load }));
const cleanups: Array<() => void> = [];
afterEach(() => {
    useDecodeCompatibilityStore.getState().prompt?.choose('cancel');
    useDecodeCompatibilityStore.setState({ enabled: false });
    cleanups.splice(0).forEach(cleanup => cleanup());
    usePlaybackLoadStore.setState({ owner: '', startedAt: 0, progress: null });
    vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals();
});

function fixture(backend: 'asio' | 'hqplayer' = 'asio', duration = 120) {
    let listener: (event: NativeAudioEvent) => void = () => {};
    let state: NativeAudioState = { session: '', position: 0, duration, playing: false, ended: false,
        streaming: true, buffering: false, bufferedStart: 0, bufferedEnd: 0.5, producerComplete: false,
        sampleRate: 48000, channels: 2, latency: 0.02, backend, deviceId: 'test' };
    const request = vi.fn(async ({ action, session, position }: Parameters<NativeAudioApi['request']>[0]) => {
        if (action === 'stop') return {};
        if (session !== state.session) throw new Error('Stale playback session');
        if (action === 'play') state = { ...state, playing: true, ended: false };
        if (action === 'pause') state = { ...state, playing: false };
        if (action === 'seek') state = { ...state, position: position!, bufferedStart: position!, bufferedEnd: position! + 0.35, ended: false };
        return { ...state };
    });
    const api: NativeAudioApi = { supported: true, request, onEvent: fn => { listener = fn; return () => {}; } };
    mocks.load.mockImplementation(async (_api, session) => {
        state = { ...state, session, position: 0, playing: false, buffering: false, bufferedStart: 0, bufferedEnd: 0.5 }; return { ...state };
    });
    const transport = new NativeAudioTransport(api, backend, 'test', 'integer-direct', async () => null);
    cleanups.push(() => transport.dispose());
    const send = (patch: Partial<NativeAudioState>) => {
        state = { ...state, ...patch }; listener({ event: 'state', session: state.session, state: { ...state } });
    };
    return { transport, request, send, state: () => state, event: (event: NativeAudioEvent) => listener(event) };
}

it('starts with prebuffered PCM and keeps download progress after playback becomes ready', async () => {
    const { transport, send, state, event } = fixture();
    const ready = vi.fn(); transport.addEventListener('canplay', ready);
    transport.setSource('https://example.com/song.flac'); await transport.play();
    expect(ready).toHaveBeenCalledOnce(); expect(transport.readyState).toBe(3);
    expect(transport.buffered.length).toBe(1); expect(transport.buffered.end(0)).toBe(0.5);
    expect(transport.seekable.end(0)).toBe(120);
    event({ event: 'progress', session: state().session, progress: { stage: 'download', loaded: 20, total: 100 } });
    send({ position: 0.1 });
    expect(usePlaybackLoadStore.getState().progress).toMatchObject({ stage: 'download', loaded: 20, total: 100 });
    event({ event: 'progress', session: state().session, progress: { stage: 'download', loaded: 100, total: 100, complete: true } });
    send({ position: 0.2 });
    expect(usePlaybackLoadStore.getState().progress).toBeNull();
});

it('finishes live-source preparation when prebuffered playback starts without waiting for a whole-song EOF', async () => {
    const { transport, send } = fixture('hqplayer');
    transport.setSource('https://example.com/live-pcm');
    await vi.waitFor(() => expect(transport.readyState).toBe(3));
    expect(usePlaybackLoadStore.getState().progress?.stage).toBe('load');
    await transport.play();
    expect(usePlaybackLoadStore.getState().progress).toBeNull();
    send({ position: 1, bufferedStart: 1, bufferedEnd: 1.5, producerComplete: false });
    expect(usePlaybackLoadStore.getState().progress).toBeNull();
    send({ bufferedEnd: 1, buffering: true });
    expect(usePlaybackLoadStore.getState().progress?.stage).toBe('buffer');
    send({ bufferedEnd: 1.5, buffering: false });
    expect(usePlaybackLoadStore.getState().progress).toBeNull();
});

it('freezes the clock during an underrun, then resumes once without ending or losing download progress', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { transport, send, state, event } = fixture();
    const waiting = vi.fn(), playing = vi.fn(), ended = vi.fn();
    transport.addEventListener('waiting', waiting); transport.addEventListener('playing', playing); transport.addEventListener('ended', ended);
    transport.setSource('https://example.com/song'); await transport.play();
    event({ event: 'progress', session: state().session, progress: { stage: 'download', loaded: 40, total: 100 } });
    now = 200; send({ position: 0.2, bufferedStart: 0.2, bufferedEnd: 0.2, buffering: true });
    const stalled = transport.currentTime; now += 10_000;
    send({ position: 0.2 });
    expect(transport.currentTime).toBe(stalled); expect(transport.paused).toBe(false);
    expect(transport.readyState).toBe(2); expect(transport.buffered.length).toBe(0);
    expect(waiting).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled();
    event({ event: 'progress', session: state().session, progress: { stage: 'download', loaded: 50, total: 100 } });
    expect(usePlaybackLoadStore.getState().progress?.stage).toBe('buffer');
    send({ bufferedEnd: 0.8, buffering: false });
    expect(transport.readyState).toBe(3); expect(playing).toHaveBeenCalledTimes(2);
    expect(usePlaybackLoadStore.getState().progress).toMatchObject({ stage: 'download', loaded: 50 });
    now += 100; expect(transport.currentTime).toBeCloseTo(0.3, 5);
});

it('caps interpolation to available PCM and reports the new buffered range after seeking', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { transport, send } = fixture();
    transport.setSource('https://example.com/song'); await transport.play();
    send({ position: 0.48 }); now = 1000;
    expect(transport.currentTime).toBe(0.5);
    transport.currentTime = 60;
    await vi.waitFor(() => expect(transport.seeking).toBe(false));
    expect(transport.buffered.start(0)).toBe(60); expect(transport.buffered.end(0)).toBe(60.35);
    expect(transport.seekable.end(0)).toBe(120); expect(() => transport.buffered.end(1)).toThrow();
});

it('advances an unknown-duration stream from presented frames and publishes its real duration only at EOF', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { transport, send } = fixture('asio', 0);
    const durationchange = vi.fn(), ended = vi.fn();
    transport.addEventListener('durationchange', durationchange); transport.addEventListener('ended', ended);
    transport.setSource('https://example.com/unknown-length'); await transport.play();
    expect(Number.isNaN(transport.duration)).toBe(true); expect(transport.seekable.length).toBe(0);
    send({ position: 1.5, bufferedStart: 1.5, bufferedEnd: 2 }); now = 100;
    expect(transport.currentTime).toBeCloseTo(1.6, 5);
    send({ position: 1.6, bufferedStart: 1.6, bufferedEnd: 1.6, buffering: true }); now = 10000;
    expect(transport.currentTime).toBe(1.6); expect(durationchange).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled(); expect(Number.isNaN(transport.duration)).toBe(true);
    send({ position: 1.6, bufferedEnd: 2.7, buffering: false, producerComplete: true, duration: 2.7 });
    expect(transport.duration).toBe(2.7); expect(durationchange).toHaveBeenCalledOnce();
    send({ position: 2.7, bufferedStart: 2.7, bufferedEnd: 2.7, playing: false, ended: true });
    expect(transport.currentTime).toBe(2.7); expect(ended).toHaveBeenCalledOnce();
    expect(durationchange).toHaveBeenCalledOnce();
});

it('keeps an explicit checkpoint for an unknown-duration stream instead of clamping its seek to zero', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, request } = fixture('asio', 0);
    transport.setSource('https://example.com/unknown-length'); await transport.play();
    transport.currentTime = 20;
    await vi.waitFor(() => expect(transport.seeking).toBe(false));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 20 }));
    expect(transport.currentTime).toBe(20); expect(Number.isNaN(transport.duration)).toBe(true);
    expect(transport.buffered.start(0)).toBe(20); expect(transport.seekable.length).toBe(0);
    transport.pause(); await vi.waitFor(() => expect(transport.paused).toBe(true));
    expect(transport.currentTime).toBe(20); expect(transport.error).toBeNull();
});
it('does not queue a pause or a newer seek behind a pending far seek', async () => {
    const { transport, request } = fixture(); let release!: () => void;
    const original = request.getMockImplementation()!;
    const wait = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async args => {
        if (args.action === 'seek' && args.position === 90) await wait;
        return original(args);
    });
    try {
        transport.setSource('https://example.com/song'); await transport.play(); transport.currentTime = 90;
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 90 })));
        transport.pause(); transport.currentTime = 5;
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'pause' })));
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 5 })));
        expect(transport.error).toBeNull();
    } finally { release(); }
});

it('does not queue streaming pause or gains behind a PCM-waiting play', async () => {
    const { transport, request } = fixture('hqplayer');
    const original = request.getMockImplementation()!;
    let cancelPlay!: () => void;
    request.mockImplementation(async args => args.action === 'play'
        ? new Promise((_resolve, reject) => { cancelPlay = () => reject(Object.assign(new Error('Pause superseded play'), { code: 'CANCELLED' })); })
        : original(args));
    try {
        transport.setSource('https://example.com/song');
        const playing = transport.play().then(() => null, error => error);
        await vi.waitFor(() => expect(cancelPlay).toBeTypeOf('function'));
        request.mockClear();
        transport.volume = .3; transport.setReplayGain(.5);
        transport.setHQPlayerGainSettings(-3, false, () => {}); transport.pause();
        await vi.waitFor(() => expect(request.mock.calls.map(([args]) => args.action)).toEqual(expect.arrayContaining(['pause', 'volume', 'replaygain', 'gain'])));
        expect(transport.paused).toBe(true); cancelPlay();
        expect(await playing).toMatchObject({ name: 'AbortError' }); expect(transport.error).toBeNull();
    } finally { cancelPlay?.(); }
});

it('waits for independent HQ gain acknowledgement before checkpoint replacement', async () => {
    const { transport, request } = fixture('hqplayer');
    const original = request.getMockImplementation()!;
    let releaseVolume!: () => void, releaseGain!: () => void;
    const volume = new Promise<void>(resolve => { releaseVolume = resolve; });
    const gain = new Promise<void>(resolve => { releaseGain = resolve; });
    let held = true;
    request.mockImplementation(async args => {
        if (held && args.action === 'volume') await volume;
        if (held && args.action === 'gain') await gain;
        return original(args);
    });
    try {
        transport.setSource('https://example.com/song');
        await vi.waitFor(() => expect(transport.readyState).toBe(3));
        transport.volume = .02; transport.setHQPlayerGainSettings(-3, false, () => {});
        const resuming = transport.resumeFrom(22.17, true);
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'volume' })));
        expect(request.mock.calls.some(([args]) => args.action === 'seek')).toBe(false);
        releaseVolume();
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'gain' })));
        expect(request.mock.calls.some(([args]) => args.action === 'seek')).toBe(false);
        held = false; releaseGain(); await resuming;
        expect(transport.currentTime).toBeCloseTo(22.17, 1); expect(transport.paused).toBe(false); expect(transport.error).toBeNull();
    } finally { held = false; releaseVolume(); releaseGain(); }
});

it('keeps whole-file controls in order behind a pending play', async () => {
    const { transport, request, send } = fixture('hqplayer');
    const original = request.getMockImplementation()!;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async args => { if (args.action === 'play') await wait; return original(args); });
    try {
        transport.setSource('https://example.com/song');
        await vi.waitFor(() => expect(transport.readyState).toBe(3)); send({ streaming: false });
        const playing = transport.play().then(() => null, error => error);
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'play' })));
        request.mockClear();
        transport.volume = .3; transport.setReplayGain(.5);
        transport.setHQPlayerGainSettings(-3, false, () => {}); transport.pause();
        await Promise.resolve(); await Promise.resolve(); expect(request).not.toHaveBeenCalled();
        release(); expect((await playing).name).toBe('AbortError');
        await vi.waitFor(() => expect(request.mock.calls.map(([args]) => args.action)).toEqual(['volume', 'replaygain', 'gain', 'pause']));
        expect(transport.error).toBeNull(); expect(transport.paused).toBe(true);
    } finally { release(); }
});

it('finishes the seek state when output handoff replaces the metadata checkpoint seek', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, request, send } = fixture();
    const original = request.getMockImplementation()!;
    let cancelled!: (error: Error) => void; let seeks = 0;
    request.mockImplementation(async args => {
        if (args.action === 'seek' && ++seeks === 1) {
            return new Promise((_resolve, reject) => { cancelled = reject; });
        }
        if (args.action === 'seek') cancelled(Object.assign(new Error('Seek replaced'), { code: 'CANCELLED' }));
        return original(args);
    });
    const ready = new Promise<void>(resolve => transport.addEventListener('loadedmetadata', () => {
        // The host restores its saved checkpoint when metadata arrives.
        transport.currentTime = 20.2; resolve();
    }, { once: true }));
    transport.setSource('https://example.com/song'); await ready;
    await vi.waitFor(() => expect(seeks).toBe(1));
    // The output handoff subsequently owns the complete seek-and-play transaction.
    await transport.resumeFrom(20.2, true);
    send({ position: 21.2, bufferedStart: 21.2, bufferedEnd: 24.2 });
    expect(transport.seeking).toBe(false); expect(transport.paused).toBe(false);
    expect(transport.currentTime).toBe(21.2); expect(transport.error).toBeNull();
});

it('a cancelled checkpoint seek releases its seeking flag and accepts later native progress', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, request, send } = fixture();
    const original = request.getMockImplementation()!;
    transport.setSource('https://example.com/live'); await transport.play();
    request.mockImplementation(async args => {
        if (args.action === 'seek') throw Object.assign(new Error('Seek replaced'), { code: 'CANCELLED' });
        return original(args);
    });
    transport.currentTime = 1.332;
    await vi.waitFor(() => expect(transport.seeking).toBe(false));
    send({position: 40, bufferedStart: 40, bufferedEnd: 40.5});
    expect(transport.currentTime).toBe(40); expect(transport.error).toBeNull();
});

it('prebuffers an HQPlayer streaming checkpoint before the first play so handoff never plays origin zero', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, request, state } = fixture('hqplayer');
    const original = request.getMockImplementation()!;
    const playedPositions: number[] = [];
    request.mockImplementation(async args => {
        if (args.action === 'play') playedPositions.push(state().position);
        return original(args);
    });
    transport.setSource('https://example.com/song');
    await transport.resumeFrom(22.17, true);
    expect(playedPositions).toEqual([22.17]);
    expect(transport.currentTime).toBe(22.17); expect(transport.paused).toBe(false);
    expect(request.mock.calls.map(([args]) => args.action).filter(action => action === 'play' || action === 'seek'))
        .toEqual(['seek', 'play']);
});

it('keeps a paused HQPlayer streaming checkpoint paused without priming Desktop by playing', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, request } = fixture('hqplayer');
    transport.setSource('https://example.com/song');
    await transport.resumeFrom(22.17, false);
    expect(transport.currentTime).toBe(22.17); expect(transport.paused).toBe(true);
    expect(request.mock.calls.some(([args]) => args.action === 'play')).toBe(false);
});

it('finishes queued HQPlayer volume controls before replacing its streaming source', async () => {
    const { transport, request } = fixture('hqplayer'); const original = request.getMockImplementation()!;
    let releaseVolume!: () => void;
    const volumePending = new Promise<void>(resolve => { releaseVolume = resolve; });
    let resetting = false;
    request.mockImplementation(async args => {
        if (args.action === 'volume') {
            await volumePending;
            if (resetting) throw Object.assign(new Error('Streaming source not ready'), { code: 'INVALID_REQUEST' });
        }
        if (args.action === 'seek') resetting = true;
        const result = await original(args);
        if (args.action === 'seek') resetting = false;
        return result;
    });
    transport.setSource('https://example.com/song');
    await vi.waitFor(() => expect(transport.readyState).toBeGreaterThanOrEqual(1));
    transport.volume = .02;
    const resuming = transport.resumeFrom(22.17, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(request.mock.calls.some(([args]) => args.action === 'seek')).toBe(false);
    releaseVolume(); await resuming;
    expect(transport.paused).toBe(false); expect(transport.error).toBeNull();
});

it('does not restore play after the listener pauses during a checkpoint refill', async () => {
    const { transport, request } = fixture(); const original = request.getMockImplementation()!;
    let refill!: () => void;
    const waiting = new Promise<void>(resolve => { refill = resolve; });
    request.mockImplementation(async args => { if (args.action === 'seek') await waiting; return original(args); });
    transport.setSource('https://example.com/song'); await transport.play();
    const resuming = transport.resumeFrom(90, true);
    const rejected = expect(resuming).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 90 })));
    transport.pause(); refill(); await rejected;
    await vi.waitFor(() => expect(transport.paused).toBe(true));
    expect(request.mock.calls.filter(([value]) => value.action === 'play')).toHaveLength(1);
    expect(transport.seeking).toBe(false); expect(transport.error).toBeNull();
});

it('ignores a superseded checkpoint reply when the listener chooses a newer seek', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, request, state, send } = fixture(); const original = request.getMockImplementation()!;
    let finishOld!: () => void;
    request.mockImplementation(async args => {
        if (args.action === 'seek' && args.position === 90) {
            const old = { ...state(), position: 90, playing: false, bufferedStart: 90, bufferedEnd: 90.5 };
            await new Promise<void>(resolve => { finishOld = resolve; }); return old;
        }
        return original(args);
    });
    transport.setSource('https://example.com/song'); await transport.play();
    const rejected = expect(transport.resumeFrom(90, true)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 90 })));
    transport.currentTime = 5; await vi.waitFor(() => expect(transport.seeking).toBe(false));
    finishOld(); await rejected; send({ position: 6, bufferedStart: 6, bufferedEnd: 9 });
    expect(transport.currentTime).toBe(6); expect(transport.paused).toBe(false);
    expect(request.mock.calls.filter(([value]) => value.action === 'play')).toHaveLength(1);
});

it('clears the buffer stage after recovery when the download finished during the stall', async () => {
    const { transport, send, state, event } = fixture();
    transport.setSource('https://example.com/song'); await transport.play();
    send({ position: 0.4, bufferedStart: 0.4, bufferedEnd: 0.4, buffering: true });
    event({ event: 'progress', session: state().session, progress: { stage: 'download', complete: true } });
    expect(usePlaybackLoadStore.getState().progress?.stage).toBe('buffer');
    send({ bufferedEnd: 0.9, buffering: false });
    expect(usePlaybackLoadStore.getState().progress).toBeNull();
});

it('preserves play intent during a starved resume and emits play before waiting', async () => {
    const { transport, send } = fixture(); const events: string[] = [];
    transport.setSource('https://example.com/song'); await transport.play();
    transport.pause();
    send({ playing: false, bufferedEnd: 0, buffering: true });
    for (const name of ['play', 'playing', 'waiting']) transport.addEventListener(name, () => events.push(name));
    await transport.play();
    expect(events).toEqual(['play', 'waiting']); expect(transport.paused).toBe(false);
    send({ bufferedEnd: 0.5, buffering: false });
    expect(events).toEqual(['play', 'waiting', 'playing']);
});

it('waits for the explicit completed-and-drained state before emitting one ended event', async () => {
    const { transport, send } = fixture(); const ended = vi.fn(); transport.addEventListener('ended', ended);
    transport.setSource('https://example.com/song'); await transport.play();
    send({ position: 119, bufferedStart: 119, bufferedEnd: 120, producerComplete: true });
    expect(transport.readyState).toBe(4); expect(ended).not.toHaveBeenCalled();
    send({ position: 120, bufferedStart: 120, bufferedEnd: 120, playing: false, ended: true });
    send({ ended: true });
    expect(transport.paused).toBe(true); expect(ended).toHaveBeenCalledOnce();
});

it('ignores old session progress, ranges, and decoder failures after changing songs', async () => {
    const { transport, event, state } = fixture();
    transport.setSource('https://example.com/old'); await transport.play(); const old = state();
    transport.setSource('https://example.com/new'); await transport.play();
    event({ event: 'progress', session: state().session, progress: { stage: 'download', loaded: 10, total: 100 } });
    event({ event: 'state', session: old.session, state: { ...old, position: 40, bufferedStart: 40, bufferedEnd: 80 } });
    event({ event: 'progress', session: old.session, progress: { stage: 'download', complete: true } });
    event({ event: 'error', session: old.session, errorCode: 'STRICT_DECODE_FAILED' });
    expect(transport.currentTime).toBeLessThan(1); expect(transport.buffered.start(0)).toBe(0);
    expect(transport.error).toBeNull(); expect(usePlaybackLoadStore.getState().progress?.loaded).toBe(10);
});

it('stops and clears progress when the listener declines late strict decode recovery', async () => {
    const { transport, event, state } = fixture(); const error = vi.fn(); transport.addEventListener('error', error);
    transport.setSource('https://example.com/song'); await transport.play();
    event({ event: 'error', session: state().session, errorCode: 'STRICT_DECODE_FAILED' });
    expect(transport.error).toBeNull();
    expect(useDecodeCompatibilityStore.getState().prompt).not.toBeNull();
    useDecodeCompatibilityStore.getState().prompt!.choose('cancel');
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledOnce(); expect(transport.paused).toBe(true);
    expect(transport.error?.nativeCode).toBe('STRICT_DECODE_FAILED'); expect(usePlaybackLoadStore.getState().progress).toBeNull();
});

it('retries a late strict failure once, restores playback, and keeps the next song strict', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { transport, send, event, state, request } = fixture();
    transport.setSource('https://example.com/song'); await transport.play();
    send({ position: 12, bufferedStart: 12, bufferedEnd: 12.5 });
    const previous = state().session;
    event({ event: 'error', session: previous, errorCode: 'STRICT_DECODE_FAILED' });
    now = 10_000; expect(transport.currentTime).toBe(12);
    useDecodeCompatibilityStore.getState().prompt!.choose('once');
    await vi.waitFor(() => expect(state().session).not.toBe(previous));
    await vi.waitFor(() => expect(transport.paused).toBe(false));
    expect(mocks.load.mock.calls.map(call => call[9])).toEqual([false, true]);
    expect(useDecodeCompatibilityStore.getState().enabled).toBe(false);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek', position: 12 }));
    expect(transport.currentTime).toBe(12); expect(transport.error).toBeNull();
    transport.setSource('https://example.com/next'); await transport.play();
    expect(mocks.load.mock.calls.at(-1)![9]).toBe(false);
});

it('honors a pause made while the compatibility choice is pending', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, send, event, state } = fixture();
    transport.setSource('https://example.com/song'); await transport.play();
    send({ position: 8, bufferedStart: 8, bufferedEnd: 8.5 });
    const previous = state().session;
    event({ event: 'error', session: previous, errorCode: 'STRICT_DECODE_FAILED' });
    transport.pause(); useDecodeCompatibilityStore.getState().prompt!.choose('once');
    await vi.waitFor(() => expect(state().session).not.toBe(previous));
    await vi.waitFor(() => expect(transport.currentTime).toBe(8));
    expect(transport.paused).toBe(true);
});

it('honors a new play request made while a paused song is awaiting the compatibility choice', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { transport, send, event, state } = fixture();
    transport.setSource('https://example.com/song'); await transport.play();
    transport.pause(); send({ position: 8, playing: false, bufferedStart: 8, bufferedEnd: 8.5 });
    event({ event: 'error', session: state().session, errorCode: 'STRICT_DECODE_FAILED' });
    const pending = transport.play(); useDecodeCompatibilityStore.getState().prompt!.choose('once');
    await pending;
    expect(transport.paused).toBe(false); expect(transport.currentTime).toBe(8);
});

it('reports a failed compatibility retry against its new session rather than repeating the strict prompt', async () => {
    const { transport, event, state } = fixture();
    transport.setSource('https://example.com/song'); await transport.play();
    event({ event: 'error', session: state().session, errorCode: 'STRICT_DECODE_FAILED' });
    mocks.load.mockRejectedValueOnce(Object.assign(new Error('Source disappeared'), { code: 'SOURCE_UNAVAILABLE' }));
    useDecodeCompatibilityStore.getState().prompt!.choose('once');
    await vi.waitFor(() => expect(transport.error?.nativeCode).toBe('SOURCE_UNAVAILABLE'));
    expect(transport.paused).toBe(true); expect(useDecodeCompatibilityStore.getState().prompt).toBeNull();
});

it('persists only the explicit always choice and does not offer strict recovery again for a compatibility decoder', async () => {
    vi.stubGlobal('window', {}); const setItem = vi.fn(); vi.stubGlobal('localStorage', { setItem });
    const { transport, event, state } = fixture();
    transport.setSource('https://example.com/song'); await transport.play();
    const previous = state().session;
    event({ event: 'error', session: previous, errorCode: 'STRICT_DECODE_FAILED' });
    useDecodeCompatibilityStore.getState().prompt!.choose('always');
    await vi.waitFor(() => expect(state().session).not.toBe(previous));
    await vi.waitFor(() => expect(transport.paused).toBe(false));
    expect(useDecodeCompatibilityStore.getState().enabled).toBe(true); expect(setItem).toHaveBeenCalled();
    event({ event: 'error', session: state().session, errorCode: 'STRICT_DECODE_FAILED' });
    expect(useDecodeCompatibilityStore.getState().prompt).toBeNull(); expect(transport.error?.nativeCode).toBe('STRICT_DECODE_FAILED');
    transport.setSource('https://example.com/next'); await transport.play();
    expect(mocks.load.mock.calls.at(-1)![9]).toBe(true);
});

it('aborts an obsolete compatibility choice and never reloads the previous song', async () => {
    const { transport, event, state } = fixture();
    transport.setSource('https://example.com/old'); await transport.play();
    event({ event: 'error', session: state().session, errorCode: 'STRICT_DECODE_FAILED' });
    const obsolete = useDecodeCompatibilityStore.getState().prompt!;
    transport.setSource('https://example.com/new'); await transport.play();
    obsolete.choose('always');
    expect(useDecodeCompatibilityStore.getState().prompt).toBeNull(); expect(useDecodeCompatibilityStore.getState().enabled).toBe(false);
    expect(mocks.load).toHaveBeenCalledTimes(2); expect(transport.src).toBe('https://example.com/new');
});

it.each(['asio', 'hqplayer'] as const)('reconstructs r29 buffered lyric interpolation for %s between device reports', async backend => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { transport, send } = fixture(backend);
    transport.setSource('https://example.com/interpolation'); await transport.play();
    send({ position: 2.12, bufferedStart: 2.12, bufferedEnd: 8, latency: 0 });
    now = 500;
    expect(transport.currentTime).toBeCloseTo(backend === 'hqplayer' ? 2.62 : 2.24, 5);
    now = 900;
    expect(transport.currentTime).toBeCloseTo(backend === 'hqplayer' ? 3.02 : 2.24, 5);
    now = 5000;
    expect(transport.currentTime).toBeCloseTo(backend === 'hqplayer' ? 4.12 : 2.24, 5);
    transport.currentTime = 10; await vi.waitFor(() => expect(transport.seeking).toBe(false));
    send({ position: 10, bufferedStart: 10, bufferedEnd: 10.3, latency: 0 });
    now += 1000;
    expect(transport.currentTime).toBeCloseTo(backend === 'hqplayer' ? 10.3 : 10.12, 5);
    transport.pause(); const pausedPosition = transport.currentTime; now += 1000;
    expect(transport.currentTime).toBe(pausedPosition);
});

it('rejects old preparation progress and state after a released-output resume', async () => {
    const { transport, request, send, state, event } = fixture('hqplayer');
    transport.setSource('https://example.com/operation'); await transport.play();
    send({ preparationRevision: 1, position: 20, bufferedStart: 20, bufferedEnd: 23 });
    transport.pause(); await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'pause' })));
    send({ preparationRevision: 2, playing: false });
    event({ event: 'progress', session: state().session, progress: { stage: 'buffer', preparationRevision: 1 } });
    expect(usePlaybackLoadStore.getState().progress).toBeNull();
    const original = request.getMockImplementation()!;
    let release!: () => void;
    const preparing = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async input => {
        if (input.action === 'play') {
            send({ preparationRevision: 3, playing: false });
            event({ event: 'progress', session: state().session, progress: { stage: 'source', preparationRevision: 3 } });
            await preparing;
        }
        return original(input);
    });
    const play = transport.play();
    await vi.waitFor(() => expect(usePlaybackLoadStore.getState().progress).toMatchObject({ stage: 'source', preparationRevision: 3 }));
    event({ event: 'progress', session: state().session, progress: { stage: 'buffer', preparationRevision: 1, loaded: 999 } });
    event({ event: 'progress', session: state().session, progress: { stage: 'decode', loaded: 999 } });
    event({ event: 'state', session: state().session, state: { ...state(), preparationRevision: 1, position: 0, ended: true } });
    expect(usePlaybackLoadStore.getState().progress).toMatchObject({ stage: 'source', preparationRevision: 3 });
    expect(transport.currentTime).toBeGreaterThanOrEqual(20); expect(transport.ended).toBe(false);
    release(); await play;
    expect(transport.paused).toBe(false); expect(usePlaybackLoadStore.getState().progress).toBeNull();
});

it.each(['asio', 'hqplayer'] as const)('uses the acknowledged %s position for the lyric clock after a rounded seek and resume', async backend => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture(backend); f.transport.setSource('https://example.com/live-pcm'); await f.transport.play();
    const original = f.request.getMockImplementation()!;
    let rounded = false;
    f.request.mockImplementation(async request => {
        const state = await original(request);
        return state && 'position' in state && (request.action === 'seek' || request.action === 'play' && rounded)
            ? { ...state, position: 11.998 } : state;
    });
    f.transport.currentTime = 12;
    await vi.waitFor(() => expect(f.transport.seeking).toBe(false));
    expect(f.transport.getOutputPosition()).toBe(11.998); expect(f.transport.currentTime).toBe(11.998);
    f.transport.pause(); rounded = true; await f.transport.play();
    expect(f.transport.getOutputPosition()).toBe(11.998); expect(f.transport.currentTime).toBe(11.998);
});
