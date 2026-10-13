import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePlaybackQueueController } from '@/hooks/usePlaybackQueueController';
import { usePlaybackAudioBridge } from '@/hooks/usePlaybackAudioBridge';
import PlaybackDeck from '@/components/app/playback/PlaybackDeck';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import type { NativeAudioTransport } from '@/services/nativeAudio/NativeAudioTransport';
import type { NativeAudioBackend } from '@/types/nativeAudio';
import type { SongResult } from '@/types';

// test/unit/playback/spotifyQueueDriver.tsx: controlled production queue/deck/autoplay composition; HTTP/OS/PCM boundaries come from the supplied main fixture.
const ref = <T,>(current: T) => ({ current });
const noop = () => {};
const noValue = () => null;
const noFile = async () => null;
const noAction = async () => {};
const one = () => 1;
export function createSpotifyQueueDriver(main: any, options: {
    backend?: NativeAudioBackend;
    onEvent?: (name: string, data?: Record<string, unknown>) => void;
} = {}) {
    const backend = options.backend || 'asio', onEvent = options.onEvent || noop;
    let queue!: ReturnType<typeof usePlaybackQueueController>;
    const audioRef = ref<HTMLAudioElement | null>(null), shouldAutoPlayRef = ref(false);
    const audioContextRef = ref<AudioContext | null>(null);
    const register = (element: HTMLAudioElement | null) => { audioRef.current = element; onEvent('deck-register', { connected: Boolean(element) }); };
    const refs = {
        audioRef, shouldAutoPlayRef, blobUrlRef: ref<string | null>(null), currentSongRef: ref<string | null>(null),
        mainPlaybackSnapshotRef: ref(null), playbackAutoSkipCountRef: ref(0), pendingResumeTimeRef: ref(null),
        currentOnlineAudioUrlFetchedAtRef: ref(null), lastAudioRecoverySourceRef: ref(null),
    };
    const bridgeRefs = { audioContextRef, analyserRef: ref(null), gainNodeRef: ref(null), suppressAutoplayRef: ref(false) };
    function Probe() {
        const [isLyricsLoading, setIsLyricsLoading] = useState(false);
        const audioSrc = usePlaybackStore(state => state.audioSrc);
        const loopMode = useAudioSettingsStore(state => state.loopMode);
        queue = usePlaybackQueueController({
            isNowPlayingStageActive: false, shouldNavigateToPlayerOnTrackChange: false,
            localSongs: [], localLibraryCatalog: {}, setLyrics: noop, setIsLyricsLoading,
            navigateToPlaybackView: noop, navigateToSearch: noop, persistLastPlaybackCache: noAction,
            restoreCachedThemeForSong: noAction, interruptStagePlaybackForMainTransition: noop,
            onPlayLocalSong: noAction, onPlayNavidromeSong: noAction, onAddLocalSongToQueue: noop,
            onAddNavidromeSongsToQueue: noop, searchDeps: { submitSearch: noAction, loadMoreSearchResults: noAction }, ...refs,
        } as unknown as Parameters<typeof usePlaybackQueueController>[0]);
        usePlaybackAudioBridge({ nativePlayback: true, audioRef, localSongs: [], isLyricsLoading, shouldAutoPlayRef,
            ...bridgeRefs, connectDecks: () => false, getActiveChain: noValue, isAutoplayHeld: false,
            syncOutputGain: noop, getTargetPlaybackVolume: one, getCoverUrl: noValue, updateCacheSize: noop });
        return <PlaybackDeck register={register} src={audioSrc || ''} nativeBackend={backend}
            nativeDeviceId={backend === 'hqplayer' ? 'hqplayer-local' : 'fixture-output'} nativeProcessingMode="integer-direct"
            getLocalFile={noFile} loop={loopMode === 'one'}
            onLoadStart={() => onEvent('deck-loadstart')} onCanPlay={() => onEvent('deck-canplay')}
            onPlaying={() => onEvent('deck-playing')} onError={() => onEvent('deck-error', { error: audioRef.current?.error })} />;
    }
    window.electron = { ...window.electron, nativeAudio: main.api } as typeof window.electron;
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    return {
        get queue() { return queue; }, get transport() { return audioRef.current as unknown as NativeAudioTransport; },
        async select(song: SongResult, songs: SongResult[]) { onEvent('user-select-intent', { trackId: song.id }); await act(async () => { await queue.playSong(song, songs); }); },
        async next() { onEvent('user-next-intent'); await act(async () => { await queue.handleNextTrack(); }); },
        async previous() { onEvent('user-previous-intent'); await act(async () => { queue.handlePrevTrack(); }); },
        close() { act(() => root.unmount()); },
    };
}
