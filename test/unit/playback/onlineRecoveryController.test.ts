import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadAudioSourceMock = vi.hoisted(() => vi.fn());
const setAudioSrcMock = vi.hoisted(() => vi.fn((value: string | null) => { playbackState.audioSrc = value; }));
const setPlayQueueMock = vi.hoisted(() => vi.fn());
const playbackState = vi.hoisted(() => ({ playQueue: [] as unknown[], currentSong: null as SongResult | null, audioSrc: null as string | null, playerState: null as PlayerState | null }));

vi.mock('@/services/onlinePlayback', () => ({
    loadOnlineSongAudioSource: loadAudioSourceMock,
    applyOnlineAudioSourceMetadata: (song: unknown, replayGain?: unknown) => (replayGain ? { ...(song as object), replayGain } : song),
}));
vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: { getState: () => playbackState, subscribe: () => () => {},
        setState: (next: Partial<typeof playbackState>) => Object.assign(playbackState, next) },
    setAudioSrc: setAudioSrcMock,
    setCurrentSong: vi.fn(next => { playbackState.currentSong = typeof next === 'function' ? next(playbackState.currentSong) : next; }),
    setPlayerState: vi.fn(next => { playbackState.playerState = next; }),
    setPlayQueue: setPlayQueueMock,
}));

import {
    createOnlineRecoveryController,
    getOnlineRecoveryKey,
} from '@/components/app/playback/createOnlineRecoveryController';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import type { SongResult } from '@/types';
import type { OnlineRecoveryResult } from '@/types/playbackFailure';

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

const otherSong: SongResult = {
    id: 'qq-other',
    name: 'Other',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    qqMid: '000OtherSongMid',
    sourceRef: { kind: 'online', providerId: 'qq', mediaId: '000OtherSongMid' },
};

const ref = <T,>(value: T) => ({ current: value });

// QQ mints a fresh vkey/guid per request, so consecutive refreshes of one file differ only in query.
const streamUrl = (vkey: string) =>
    `http://isure.stream.qqmusic.qq.com/M800004Th6td4LaoZs004Th6td4LaoZs.mp3?guid=${vkey}&vkey=${vkey}&uin=1&fromtag=8`;

const createController = (audioSrc: string, {
    currentSong = song,
    currentSongRef = ref<string | number | null>(getPlaybackSongKey(currentSong)),
    playbackGenerationRef = ref(0),
    recoveryRef = ref(new Map<string, Promise<OnlineRecoveryResult>>()),
    blobUrlRef = ref<string | null>(null),
}: {
    currentSong?: SongResult;
    currentSongRef?: { current: string | number | null };
    playbackGenerationRef?: { current: number };
    recoveryRef?: { current: Map<string, Promise<OnlineRecoveryResult>> };
    blobUrlRef?: { current: string | null };
} = {}) => {
    playbackState.currentSong = currentSong;
    playbackState.audioSrc = audioSrc;
    const lastAudioRecoverySourceRef = ref<string | null>(null);
    const audioRef = ref<HTMLAudioElement | null>({ currentTime: 0, currentSrc: audioSrc } as HTMLAudioElement);
    const shouldAutoPlayRef = ref(false);
    const pendingResumeTimeRef = ref<number | null>(null);
    const persistLastPlaybackCache = vi.fn(async () => undefined);

    const controller = createOnlineRecoveryController({
        audioQuality: 'high',
        currentSong,
        audioSrc,
        audioRef,
        currentSongRef,
        playbackGenerationRef,
        blobUrlRef,
        shouldAutoPlayRef,
        pendingResumeTimeRef,
        onlinePlaybackRecoveryRef: recoveryRef,
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef: ref<number | null>(null),
        persistLastPlaybackCache,
        playQueue: [currentSong],
        onlineAudioUrlTtlMs: 60_000,
        onlineAudioUrlRefreshBufferMs: 5_000,
    });

    return {
        controller, lastAudioRecoverySourceRef, shouldAutoPlayRef, currentSongRef, playbackGenerationRef, recoveryRef,
        blobUrlRef, pendingResumeTimeRef, persistLastPlaybackCache,
    };
};

type LoaderResult = { kind: 'ok'; audioSrc: string; blobUrl?: string; replayGain?: unknown } | { kind: 'failed'; failure: unknown };
const pendingLoad = () => {
    let finish!: (result: LoaderResult) => void;
    const promise = new Promise<LoaderResult>(resolve => { finish = resolve; });
    return { promise, finish };
};

