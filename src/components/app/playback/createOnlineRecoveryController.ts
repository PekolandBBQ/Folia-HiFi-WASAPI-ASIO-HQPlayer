import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { applyOnlineAudioSourceMetadata, loadOnlineSongAudioSource } from '../../../services/onlinePlayback';
import { PlayerState, type SongResult } from '../../../types';
import type { AudioQualityPreference } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { isOnlinePlaybackCancellation } from './onlinePlaybackFailure';
import { isSessionBoundAudio } from '../../../services/onlineMusic/audioPolicy';
import { beginPlaybackSourceRequest, cancelPlaybackSourceRequest, finishPlaybackSourceRequest } from '../../../services/playbackSourceRequest';
import {
    getPlaybackSongKey,
    isLocalPlaybackSong,
    isNavidromePlaybackSong,
    isSamePlaybackSong,
    isStagePlaybackSong,
    replacePlaybackSongInQueue,
} from '../../../utils/appPlaybackGuards';
import { setAudioSrc, setCurrentSong, setPlayerState, setPlayQueue, usePlaybackStore } from '../../../stores/usePlaybackStore';

// src/components/app/playback/createOnlineRecoveryController.ts

type RecoveryControllerParams = {
    audioQuality: AudioQualityPreference;
    currentSong: SongResult | null;
    audioSrc: string | null;
    audioRef: RefObject<HTMLAudioElement | null>;
    currentSongRef: MutableRefObject<string | number | null>;
    blobUrlRef: MutableRefObject<string | null>;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    pendingResumeTimeRef: MutableRefObject<number | null>;
    onlinePlaybackRecoveryRef: MutableRefObject<Promise<boolean> | null>;
    lastAudioRecoverySourceRef: MutableRefObject<string | null>;
    currentOnlineAudioUrlFetchedAtRef: MutableRefObject<number | null>;
    persistLastPlaybackCache: (song: SongResult | null, queue: SongResult[]) => Promise<void>;
    playQueue: SongResult[];
    onlineAudioUrlTtlMs: number;
    onlineAudioUrlRefreshBufferMs: number;
};

