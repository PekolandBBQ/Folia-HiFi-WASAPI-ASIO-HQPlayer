import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioTransport, reloadRecoveredNativeSource } from '../../../src/services/nativeAudio/NativeAudioTransport';
import type { NativeAudioApi, NativeAudioEvent, NativeAudioState } from '../../../src/types/nativeAudio';

// test/unit/nativeAudio/transport.test.ts — race and clock contracts at the media adapter boundary.
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../../src/services/nativeAudio/loadLocalFile', () => ({ loadNativeLocalFile: mocks.load }));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.clearAllMocks(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(backend: 'asio' | 'hqplayer' = 'asio', rememberGain = false, onGain = vi.fn()) {
    let listener: (event: NativeAudioEvent) => void = () => {};
    let state: NativeAudioState = { session: '', position: 0, duration: 10, playing: false, ended: false,
        sampleRate: 48000, channels: 2, latency: backend === 'hqplayer' ? 0 : 0.02, backend, deviceId: 'test' };
    const request = vi.fn(async ({ action, position, session, gainDb }: Parameters<NativeAudioApi['request']>[0]) => {
        if (action === 'stop') return {};
        if (session !== state.session) throw new Error('Stale playback session');
        if (action === 'play') state = { ...state, playing: true, ended: false, position: state.ended ? 0 : state.position };
        if (action === 'pause') state = { ...state, playing: false };
        if (action === 'seek') state = { ...state, position: position!, ended: false };
        if (action === 'gain') state = { ...state, hqplayerGainDb: gainDb };
        return { ...state };
    });
    const api: NativeAudioApi = { supported: true, request, onEvent: fn => { listener = fn; return vi.fn(); } };
    mocks.load.mockImplementation(async (_api, session) => { state = { ...state, session, position: 0, playing: false }; return { ...state }; });
    const transport = new NativeAudioTransport(api, backend, 'test', 'compatibility', async () => new File(['audio'], 'song.flac'));
    transport.setHQPlayerGainSettings(-2, rememberGain, onGain);
    cleanups.push(() => transport.dispose());
    const send = (patch: Partial<NativeAudioState>) => {
        state = { ...state, ...patch };
        listener({ event: 'state', session: state.session, state: { ...state } });
    };
    return { transport, request, send, state: () => state, event: (event: NativeAudioEvent) => listener(event) };
}