describe('online playback recovery bounds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadAudioSourceMock.mockReset();
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
            .resolves.toEqual({ status: 'recovered' });
        // The refreshed URL fails too. Before this guard the differing vkey made it look brand new,
        // so the error -> refresh -> error cycle never reached skipAfterPlaybackFailure().
        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('two'), autoplay: true }))
            .resolves.toEqual({ status: 'not-attempted' });
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(1);
    });

    it('lets a forced (manual) retry bypass the per-file guard', async () => {
        const firstUrl = streamUrl('one');
        const { controller } = createController(firstUrl);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two') });

        await controller.recoverOnlinePlaybackSource({ failedSrc: firstUrl, autoplay: true });
        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('two'), autoplay: true, force: true }))
            .resolves.toEqual({ status: 'recovered' });
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(2);
    });

    it('allows a refresh again once the source actually played', async () => {
        const firstUrl = streamUrl('one');
        const { controller, lastAudioRecoverySourceRef } = createController(firstUrl);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two') });

        await controller.recoverOnlinePlaybackSource({ failedSrc: firstUrl, autoplay: true });
        // Stands in for the audio element's `playing` event clearing the guard.
        lastAudioRecoverySourceRef.current = null;

        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('two'), autoplay: true }))
            .resolves.toEqual({ status: 'recovered' });
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(2);
    });

    it('commits a refreshed source without autoplay after pause during its fetch', async () => {
        const { controller, shouldAutoPlayRef } = createController(streamUrl('one'));
        const load = pendingLoad();
        loadAudioSourceMock.mockImplementation(() => load.promise);
        let wantsPlayback = true;
        const recovery = controller.recoverOnlinePlaybackSource({
            autoplay: true, shouldAutoplay: () => wantsPlayback,
        });
        wantsPlayback = false;
        load.finish({ kind: 'ok', audioSrc: streamUrl('two') });
        await expect(recovery).resolves.toEqual({ status: 'recovered' });
        expect(setAudioSrcMock).toHaveBeenCalledWith(streamUrl('two'));
        expect(shouldAutoPlayRef.current).toBe(false);
    });

    it('honors a later resume before the pending refresh commits', async () => {
        const { controller, shouldAutoPlayRef } = createController(streamUrl('one'));
        const load = pendingLoad();
        loadAudioSourceMock.mockImplementation(() => load.promise);
        let wantsPlayback = true;
        const recovery = controller.recoverOnlinePlaybackSource({
            autoplay: true, shouldAutoplay: () => wantsPlayback,
        });
        wantsPlayback = false;
        wantsPlayback = true;
        load.finish({ kind: 'ok', audioSrc: streamUrl('two') });
        await expect(recovery).resolves.toEqual({ status: 'recovered' });
        expect(setAudioSrcMock).toHaveBeenCalledWith(streamUrl('two'));
        expect(shouldAutoPlayRef.current).toBe(true);
    });
});

