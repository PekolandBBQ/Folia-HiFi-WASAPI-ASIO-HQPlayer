import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioTransport } from '../../../src/services/nativeAudio/NativeAudioTransport';
import type { NativeAudioApi, NativeAudioEvent, NativeAudioState } from '../../../src/types/nativeAudio';

// test/unit/nativeAudio/transport.test.ts — race and clock contracts at the media adapter boundary.
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../../src/services/nativeAudio/loadLocalFile', () => ({ loadNativeLocalFile: mocks.load }));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.clearAllMocks(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture() {
    let listener: (event: NativeAudioEvent) => void = () => {};
    let state: NativeAudioState = { session: '', position: 0, duration: 10, playing: false, ended: false,
        sampleRate: 48000, channels: 2, latency: 0.02, backend: 'asio', deviceId: 'test' };
    const request = vi.fn(async ({ action, position, session }: Parameters<NativeAudioApi['request']>[0]) => {
        if (action === 'stop') return {};
        if (session !== state.session) throw new Error('Stale playback session');
        if (action === 'play') state = { ...state, playing: true, ended: false, position: state.ended ? 0 : state.position };
        if (action === 'pause') state = { ...state, playing: false };
        if (action === 'seek') state = { ...state, position: position!, ended: false };
        return { ...state };
    });
    const api: NativeAudioApi = { supported: true, request, onEvent: fn => { listener = fn; return vi.fn(); } };
    mocks.load.mockImplementation(async (_api, session) => { state = { ...state, session, position: 0, playing: false }; return { ...state }; });
    const transport = new NativeAudioTransport(api, 'asio', 'test', async () => new File(['audio'], 'song.flac'));
    cleanups.push(() => transport.dispose());
    const send = (patch: Partial<NativeAudioState>) => {
        state = { ...state, ...patch };
        listener({ event: 'state', session: state.session, state: { ...state } });
    };
    return { transport, request, send, state: () => state, event: (event: NativeAudioEvent) => listener(event) };
}

describe('native transport', () => {
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
        event({ event: 'error', session: state().session, error: 'device removed' });
        expect(transport.paused).toBe(true); expect(transport.error?.message).toBe('device removed');
    });
});