describe('native transport', () => {
    it('resumes an explicitly applied HQPlayer checkpoint but ignores stale sessions and ordinary late polls', async () => {
        const { transport, event, state, send } = fixture('hqplayer');
        transport.setSource('blob:resume'); await flush();
        send({ position: 4, playing: true });
        expect(transport.paused).toBe(true);
        const play = vi.fn(), playing = vi.fn();
        transport.addEventListener('play', play); transport.addEventListener('playing', playing);
        event({ event: 'resume', session: 'old', state: { ...state(), position: 7, playing: true } });
        expect(play).not.toHaveBeenCalled();
        event({ event: 'resume', session: state().session, state: { ...state(), position: 7, playing: true } });
        expect(transport.paused).toBe(false); expect(transport.currentTime).toBeCloseTo(7, 1);
        expect(play).toHaveBeenCalledOnce(); expect(playing).toHaveBeenCalledOnce();
    });
    it('keeps the HQPlayer clock linear between its one-second position steps', async () => {
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        try {
            const { transport, send } = fixture('hqplayer');
            transport.setSource('blob:hqplayer'); await flush(); await transport.play();
            now = 100; send({ position: 0, playing: true, latency: 1 });
            for (now = 200; now <= 800; now += 200) send({ position: 0, playing: true, latency: 1 });
            now = 900; expect(transport.currentTime).toBe(0);
            now = 2000; expect(transport.currentTime).toBeCloseTo(1, 3);
            now = 2133; send({ position: 1.133, playing: true, latency: 1 });
            now = 2500; send({ position: 1.133, playing: true, latency: 1 });
            expect(transport.currentTime).toBeCloseTo(1.5, 3);
        } finally { clock.mockRestore(); }
    });
    it('treats an external HQPlayer stop as pause at the beginning, not track completion', async () => {
        const { transport, send } = fixture('hqplayer');
        const ended = vi.fn(); const paused = vi.fn();
        transport.addEventListener('ended', ended); transport.addEventListener('pause', paused);
        transport.setSource('blob:hqplayer'); await flush(); await transport.play();
        send({ position: 12, duration: 180, playing: true, ended: false });
        send({ position: 0, duration: 180, playing: false, ended: false });
        expect(transport.currentTime).toBe(0); expect(transport.paused).toBe(true);
        expect(paused).toHaveBeenCalledTimes(1); expect(ended).not.toHaveBeenCalled();
    });
    it('applies live HQPlayer gain changes and remembers gain reported by Desktop', async () => {
        const observed = vi.fn();
        const { transport, request, send } = fixture('hqplayer', true, observed);
        transport.setSource('blob:hqplayer'); await flush();
        transport.setHQPlayerGainSettings(-3, true, observed); await flush();
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'gain', gainDb: -3 }));
        send({ hqplayerGainDb: -4.5 });
        expect(observed).toHaveBeenCalledWith(-4.5);
    });

    it('reloads an errored native source when provider refresh returns the same URL', async () => {
        const { transport, event, state } = fixture();
        transport.setSource('blob:same'); await flush();
        const previous = state().session;
        event({ event: 'error', session: previous, errorCode: 'SOURCE_EXPIRED' });
        const ready = vi.fn(() => { void transport.play(); });
        expect(reloadRecoveredNativeSource(transport.asMediaElement(), 'blob:same', ready)).toBe(true);
        await flush();
        expect(state().session).not.toBe(previous);
        expect(transport.error).toBeNull();
        expect(transport.readyState).toBe(4);
        expect(ready).toHaveBeenCalledOnce();
        expect(transport.paused).toBe(false);
    });
    it('never reloads a healthy source, a changed source, or the browser deck', async () => {
        const { transport } = fixture();
        transport.setSource('blob:same'); await flush();
        expect(reloadRecoveredNativeSource(transport.asMediaElement(), 'blob:same')).toBe(false);
        expect(reloadRecoveredNativeSource(transport.asMediaElement(), 'blob:new')).toBe(false);
        const browser = { currentSrc: 'blob:same', error: {}, removeAttribute: vi.fn(), setAttribute: vi.fn() };
        expect(reloadRecoveredNativeSource(browser as unknown as HTMLAudioElement, 'blob:same')).toBe(false);
        expect(browser.removeAttribute).not.toHaveBeenCalled();
    });
    it('does not rewind poster lyric frames when IPC snapshots lag interpolation, but allows backward seeks', async () => {
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        try {
            const { transport, send } = fixture();
            transport.setSource('blob:poster'); await flush(); await transport.play();
            let previous = 0;
            for (let packet = 1; packet <= 100; packet++) {
                now = packet * 40;
                previous = transport.currentTime;
                send({ position: Math.max(0, now / 1000 - 0.025) });
                expect(transport.currentTime).toBeGreaterThanOrEqual(previous);
                // Holding an already displayed frame must not accumulate extra lead per packet.
                expect(transport.currentTime).toBeLessThanOrEqual(now / 1000 + 0.001);
            }
            now += 1000;
            expect(transport.currentTime).toBeLessThanOrEqual(4.095);
            transport.currentTime = 1; await flush();
            expect(transport.currentTime).toBe(1);
            transport.pause(); await flush();
            now += 1000;
            expect(transport.currentTime).toBe(1);
        } finally { clock.mockRestore(); }
    });
    it('loads paused, preserves the source identity and routes play/pause without a DOM player', async () => {
        const { transport, request } = fixture();
        const metadata = vi.fn(); transport.addEventListener('loadedmetadata', metadata);
        transport.setSource('blob:local-one'); await flush();
        expect(metadata).toHaveBeenCalledTimes(1);
        expect(transport.duration).toBe(10); expect(transport.paused).toBe(true);
        expect(transport.getAttribute('src')).toBe('blob:local-one');
        expect(request.mock.calls.some(([command]) => command.action === 'play')).toBe(false);
        await transport.play(); expect(transport.paused).toBe(false);
        transport.pause(); await flush();
        expect(transport.paused).toBe(true);
        const paused = transport.currentTime; await flush(); expect(transport.currentTime).toBe(paused);
    });
    it('does not emit pause for an already-paused load and erase the existing autoplay intent', async () => {
        const { transport } = fixture(); const paused = vi.fn(); transport.addEventListener('pause', paused);
        transport.setSource('blob:local'); transport.pause(); await flush();
        expect(paused).not.toHaveBeenCalled();
    });
    it('cancels a play requested while decoding if the listener pauses', async () => {
        const { transport, request, state } = fixture();
        let release!: () => void;
        mocks.load.mockImplementation(async (_api, session) => {
            await new Promise<void>(resolve => { release = resolve; });
            return { ...state(), session };
        });
        transport.setSource('blob:local'); await flush();
        const pending = transport.play(); transport.pause(); release();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(request.mock.calls.some(([command]) => command.action === 'play')).toBe(false);
    });
    it('ignores old sessions and clears the clock when the source is removed', async () => {
        const { transport, event, state } = fixture();
        transport.setSource('blob:one'); await flush(); await transport.play();
        const old = state(); transport.setSource('');
        event({ event: 'state', session: old.session, state: { ...old, position: 8 } });
        expect(transport.currentTime).toBe(0); expect(transport.paused).toBe(true);
    });
    it('holds the requested seek position while old progress is still arriving', async () => {
        const { transport, request, send, state } = fixture();
        transport.setSource('blob:one'); await flush(); await transport.play();
        let release!: (value: NativeAudioState) => void;
        request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        transport.currentTime = 7; await flush();
        send({ position: 1 }); expect(transport.currentTime).toBe(7);
        release({ ...state(), position: 7 }); await flush();
        expect(transport.seeking).toBe(false); expect(transport.currentTime).toBeGreaterThanOrEqual(7);
    });
    it('emits one ended event, and implements repeat-one through native play', async () => {
        const { transport, send } = fixture(); const ended = vi.fn(); transport.addEventListener('ended', ended);
        transport.setSource('blob:one'); await flush(); await transport.play();
        send({ position: 10, playing: false, ended: true }); send({ position: 10, playing: false, ended: true });
        expect(ended).toHaveBeenCalledTimes(1);
        transport.loop = true; await transport.play();
        send({ position: 10, playing: false, ended: true }); await flush();
        expect(transport.paused).toBe(false); expect(transport.ended).toBe(false);
        expect(ended).toHaveBeenCalledTimes(1);
    });
    it('stops on driver failure and does not let interpolation run indefinitely', async () => {
        const { transport, event, state } = fixture();
        transport.setSource('blob:one'); await flush(); await transport.play();
        await new Promise(resolve => setTimeout(resolve, 160));
        expect(transport.currentTime).toBeLessThanOrEqual(0.12);
        event({ event: 'error', session: state().session, errorCode: 'DEVICE_UNAVAILABLE' });
        expect(transport.paused).toBe(true); expect(transport.error?.nativeCode).toBe('DEVICE_UNAVAILABLE');
    });
});
