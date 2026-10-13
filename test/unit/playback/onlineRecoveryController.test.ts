import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadAudioSourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlinePlayback', () => ({
    loadOnlineSongAudioSource: loadAudioSourceMock,
    applyOnlineAudioSourceMetadata: (song: unknown) => song,
}));

import {
    createOnlineRecoveryController,
    getOnlineRecoveryKey,
} from '@/components/app/playback/createOnlineRecoveryController';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import type { SongResult } from '@/types';

// test/unit/playback/onlineRecoveryController.test.ts

const song: SongResult = {
    id: 'qq-song',
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    qqMid: '004Th6td4LaoZs',
    sourceRef: { kind: 'online', providerId: 'qq', mediaId: '004Th6td4LaoZs' },
};

const ref = <T,>(value: T) => ({ current: value });

// QQ mints a fresh vkey/guid per request, so consecutive refreshes of one file differ only in query.
const streamUrl = (vkey: string) =>
    `http://isure.stream.qqmusic.qq.com/M800004Th6td4LaoZs004Th6td4LaoZs.mp3?guid=${vkey}&vkey=${vkey}&uin=1&fromtag=8`;

const createController = (audioSrc: string) => {
    const lastAudioRecoverySourceRef = ref<string | null>(null);
    const audioRef = ref<HTMLAudioElement | null>({ currentTime: 0, currentSrc: audioSrc } as HTMLAudioElement);
    const setAudioSrc = vi.fn();

    const controller = createOnlineRecoveryController({
        audioQuality: 'high',
        currentSong: song,
        audioSrc,
        audioRef,
        currentSongRef: ref<string | number | null>(getPlaybackSongKey(song)),
        blobUrlRef: ref<string | null>(null),
        shouldAutoPlayRef: ref(false),
        pendingResumeTimeRef: ref<number | null>(null),
        onlinePlaybackRecoveryRef: ref<Promise<boolean> | null>(null),
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef: ref<number | null>(null),
        setAudioSrc,
        setCurrentSong: vi.fn(),
        setPlayQueue: vi.fn(),
        persistLastPlaybackCache: vi.fn(async () => undefined),
        playQueue: [song],
        onlineAudioUrlTtlMs: 60_000,
        onlineAudioUrlRefreshBufferMs: 5_000,
    } as unknown as Parameters<typeof createOnlineRecoveryController>[0]);

    return { controller, lastAudioRecoverySourceRef, setAudioSrc };
};

describe('online playback recovery bounds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keys retries on the media path so a re-minted stream token cannot restart the loop', () => {
        expect(getOnlineRecoveryKey(streamUrl('one'))).toBe(getOnlineRecoveryKey(streamUrl('two')));
        expect(getOnlineRecoveryKey(streamUrl('one')))
            .toBe('http://isure.stream.qqmusic.qq.com/M800004Th6td4LaoZs004Th6td4LaoZs.mp3');
        expect(getOnlineRecoveryKey('blob:folia/abc')).toBe('blob:folia/abc');
        expect(getOnlineRecoveryKey(null)).toBeNull();
    });

    it('refuses a second recovery for the same media file after the refreshed URL also fails', async () => {
        const firstUrl = streamUrl('one');
        const { controller } = createController(firstUrl);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two') });

        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: firstUrl, autoplay: true }))
            .resolves.toBe(true);
        // The refreshed URL fails too. Before this guard the differing vkey made it look brand new,
        // so the error -> refresh -> error cycle never reached skipAfterPlaybackFailure().
        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('two'), autoplay: true }))
            .resolves.toBe(false);
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(1);
    });

    it('allows a refresh again once the source actually played', async () => {
        const firstUrl = streamUrl('one');
        const { controller, lastAudioRecoverySourceRef } = createController(firstUrl);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two') });

        await controller.recoverOnlinePlaybackSource({ failedSrc: firstUrl, autoplay: true });
        // Stands in for the audio element's `playing` event clearing the guard.
        lastAudioRecoverySourceRef.current = null;

        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('two'), autoplay: true }))
            .resolves.toBe(true);
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(2);
    });
});

import { PlayerState } from '@/types';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { cancelPlaybackSourceRequest } from '@/services/playbackSourceRequest';

const spotifySong: SongResult = { id: 'spotify-song', name: 'Spotify song', artists: [],
    album: { id: 'album', name: 'Album' }, durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'spotify-song', providerData: { sessionBoundAudio: true } } };
const sessionSrc = 'http://127.0.0.1/session/expired/audio.wav';

