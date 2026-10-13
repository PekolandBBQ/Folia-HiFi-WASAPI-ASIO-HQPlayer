// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAccountPlaybackCleanup } from '@/hooks/useAccountPlaybackCleanup';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { PlayerState, type SongResult } from '@/types';

// A logout must invalidate buffered playback as well as the provider's temporary URLs.
vi.hoisted(() => { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } }); });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });
function mount(active = true) {
    const song = { id: 'song', name: 'Song', durationMs: 1000, artists: [], album: { id: '', name: '' }, sourceRef: {
        kind: 'online', providerId: 'spotify', mediaId: 'song', providerData: { sessionBoundAudio: true } } } as SongResult;
    const audio = { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const props = { pendingSongRef: { current: song }, sourceRequestRef: { current: new AbortController() },
        playbackRequestIdRef: { current: 1 }, audioRef: { current: audio as unknown as HTMLAudioElement }, shouldAutoPlayRef: { current: true } };
    usePlaybackStore.setState({ currentSong: active ? song : null, audioSrc: active ? 'http://127.0.0.1/temporary' : null, playerState: PlayerState.PLAYING });
    useOnlineProviderAccountStore.getState().updateAccount('spotify', { status: 'authenticated', user: { id: 'a', nickname: 'Account' } });
    function Probe() { useAccountPlaybackCleanup(props); return null; }
    root = createRoot(document.createElement('div')); act(() => root!.render(React.createElement(Probe)));
    return { props, audio };
}
describe('Session-bound playback logout', () => {
    it('clears the deck and cancels pending source work immediately', () => {
        const { props, audio } = mount();
        act(() => useOnlineProviderAccountStore.getState().clearAccount('spotify'));
        expect(props.sourceRequestRef.current.signal.aborted).toBe(true); expect(props.playbackRequestIdRef.current).toBe(2);
        expect(props.shouldAutoPlayRef.current).toBe(false); expect(audio.pause).toHaveBeenCalledOnce();
        expect(audio.removeAttribute).toHaveBeenCalledWith('src');
        expect(usePlaybackStore.getState()).toMatchObject({ audioSrc: null, playerState: PlayerState.PAUSED });
    });
    it('does not stop an unrelated deck or abort on another provider logout', () => {
        const { props, audio } = mount(false);
        act(() => useOnlineProviderAccountStore.getState().clearAccount('netease'));
        expect(props.sourceRequestRef.current.signal.aborted).toBe(false);
        act(() => useOnlineProviderAccountStore.getState().clearAccount('spotify'));
        expect(props.sourceRequestRef.current.signal.aborted).toBe(true); expect(audio.pause).not.toHaveBeenCalled();
    });
});
