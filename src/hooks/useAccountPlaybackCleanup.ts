import { useEffect, type MutableRefObject } from 'react';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { isSessionBoundAudio } from '../services/onlineMusic/audioPolicy';
import { PlayerState, type SongResult } from '../types';

// Stop account-bound decks and pending preparation synchronously when their account is cleared.
export function useAccountPlaybackCleanup({ pendingSongRef, sourceRequestRef, playbackRequestIdRef, audioRef, shouldAutoPlayRef }: {
    pendingSongRef: MutableRefObject<SongResult | null>;
    sourceRequestRef: MutableRefObject<AbortController | null>;
    playbackRequestIdRef: MutableRefObject<number>;
    audioRef: MutableRefObject<HTMLAudioElement | null>;
    shouldAutoPlayRef: MutableRefObject<boolean>;
}) {
    useEffect(() => useOnlineProviderAccountStore.subscribe((next, previous) => {
        const cleared = (song: SongResult | null) => {
            if (!song || !isSessionBoundAudio(song) || song.sourceRef?.kind !== 'online') return false;
            const id = song.sourceRef.providerId;
            return next.accounts[id]?.status === 'anonymous' && previous.accounts[id] !== next.accounts[id];
        };
        if (cleared(pendingSongRef.current)) {
            sourceRequestRef.current?.abort(); playbackRequestIdRef.current++;
        }
        if (cleared(usePlaybackStore.getState().currentSong)) {
            shouldAutoPlayRef.current = false;
            audioRef.current?.pause(); audioRef.current?.removeAttribute('src'); audioRef.current?.load();
            usePlaybackStore.setState({ audioSrc: null, playerState: PlayerState.PAUSED, transitionDisplay: null });
        }
    }), [pendingSongRef, sourceRequestRef, playbackRequestIdRef, audioRef, shouldAutoPlayRef]);
}