function sessionController(audioSrc: string | null = sessionSrc) {
    const refs = {
        audioRef: ref<HTMLAudioElement | null>({ currentTime: 0, currentSrc: audioSrc || '', error: { code: 2 } } as HTMLAudioElement),
        currentSongRef: ref<string | number | null>(getPlaybackSongKey(spotifySong)),
        shouldAutoPlayRef: ref(false), pendingResumeTimeRef: ref<number | null>(42.75),
        onlinePlaybackRecoveryRef: ref<Promise<boolean> | null>(null),
        lastAudioRecoverySourceRef: ref<string | null>('old-recovery-key'),
        currentOnlineAudioUrlFetchedAtRef: ref<number | null>(Date.now()),
    };
    const controller = createOnlineRecoveryController({ audioQuality: 'high', currentSong: spotifySong, audioSrc,
        ...refs, blobUrlRef: ref<string | null>(null), persistLastPlaybackCache: vi.fn(async () => undefined),
        playQueue: [spotifySong], onlineAudioUrlTtlMs: 60_000, onlineAudioUrlRefreshBufferMs: 5_000 });
    return { controller, ...refs };
}

describe('session-bound paused failure and explicit resume', () => {
    beforeEach(() => {
        cancelPlaybackSourceRequest();
        loadAudioSourceMock.mockReset();
        usePlaybackStore.setState({ currentSong: spotifySong, audioSrc: sessionSrc,
            playQueue: [spotifySong], playerState: PlayerState.PAUSED });
    });

    it('handles a paused expired source without fetching or advancing and keeps the saved checkpoint', async () => {
        const f = sessionController();
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, resumeAt: 0, autoplay: false })).resolves.toBe(true);
        expect(usePlaybackStore.getState()).toMatchObject({ currentSong: spotifySong, audioSrc: null,
            playQueue: [spotifySong], playerState: PlayerState.PAUSED });
        expect(f.pendingResumeTimeRef.current).toBe(42.75);
        expect(f.shouldAutoPlayRef.current).toBe(false);
        expect(f.lastAudioRecoverySourceRef.current).toBeNull();
        expect(f.currentOnlineAudioUrlFetchedAtRef.current).toBeNull();
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
    });

    it('does not clear a newer URL for the same song after a stale failure', async () => {
        const f = sessionController();
        usePlaybackStore.setState({ audioSrc: 'http://127.0.0.1/session/new/audio.wav' });
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, autoplay: false })).rejects.toMatchObject({ name: 'AbortError' });
        expect(usePlaybackStore.getState().audioSrc).toBe('http://127.0.0.1/session/new/audio.wav');
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
    });

    it('does not clear a new song when an old controller reports failure', async () => {
        const f = sessionController();
        usePlaybackStore.setState({ currentSong: song, audioSrc: streamUrl('new') });
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, autoplay: false })).rejects.toMatchObject({ name: 'AbortError' });
        expect(usePlaybackStore.getState()).toMatchObject({ currentSong: song, audioSrc: streamUrl('new') });
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
    });

    it('does not discard a healthy paused session or prepare it in the background', async () => {
        const f = sessionController();
        Object.assign(f.audioRef.current!, { error: null });
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, autoplay: false })).resolves.toBe(false);
        expect(usePlaybackStore.getState().audioSrc).toBe(sessionSrc);
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
    });

    it('prepares the empty session only for explicit Play and retains the checkpoint over empty-deck zero', async () => {
        usePlaybackStore.setState({ audioSrc: null });
        const f = sessionController(null);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: 'http://127.0.0.1/session/fresh/audio.wav' });
        expect(f.controller.shouldRefreshCurrentOnlineAudioSource()).toBe(true);
        await expect(f.controller.recoverOnlinePlaybackSource({ resumeAt: 0, autoplay: true })).resolves.toBe(true);
        expect(loadAudioSourceMock).toHaveBeenCalledOnce();
        expect(f.pendingResumeTimeRef.current).toBe(42.75);
        expect(f.shouldAutoPlayRef.current).toBe(true);
        expect(usePlaybackStore.getState().audioSrc).toBe('http://127.0.0.1/session/fresh/audio.wav');
    });

    it.each(['cancel', 'change-song'] as const)('does not publish a late preparation after %s', async action => {
        usePlaybackStore.setState({ audioSrc: null });
        const f = sessionController(null);
        let resolve!: (value: unknown) => void;
        loadAudioSourceMock.mockImplementation(() => new Promise(done => { resolve = done; }));
        const pending = f.controller.recoverOnlinePlaybackSource({ autoplay: true });
        if (action === 'cancel') cancelPlaybackSourceRequest();
        else usePlaybackStore.setState({ currentSong: song, audioSrc: streamUrl('new') });
        resolve({ kind: 'ok', audioSrc: 'http://127.0.0.1/session/late/audio.wav' });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.shouldAutoPlayRef.current).toBe(false);
        expect(usePlaybackStore.getState().audioSrc).toBe(action === 'cancel' ? null : streamUrl('new'));
    });
});