describe('online playback recovery results', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadAudioSourceMock.mockReset();
    });

    it('asks the loader for a refresh and passes bypassMediaCache through', async () => {
        const { controller } = createController('blob:folia/cached');
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two') });

        await controller.recoverOnlinePlaybackSource({ failedSrc: 'blob:folia/cached', autoplay: true, bypassMediaCache: true });
        expect(loadAudioSourceMock).toHaveBeenCalledWith(song, 'high', null, expect.objectContaining({ stage: 'refresh', bypassMediaCache: true, signal: expect.any(AbortSignal) }));
    });

    it('reports a loader failure with its reason and the refresh stage, touching neither queue nor cache', async () => {
        const { controller, persistLastPlaybackCache } = createController(streamUrl('one'));
        loadAudioSourceMock.mockResolvedValue({
            kind: 'failed',
            failure: { reason: 'session-expired', stage: 'resolve-url', providerId: 'qq' },
        });

        const result = await controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('one'), autoplay: true });
        expect(result).toEqual({
            status: 'failed',
            failure: { reason: 'session-expired', stage: 'refresh', providerId: 'qq' },
        });
        expect(setAudioSrcMock).not.toHaveBeenCalled();
        expect(setPlayQueueMock).not.toHaveBeenCalled();
        expect(persistLastPlaybackCache).not.toHaveBeenCalled();
    });

    it('classifies a thrown loader error instead of reporting a bare failure', async () => {
        const { controller } = createController(streamUrl('one'));
        loadAudioSourceMock.mockRejectedValue(new TypeError('Failed to fetch'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const result = await controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('one'), autoplay: true });
        expect(result).toMatchObject({ status: 'failed', failure: { reason: 'network', stage: 'refresh', providerId: 'qq' } });
        expect(setPlayQueueMock).not.toHaveBeenCalled();
    });

    it('reports stale when the song changes while the refresh is in flight', async () => {
        const { controller, currentSongRef } = createController(streamUrl('one'));
        const load = pendingLoad();
        loadAudioSourceMock.mockImplementation(() => load.promise);

        const recovery = controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('one'), autoplay: true });
        currentSongRef.current = getPlaybackSongKey(otherSong);
        load.finish({ kind: 'ok', audioSrc: streamUrl('two') });

        await expect(recovery).resolves.toEqual({ status: 'stale' });
        expect(setAudioSrcMock).not.toHaveBeenCalled();
    });

    // 同一首歌重新点播落地：key 不变、代次变了。旧刷新的结果不能暂停新播放，也不能把它的音源和进度换回出错时的样子。
    it.each([
        ['fails', { kind: 'failed', failure: { reason: 'network', stage: 'resolve-url', providerId: 'qq' } }],
        ['succeeds', { kind: 'ok', audioSrc: 'blob:folia/old-refresh', blobUrl: 'blob:folia/old-refresh' }],
    ] as const)('reports stale when the same song is played again while its refresh %s', async (_outcome, loaded) => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        const { controller, playbackGenerationRef, blobUrlRef, pendingResumeTimeRef } = createController(streamUrl('one'), {
            blobUrlRef: ref<string | null>('blob:folia/replay'),
        });
        const load = pendingLoad();
        loadAudioSourceMock.mockImplementation(() => load.promise);

        const recovery = controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('one'), resumeAt: 95, autoplay: true });
        playbackGenerationRef.current += 1; // playSong landed the same song again
        load.finish(loaded);

        await expect(recovery).resolves.toEqual({ status: 'stale' });
        expect(setAudioSrcMock).not.toHaveBeenCalled();
        expect(pendingResumeTimeRef.current).toBeNull();
        expect(blobUrlRef.current).toBe('blob:folia/replay');
        expect(revoke).not.toHaveBeenCalledWith('blob:folia/replay');
        if (loaded.kind === 'ok') expect(revoke).toHaveBeenCalledWith('blob:folia/old-refresh');
        revoke.mockRestore();
    });

    it('starts a replay its own refresh instead of joining the one left from the earlier playback', async () => {
        const { controller, playbackGenerationRef, recoveryRef } = createController(streamUrl('one'));
        const oldLoad = pendingLoad();
        const newLoad = pendingLoad();
        loadAudioSourceMock.mockImplementationOnce(() => oldLoad.promise).mockImplementationOnce(() => newLoad.promise);

        const oldRecovery = controller.recoverOnlinePlaybackSource({ autoplay: true, force: true });
        playbackGenerationRef.current += 1;
        const newRecovery = controller.recoverOnlinePlaybackSource({ autoplay: true, force: true });
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(2);

        // The old task settles first; its cleanup must leave the replay's in-flight entry alone.
        oldLoad.finish({ kind: 'failed', failure: { reason: 'network', stage: 'resolve-url' } });
        await expect(oldRecovery).resolves.toEqual({ status: 'stale' });
        expect(recoveryRef.current.size).toBe(1);
        const joined = controller.recoverOnlinePlaybackSource({ autoplay: true, force: true });
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(2);

        newLoad.finish({ kind: 'ok', audioSrc: streamUrl('two') });
        await expect(newRecovery).resolves.toEqual({ status: 'recovered' });
        await expect(joined).resolves.toEqual({ status: 'recovered' });
        expect(setAudioSrcMock).toHaveBeenCalledWith(streamUrl('two'));
        expect(recoveryRef.current.size).toBe(0);
    });

    it('gives a second song its own recovery while the first one is still in flight', async () => {
        const recoveryRef = ref(new Map<string, Promise<OnlineRecoveryResult>>());
        const currentSongRef = ref<string | number | null>(getPlaybackSongKey(song));
        const first = createController(streamUrl('one'), { recoveryRef, currentSongRef });
        const firstLoad = pendingLoad();
        loadAudioSourceMock.mockImplementationOnce(() => firstLoad.promise);
        const firstRecovery = first.controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('one'), autoplay: true });

        // The listener moves on; App rebuilds the controller for the new song over the same refs.
        currentSongRef.current = getPlaybackSongKey(otherSong);
        const second = createController('https://cdn.example/other.mp3', { currentSong: otherSong, recoveryRef, currentSongRef });
        loadAudioSourceMock.mockResolvedValueOnce({ kind: 'ok', audioSrc: 'https://cdn.example/other-fresh.mp3' });
        const secondRecovery = second.controller.recoverOnlinePlaybackSource({ failedSrc: 'https://cdn.example/other.mp3', autoplay: true });

        await expect(secondRecovery).resolves.toEqual({ status: 'recovered' });
        firstLoad.finish({ kind: 'ok', audioSrc: streamUrl('two') });
        await expect(firstRecovery).resolves.toEqual({ status: 'stale' });

        expect(loadAudioSourceMock).toHaveBeenCalledTimes(2);
        expect(setAudioSrcMock).toHaveBeenCalledTimes(1);
        expect(setAudioSrcMock).toHaveBeenCalledWith('https://cdn.example/other-fresh.mp3');
        expect(recoveryRef.current.size).toBe(0);
    });

    it('shares one in-flight recovery between callers for the same song', async () => {
        const { controller } = createController(streamUrl('one'));
        const load = pendingLoad();
        loadAudioSourceMock.mockImplementation(() => load.promise);

        const first = controller.recoverOnlinePlaybackSource({ autoplay: true, force: true });
        const second = controller.recoverOnlinePlaybackSource({ autoplay: true, force: true });
        load.finish({ kind: 'ok', audioSrc: streamUrl('two') });

        await expect(first).resolves.toEqual({ status: 'recovered' });
        await expect(second).resolves.toEqual({ status: 'recovered' });
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(1);
    });

    it('commits a refreshed ReplayGain into the queue as it is now, not as it was at creation', async () => {
        const { controller, persistLastPlaybackCache } = createController(streamUrl('one'));
        // The queue was edited after the controller was built (it captured [song]).
        const editedQueue = [otherSong, song];
        playbackState.playQueue = editedQueue;
        const replayGain = { trackGain: -6 };
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two'), replayGain });

        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('one'), autoplay: true, force: true }))
            .resolves.toEqual({ status: 'recovered' });
        const expectedQueue = [otherSong, { ...song, replayGain }];
        expect(setPlayQueueMock).toHaveBeenCalledWith(expectedQueue);
        expect(persistLastPlaybackCache).toHaveBeenCalledWith({ ...song, replayGain }, expectedQueue);
    });

    it('does not attempt a recovery for a non-online song', async () => {
        const localSong = { ...song, id: 'local-1', sourceRef: undefined, isLocal: true, localRef: { songId: 'local-1' } } as unknown as SongResult;
        const { controller } = createController('blob:folia/local', { currentSong: localSong });

        await expect(controller.recoverOnlinePlaybackSource({ autoplay: true })).resolves.toEqual({ status: 'not-attempted' });
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
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
    playbackState.currentSong = spotifySong;
    playbackState.audioSrc = audioSrc;
    const refs = {
        audioRef: ref<HTMLAudioElement | null>({ currentTime: 0, currentSrc: audioSrc || '', error: { code: 2 } } as HTMLAudioElement),
        currentSongRef: ref<string | number | null>(getPlaybackSongKey(spotifySong)),
        shouldAutoPlayRef: ref(false), pendingResumeTimeRef: ref<number | null>(42.75),
        onlinePlaybackRecoveryRef: ref<Map<string, Promise<OnlineRecoveryResult>>>(new Map()), playbackGenerationRef: ref(0),
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
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, resumeAt: 0, autoplay: false })).resolves.toEqual({ status: 'recovered' });
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
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, autoplay: false })).resolves.toEqual({ status: 'stale' });
        expect(usePlaybackStore.getState().audioSrc).toBe('http://127.0.0.1/session/new/audio.wav');
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
    });

    it('does not clear a new song when an old controller reports failure', async () => {
        const f = sessionController();
        usePlaybackStore.setState({ currentSong: song, audioSrc: streamUrl('new') });
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, autoplay: false })).resolves.toEqual({ status: 'stale' });
        expect(usePlaybackStore.getState()).toMatchObject({ currentSong: song, audioSrc: streamUrl('new') });
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
    });

    it('does not discard a healthy paused session or prepare it in the background', async () => {
        const f = sessionController();
        Object.assign(f.audioRef.current!, { error: null });
        await expect(f.controller.recoverOnlinePlaybackSource({ failedSrc: sessionSrc, autoplay: false })).resolves.toEqual({ status: 'not-attempted' });
        expect(usePlaybackStore.getState().audioSrc).toBe(sessionSrc);
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
    });

    it('prepares the empty session only for explicit Play and retains the checkpoint over empty-deck zero', async () => {
        usePlaybackStore.setState({ audioSrc: null });
        const f = sessionController(null);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: 'http://127.0.0.1/session/fresh/audio.wav' });
        expect(f.controller.shouldRefreshCurrentOnlineAudioSource()).toBe(true);
        await expect(f.controller.recoverOnlinePlaybackSource({ resumeAt: 0, autoplay: true })).resolves.toEqual({ status: 'recovered' });
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
        else { usePlaybackStore.setState({ currentSong: song, audioSrc: streamUrl('new') }); f.currentSongRef.current = getPlaybackSongKey(song); }
        resolve({ kind: 'ok', audioSrc: 'http://127.0.0.1/session/late/audio.wav' });
        await expect(pending).resolves.toEqual({ status: 'stale' });
        expect(f.shouldAutoPlayRef.current).toBe(false);
        expect(usePlaybackStore.getState().audioSrc).toBe(action === 'cancel' ? null : streamUrl('new'));
    });
});