// Provider stream URLs carry a per-request token in the query (QQ mints a fresh `vkey`/`guid`
// every call), so comparing whole URLs never matches and the error -> refresh -> error cycle
// runs unbounded. The origin+path identifies the media file itself, which is what "we already
// refreshed this and it still failed" actually means. Cleared again once playback succeeds.
export const getOnlineRecoveryKey = (src: string | null | undefined): string | null => {
    if (!src) {
        return null;
    }

    try {
        const parsedUrl = new URL(src);
        // Only remote streams carry a token in the query; blob: and friends have no meaningful origin.
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return src;
        }
        return `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch {
        return src;
    }
};

// Creates online-stream refresh and recovery helpers without tying them to a React hook.
export const createOnlineRecoveryController = ({
    audioQuality,
    currentSong,
    audioSrc,
    audioRef,
    currentSongRef,
    blobUrlRef,
    shouldAutoPlayRef,
    pendingResumeTimeRef,
    onlinePlaybackRecoveryRef,
    lastAudioRecoverySourceRef,
    currentOnlineAudioUrlFetchedAtRef,
    persistLastPlaybackCache,
    playQueue,
    onlineAudioUrlTtlMs,
    onlineAudioUrlRefreshBufferMs,
}: RecoveryControllerParams) => {
    const shouldRefreshCurrentOnlineAudioSource = () => {
        if (!currentSong || isLocalPlaybackSong(currentSong) || isNavidromePlaybackSong(currentSong) || isStagePlaybackSong(currentSong)) {
            return false;
        }

        // Paused restoration intentionally leaves session-bound audio unprepared.
        // This predicate is spent by explicit resume, before calling an empty deck's play().
        if (!audioSrc) return isSessionBoundAudio(currentSong);
        if (audioSrc.startsWith('blob:')) {
            return false;
        }

        const fetchedAt = currentOnlineAudioUrlFetchedAtRef.current;
        if (!fetchedAt) {
            return false;
        }

        return Date.now() - fetchedAt >= onlineAudioUrlTtlMs - onlineAudioUrlRefreshBufferMs;
    };

    const recoverOnlinePlaybackSource = async ({
        failedSrc,
        resumeAt,
        autoplay,
        shouldAutoplay,
    }: {
        failedSrc?: string | null;
        resumeAt?: number;
        autoplay: boolean;
        shouldAutoplay?: () => boolean;
    }): Promise<boolean> => {
        const song = currentSong;
        const isSpotify = song?.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'spotify';
        const audioElement = audioRef.current;

        if (!song || !audioElement || isLocalPlaybackSong(song) || isNavidromePlaybackSong(song) || isStagePlaybackSong(song)) {
            return false;
        }

        if (currentSongRef.current !== getPlaybackSongKey(song)) throw new DOMException('Playback request superseded', 'AbortError');
        const sessionBoundAudio = isSessionBoundAudio(song);
        if (sessionBoundAudio) {
            const playback = usePlaybackStore.getState();
            if (!playback.currentSong || getPlaybackSongKey(playback.currentSong) !== getPlaybackSongKey(song)
                || failedSrc && playback.audioSrc !== failedSrc) {
                throw new DOMException('Playback source superseded', 'AbortError');
            }
        }

        // The element error event and its play() rejection can ask together.
        // Join the current attempt before the guard for an already completed source.
        if (onlinePlaybackRecoveryRef.current) {
            return onlinePlaybackRecoveryRef.current;
        }

        // A failed paused handoff only discards its matching session URL. The song and
        // checkpoint stay selected; the next explicit Play prepares a fresh source.
        if (sessionBoundAudio && !autoplay) {
            if (!failedSrc || !audioElement.error) return false;
            cancelPlaybackSourceRequest();
            const position = pendingResumeTimeRef.current ?? resumeAt ?? audioElement.currentTime;
            pendingResumeTimeRef.current = Number.isFinite(position) ? Math.max(0, position) : 0;
            shouldAutoPlayRef.current = false;
            lastAudioRecoverySourceRef.current = null;
            currentOnlineAudioUrlFetchedAtRef.current = null;
            setPlayerState(PlayerState.PAUSED);
            setAudioSrc(null);
            return true;
        }

        const normalizedFailedSrc = getOnlineRecoveryKey(failedSrc || audioElement.currentSrc || audioSrc || null);
        if (normalizedFailedSrc && lastAudioRecoverySourceRef.current === normalizedFailedSrc) {
            return false;
        }

        let recoveryTask: Promise<boolean> | null = null;
        const sourceRequest = beginPlaybackSourceRequest(song, () => {
            shouldAutoPlayRef.current = false;
            if (onlinePlaybackRecoveryRef.current === recoveryTask) onlinePlaybackRecoveryRef.current = null;
        });
        recoveryTask = (async () => {
            if (normalizedFailedSrc) {
                lastAudioRecoverySourceRef.current = normalizedFailedSrc;
            }

            try {
                const audioResult = await loadOnlineSongAudioSource(song, audioQuality, null, sourceRequest.signal);
                if (sourceRequest.signal.aborted) throw new DOMException('Playback request cancelled', 'AbortError');
                if (currentSongRef.current !== getPlaybackSongKey(song) || !audioRef.current) {
                    if (isSpotify) throw new DOMException('Playback request superseded', 'AbortError');
                    return false;
                }

                if (audioResult.kind === 'unavailable') {
                    return false;
                }

                if (blobUrlRef.current && blobUrlRef.current !== audioResult.blobUrl) {
                    URL.revokeObjectURL(blobUrlRef.current);
                    blobUrlRef.current = null;
                }

                if (audioResult.blobUrl) {
                    blobUrlRef.current = audioResult.blobUrl;
                }

                const resolvedSong = applyOnlineAudioSourceMetadata(song, audioResult.replayGain);
                const replayGain = resolvedSong.replayGain;
                if (replayGain) {
                    setCurrentSong(prev => {
                        if (!prev || !isSamePlaybackSong(prev, song)) return prev;
                        return { ...prev, replayGain };
                    });
                    const resolvedQueue = replacePlaybackSongInQueue(playQueue, resolvedSong);
                    setPlayQueue(resolvedQueue);
                    void persistLastPlaybackCache(
                        resolvedSong,
                        resolvedQueue,
                    );
                }

                // A paused handoff has no prepared deck, so its currentTime is still zero.
                // Keep the saved resume position until this first explicit Play creates audio.
                const deferredPosition = !audioSrc && isSessionBoundAudio(song) ? pendingResumeTimeRef.current : null;
                pendingResumeTimeRef.current = Math.max(0, deferredPosition ?? resumeAt ?? audioRef.current.currentTime ?? 0);
                // Source recovery must follow the latest transport intent after its await.
                shouldAutoPlayRef.current = autoplay && (shouldAutoplay?.() ?? true);
                currentOnlineAudioUrlFetchedAtRef.current = audioResult.audioSrc.startsWith('blob:')
                    ? null
                    : Date.now();
                setAudioSrc(audioResult.audioSrc);
                return true;
            } catch (error) {
                if (isSpotify && (currentSongRef.current !== getPlaybackSongKey(song) || !audioRef.current)) {
                    throw new DOMException('Playback request superseded', 'AbortError');
                }
                if (isOnlinePlaybackCancellation(error)) throw error;
                // Connection failures need the same user action as initial playback, not a track skip.
                if (error instanceof OnlineProviderError && error.providerId === 'spotify') {
                    lastAudioRecoverySourceRef.current = null;
                    shouldAutoPlayRef.current = false;
                    throw error;
                }
                console.error('[App] Failed to recover online playback source', error);
                return false;
            } finally {
                finishPlaybackSourceRequest(sourceRequest);
                if (onlinePlaybackRecoveryRef.current === recoveryTask) onlinePlaybackRecoveryRef.current = null;
            }
        })();

        onlinePlaybackRecoveryRef.current = recoveryTask;
        return recoveryTask;
    };

    return {
        shouldRefreshCurrentOnlineAudioSource,
        recoverOnlinePlaybackSource,
    };
};
