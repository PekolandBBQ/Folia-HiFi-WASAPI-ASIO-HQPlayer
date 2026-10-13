// @vitest-environment jsdom
import { cableStatus } from '../onlineMusic/spotifyCableFixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Exercise the real IPC adapter, provider, Omni, audio loader and queue hook together.
vi.hoisted(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true,
        value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
});
const bridge = vi.hoisted(() => vi.fn());
const cachedSession = vi.hoisted(() => vi.fn());
const cachedCover = vi.hoisted(() => vi.fn(async () => null));
const externalFetch = vi.hoisted(() => {
    const request = vi.fn(async () => { throw new Error('External network is disabled in Spotify playback tests'); });
    vi.stubGlobal('fetch', request); return request;
});
// Lyrics matching is unrelated to source/queue parity and can search other real providers by default.
vi.mock('@/utils/lyrics/autoMatchBestLyric', () => ({ autoMatchBestLyric: vi.fn(async () => null) }));
vi.mock('@/services/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/db')>(), getFromCache: cachedSession,
}));
vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongAudioBlob: async () => null, hasCachedSongAudio: async () => false,
    getCachedSongCoverUrl: cachedCover, getSongCacheWithLegacyMigration: async () => null,
}));
vi.mock('@/services/prefetchService', () => ({
    getPrefetchedData: () => null, prefetchNearbySongs: () => {}, invalidateAndRefetch: () => {},
    isUrlValid: () => false, updatePrefetchedAudioUrl: () => {},
}));
vi.mock('@/services/playbackFade', () => ({ playbackFade: {
    flush: () => {}, isFadingOut: () => false, prepareFadeIn: () => null, abortFadeIn: () => {},
} }));
vi.mock('@/utils/onlineLyricsState', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/onlineLyricsState')>(), loadOnlineLyricsState: async () => null,
}));

import { usePlaybackQueueController } from '@/hooks/usePlaybackQueueController';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';
import { useSettingsModalStore } from '@/stores/useSettingsModalStore';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { registerOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';
import { normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';
import { getSongUnavailableLabel, isSongUnavailable } from '@/services/onlineMusic/songAvailability';
import { TrackListItem } from '@/components/shared/SidePanelList';
import { loadOnlineSongAudioSource } from '@/services/onlinePlayback';
import { omni } from '@/services/onlineMusic/omni';
import { createOnlineRecoveryController } from '@/components/app/playback/createOnlineRecoveryController';
import { createSpotifyPlaybackSetupController } from '@/services/onlineMusic/spotifyPlaybackSetup';
import { usePlaybackTransportController } from '@/hooks/usePlaybackTransportController';
import { useSessionRestoreController } from '@/hooks/useSessionRestoreController';
import { useElectronWindowPlaybackHandoff } from '@/hooks/useElectronWindowPlaybackHandoff';
import { restorePlaybackSourceForSong } from '@/components/app/playback/restorePlaybackSource';
import { beginPlaybackSourceRequest, cancelPlaybackSourceRequest } from '@/services/playbackSourceRequest';
import { OnlineProviderError, type ProviderPlaybackSetupRequest } from '@/types/onlineMusic';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import { PlayerState } from '@/types';
import { NativeAudioTransport } from '@/services/nativeAudio/NativeAudioTransport';
import type { NativeAudioApi, NativeAudioState } from '@/types/nativeAudio';
import i18n from '@/i18n/config';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const song = normalizeSpotifySong({ id: '0123456789012345678901', name: 'Synthetic song', type: 'track' });
const nextSong = normalizeSpotifySong({ id: '1123456789012345678901', name: 'Next synthetic song', type: 'track' });
const ref = <T,>(current: T) => ({ current });
let root: Root | undefined;
let queue: ReturnType<typeof usePlaybackQueueController>;
function mount(render: (controller: ReturnType<typeof usePlaybackQueueController>) => React.ReactNode = () => null) {
    const props = {
        isNowPlayingStageActive: false, shouldNavigateToPlayerOnTrackChange: false,
        localSongs: [], localLibraryCatalog: {}, setLyrics: vi.fn(), setIsLyricsLoading: vi.fn(),
        navigateToPlaybackView: vi.fn(), navigateToSearch: vi.fn(), persistLastPlaybackCache: vi.fn(),
        restoreCachedThemeForSong: vi.fn(), interruptStagePlaybackForMainTransition: vi.fn(),
        onPlayLocalSong: vi.fn(), onPlayNavidromeSong: vi.fn(), onAddLocalSongToQueue: vi.fn(),
        onAddNavidromeSongsToQueue: vi.fn(), searchDeps: { submitSearch: vi.fn(), loadMoreSearchResults: vi.fn() },
        audioRef: ref(null), blobUrlRef: ref(null), shouldAutoPlayRef: ref(false), currentSongRef: ref(null),
        mainPlaybackSnapshotRef: ref(null), playbackAutoSkipCountRef: ref(0), pendingResumeTimeRef: ref(null),
        currentOnlineAudioUrlFetchedAtRef: ref(null), lastAudioRecoverySourceRef: ref(null),
    } as unknown as Parameters<typeof usePlaybackQueueController>[0];
    function Probe() { queue = usePlaybackQueueController(props); return render(queue); }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(React.createElement(Probe)));
    return { ...props, container };
}
beforeEach(async () => {
    vi.clearAllMocks();
    cachedCover.mockResolvedValue(null);
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    window.electron = { spotify: { request: bridge, onProgress: () => () => {} } } as unknown as typeof window.electron;
    registerOnlineMusicProvider(spotifyProvider);
    await i18n.changeLanguage('zh-CN');
    usePlaybackStore.setState({ currentSong: null, audioSrc: null, playQueue: [song, nextSong],
        activePlaybackContext: 'main', playerState: PlayerState.IDLE, isFmMode: false });
    useStatusMessageStore.setState({ message: null });
    useAudioSettingsStore.setState({ audioQuality: 'high', nativeAudioBackend: 'browser', autoPlayOnLaunch: false });
    useSettingsModalStore.getState().closeSettings();
});
afterEach(() => {
    cancelPlaybackSourceRequest();
    act(() => root?.unmount()); root = undefined;
    vi.useRealTimers();
    expect(externalFetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
});

describe('Spotify playback failure presentation', () => {
    it.each([
        ['setup-required', 'playback-setup-required', '设置'],
        ['auth-required', 'playback-scope-required', '授权'],
        ['unsupported', 'playback-http-403', '403'],
        ['network', 'playback-http-503', '网络'],
        ['unavailable', 'rate-limited', '暂时'],
        ['invalid-response', 'track-metadata-mismatch', '有效'],
    ])('preserves %s through IPC → Omni → loader and does not skip the track', async (code, reason, expectedText) => {
        bridge.mockResolvedValue({ spotifyError: { code, message: `Spotify: ${reason}` } });
        await expect(loadOnlineSongAudioSource(song, 'high', null)).rejects.toMatchObject({ code, providerId: 'spotify' });
        bridge.mockClear();
        usePlaybackStore.setState({ currentSong: nextSong, audioSrc: 'https://example.invalid/previous.mp3', playerState: PlayerState.PLAYING });
        const props = mount();
        const pause = vi.fn(), removeAttribute = vi.fn(), load = vi.fn();
        props.audioRef.current = { pause, removeAttribute, load } as unknown as HTMLAudioElement;
        props.shouldAutoPlayRef.current = true;
        vi.useFakeTimers();
        await act(async () => queue.playSong(song, [song, nextSong]));
        const message = useStatusMessageStore.getState().message!;
        expect(message.text).toContain(expectedText);
        expect(message.text).not.toMatch(/下架|自动跳过/);
        await act(async () => vi.advanceTimersByTimeAsync(6000));
        expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(1);
        expect(bridge.mock.calls.some(([input]) => input.action.startsWith('login'))).toBe(false);
        expect(pause).toHaveBeenCalledOnce();
        expect(removeAttribute).toHaveBeenCalledWith('src');
        expect(load).toHaveBeenCalledOnce();
        expect(props.shouldAutoPlayRef.current).toBe(false);
        expect(usePlaybackStore.getState()).toMatchObject({ currentSong: nextSong, audioSrc: null, playerState: PlayerState.IDLE });
        expect(usePlaybackStore.getState().playQueue).toEqual([song, nextSong]);
        if (code === 'setup-required') {
            expect(message.text).toContain('Spotify播放连接');
            expect(message.onAction).toBeTypeOf('function');
            act(() => message.onAction!());
            expect(useSettingsModalStore.getState().settingsModalState).toMatchObject({
                isOpen: true, initialTab: 'options', initialSubview: 'integration', initialAnchor: { id: 'spotifyConnection' },
            });
        }
    });
    it('keeps healthy source selection playable without retiring the current deck', async () => {
        bridge.mockResolvedValue({ url: 'http://127.0.0.1:12345/healthy', playbackTransport: 'cable-pcm' });
        const props = mount(), pause = vi.fn(), removeAttribute = vi.fn(), load = vi.fn();
        props.audioRef.current = { pause, removeAttribute, load } as unknown as HTMLAudioElement;
        await act(async () => queue.playSong(song, [song, nextSong]));
        expect(usePlaybackStore.getState()).toMatchObject({ currentSong: { id: song.id }, audioSrc: 'http://127.0.0.1:12345/healthy' });
        expect(props.shouldAutoPlayRef.current).toBe(true);
        expect(pause).not.toHaveBeenCalled(); expect(removeAttribute).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
        expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(1);
    });
    it.each(['pause', 'new-song'] as const)('ignores an old typed source error after a newer %s intent', async intent => {
        let rejectOld!: (error: unknown) => void;
        bridge.mockImplementation(input => input.action !== 'audio' ? Promise.resolve(null)
            : input.id === song.id ? new Promise((_resolve, reject) => { rejectOld = reject; })
                : Promise.resolve({ url: 'http://127.0.0.1:12345/new-song', playbackTransport: 'cable-pcm' }));
        const props = mount(), pause = vi.fn(), removeAttribute = vi.fn(), load = vi.fn();
        props.audioRef.current = { pause, removeAttribute, load } as unknown as HTMLAudioElement;
        const old = queue.playSong(song, [song, nextSong]);
        await vi.waitFor(() => expect(rejectOld).toBeTypeOf('function'));
        if (intent === 'pause') {
            act(() => { cancelPlaybackSourceRequest(); usePlaybackStore.setState({ playerState: PlayerState.PAUSED }); });
        } else {
            await act(async () => queue.playSong(nextSong, [song, nextSong]));
            act(() => usePlaybackStore.setState({ playerState: PlayerState.PLAYING }));
        }
        const before = usePlaybackStore.getState(), message = useStatusMessageStore.getState().message;
        await act(async () => { rejectOld(new OnlineProviderError('auth-required', 'Spotify: playback-scope-required', 'spotify')); await old; });
        expect(pause).not.toHaveBeenCalled(); expect(removeAttribute).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
        expect(props.shouldAutoPlayRef.current).toBe(intent === 'new-song');
        expect(usePlaybackStore.getState()).toMatchObject({ currentSong: before.currentSong, audioSrc: before.audioSrc, playerState: before.playerState });
        expect(useStatusMessageStore.getState().message).toEqual(message);
    });
    it.each([false, true])('routes the real GridView track row through the queue and player navigation (unavailable=%s)', async unavailable => {
        // GridView uses this production TrackListItem with onPlay -> onSelectTrack(track, playableTracks).
        // The overlay forwards onSelectTrack to the app queue. Keep that actual row and queue/source path mounted.
        const track = unavailable ? normalizeSpotifySong({ id: song.id, name: song.name, type: 'track', is_playable: false }) : song;
        bridge.mockResolvedValue({ url: 'http://127.0.0.1:12345/grid-selected', playbackTransport: 'cable-pcm' });
        let playing: Promise<void> | undefined;
        const props = mount(controller => React.createElement(TrackListItem, {
            track, index: 0, style: {}, isUnavailable: isSongUnavailable(track),
            onPlay: () => { playing = controller.playSong(track, [track, nextSong]); },
        }));
        const title = Array.from(props.container.querySelectorAll('span')).find(element => element.textContent === track.name);
        expect(title).toBeDefined();
        await act(async () => { title!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await playing; });
        expect(props.navigateToPlaybackView).toHaveBeenCalledTimes(unavailable ? 0 : 1);
        expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(unavailable ? 0 : 1);
        if (unavailable) expect(usePlaybackStore.getState().currentSong).toBeNull();
        else {
            expect(usePlaybackStore.getState()).toMatchObject({ currentSong: { id: song.id }, audioSrc: 'http://127.0.0.1:12345/grid-selected' });
            expect(usePlaybackStore.getState().playQueue).toHaveLength(2); expect(props.shouldAutoPlayRef.current).toBe(true);
        }
    });
    it('retires an existing native deck with a full Stop when a current Spotify source fails', async () => {
        // Real NativeAudioTransport and source loader; only the native IPC/device boundary is mocked.
        let state: NativeAudioState = { session: '', position: 9, duration: 120, playing: false, ended: false,
            sampleRate: 44100, channels: 2, latency: 0, backend: 'asio', deviceId: 'fixture' };
        const request = vi.fn(async (input: Parameters<NativeAudioApi['request']>[0]) => {
            if (input.action === 'begin') state = { ...state, session: input.session! };
            if (input.action === 'play') state = { ...state, playing: true };
            if (input.action === 'pause' || input.action === 'stop') state = { ...state, playing: false };
            return { ...state };
        });
        const transport = new NativeAudioTransport({ supported: true, request, onEvent: () => () => {} }, 'asio', 'fixture', 'integer-direct', async () => null);
        try {
            transport.setSource('https://example.invalid/previous.mp3'); await transport.play();
            const oldSession = state.session; request.mockClear();
            usePlaybackStore.setState({ currentSong: nextSong, audioSrc: transport.src, playerState: PlayerState.PLAYING });
            const props = mount(); props.audioRef.current = transport.asMediaElement(); props.shouldAutoPlayRef.current = true;
            bridge.mockResolvedValue({ spotifyError: { code: 'auth-required', message: 'Spotify: playback-scope-required' } });
            await act(async () => queue.playSong(song, [song, nextSong]));
            expect(request).toHaveBeenCalledWith({ action: 'stop', session: oldSession });
            expect(request.mock.calls.filter(([input]) => input.action === 'stop')).toHaveLength(1);
            expect(request.mock.calls.some(([input]) => ['volume', 'gain', 'replaygain'].includes(input.action))).toBe(false);
            expect(transport.currentSrc).toBe(''); expect(transport.paused).toBe(true);
            expect(props.shouldAutoPlayRef.current).toBe(false);
            expect(usePlaybackStore.getState()).toMatchObject({ audioSrc: null, playerState: PlayerState.IDLE });
        } finally { transport.dispose(); }
    });
    it('preserves a cold-volume recovery reason from IPC through the queue without requesting account reauthorization', async () => {
        bridge.mockResolvedValue({ spotifyError: { code: 'setup-required', message: 'Spotify: spotify-cold-volume-recovery-required' } });
        mount();
        await act(async () => queue.playSong(song, [song, nextSong]));
        const message = useStatusMessageStore.getState().message!;
        expect(message).toMatchObject({ type: 'error', persistent: true, statusKey: 'spotify-cold-volume-recovery-required' });
        expect(message.text).toContain('恢复原音量');
        expect(message.text).not.toMatch(/账号授权|完成播放连接配置|未配置/);
        expect(bridge.mock.calls.map(([input]) => input.action)).toEqual(['audio']);
        expect(usePlaybackStore.getState().playQueue).toEqual([song, nextSong]);
        act(() => message.onAction!());
        expect(useSettingsModalStore.getState().settingsModalState).toMatchObject({
            isOpen: true, initialTab: 'options', initialSubview: 'integration', initialAnchor: { id: 'spotifyConnection' },
        });
    });
    it('does not infer removal from a missing Spotify audio URL', async () => {
        bridge.mockResolvedValue({});
        await expect(loadOnlineSongAudioSource(song, 'high', null)).rejects.toMatchObject({ code: 'invalid-response', providerId: 'spotify' });
    });
    it('keeps an explicit not-playable result neutral and allows the existing bounded skip prompt', async () => {
        bridge.mockResolvedValue({ spotifyError: { code: 'not-playable', message: 'Spotify: track-unavailable' } });
        mount();
        await act(async () => queue.playSong(song, [song, nextSong]));
        const message = useStatusMessageStore.getState().message!;
        expect(message.text).toContain('当前无法播放');
        expect(message.text).not.toContain('下架');
        expect(message.onAction).toBeTypeOf('function');
    });
    it.each([{ is_playable: false }, { restrictions: { reason: 'synthetic-restriction' } }])('uses a neutral unavailable badge for provider metadata %o', evidence => {
        const unavailable = normalizeSpotifySong({ id: song.id, name: song.name, type: 'track', ...evidence });
        expect(getSongUnavailableLabel(unavailable, i18n.t('status.songUnavailableTag'))).toBe('当前无法播放');
    });
    it('preserves cancellation without publishing a removal message', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(loadOnlineSongAudioSource(song, 'high', null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(useStatusMessageStore.getState().message).toBeNull();
    });
    it('keeps catalog search usable after playback setup is required', async () => {
        bridge.mockImplementation(async input => input.action === 'search'
            ? { items: [{ id: song.id, name: song.name, type: 'track' }], next: null, total: 1 }
            : { spotifyError: { code: 'setup-required', message: 'Spotify: playback-setup-required' } });
        mount();
        await act(async () => queue.playSong(song));
        const page = await omni.searchProviderSongs('spotify', 'Synthetic', { limit: 10, offset: 0 });
        expect(page.items.map(item => item.id)).toEqual([song.id]);
        expect(bridge.mock.calls.map(([input]) => input.action)).toEqual(['audio', 'search']);
    });
    it('lets a later retry obtain a fresh source after an initial setup failure', async () => {
        bridge.mockResolvedValueOnce({ spotifyError: { code: 'setup-required', message: 'Spotify: playback-setup-required' } })
            .mockResolvedValueOnce({ url: 'http://127.0.0.1:12345/synthetic-pcm', playbackTransport: 'soloist-pcm' });
        await expect(loadOnlineSongAudioSource(song, 'high', null)).rejects.toMatchObject({ code: 'setup-required' });
        await expect(loadOnlineSongAudioSource(song, 'high', null)).resolves.toMatchObject({ kind: 'ok' });
        expect(bridge).toHaveBeenCalledTimes(2);
    });
    it('keeps saving cable choices separate from starting playback', async () => {
        const request = vi.fn(async (_input: ProviderPlaybackSetupRequest) => cableStatus());
        const controller = createSpotifyPlaybackSetupController({ supported: () => true, request });
        await controller.run({ operation: 'saveSelection', selection: cableStatus().selection });
        expect(request.mock.calls).toHaveLength(1);
        expect(request.mock.calls[0][0]).toMatchObject({ operation: 'saveSelection' });
        expect(controller.canRun('start')).toBe(true);
        expect(controller.store.getState().message).toBe('selectionSaved');
    });
});

describe('Spotify source recovery keeps actionable failures retryable', () => {
    function mountTransport(recover: () => Promise<boolean>, refresh: boolean) {
        let transport: ReturnType<typeof usePlaybackTransportController>;
        const audio = { paused: true, ended: false, currentTime: 12, currentSrc: 'http://127.0.0.1:12345/old',
            play: vi.fn().mockRejectedValue(new Error('Synthetic expired stream')) } as unknown as HTMLAudioElement;
        function Probe() {
            transport = usePlaybackTransportController({ stageActiveEntryKind: null, isNowPlayingStageActive: false,
                audioRef: ref(audio), audioContextRef: ref(null), stageLyricsClockRef: ref({ startTimeSec: 0, endTimeSec: 0, baseTimeSec: 0, startedAtMs: null }),
                setupAudioAnalyzer: vi.fn(), syncOutputGain: vi.fn(), getTargetPlaybackVolume: () => 1,
                shouldRefreshCurrentOnlineAudioSource: () => refresh, recoverOnlinePlaybackSource: recover,
                getSyntheticStageLyricsTime: () => 0, syncStageLyricsClock: vi.fn() });
            return null;
        }
        root = createRoot(document.createElement('div'));
        act(() => root!.render(React.createElement(Probe)));
        return () => transport!.resumePlayback();
    }
    function recovery() {
        const current = ref<string | number | null>(getPlaybackSongKey(song));
        const lastSource = ref<string | null>(null);
        const autoPlay = ref(true);
        const audioRef = ref({ currentTime: 12, currentSrc: 'http://127.0.0.1:12345/old' } as HTMLAudioElement);
        usePlaybackStore.setState({ currentSong: song, audioSrc: audioRef.current.currentSrc });
        const controller = createOnlineRecoveryController({ audioQuality: 'high', currentSong: song,
            audioSrc: audioRef.current.currentSrc, audioRef, currentSongRef: current, blobUrlRef: ref(null),
            shouldAutoPlayRef: autoPlay, pendingResumeTimeRef: ref(null), onlinePlaybackRecoveryRef: ref(null),
            lastAudioRecoverySourceRef: lastSource, currentOnlineAudioUrlFetchedAtRef: ref(null),
            persistLastPlaybackCache: vi.fn(), playQueue: [song], onlineAudioUrlTtlMs: 1000, onlineAudioUrlRefreshBufferMs: 100 });
        return { controller, current, lastSource, autoPlay };
    }
    it.each(['setup-required', 'auth-required', 'unsupported', 'network', 'unavailable'])('preserves %s instead of returning a skippable track failure', async code => {
        bridge.mockResolvedValue({ spotifyError: { code, message: 'Spotify: request-failed' } });
        const { controller, lastSource, autoPlay } = recovery();
        await expect(controller.recoverOnlinePlaybackSource({ autoplay: true })).rejects.toMatchObject({ code, providerId: 'spotify' });
        expect(lastSource.current).toBeNull();
        expect(autoPlay.current).toBe(false);
        bridge.mockResolvedValue({ url: 'http://127.0.0.1:12345/fresh', playbackTransport: 'soloist-pcm' });
        await expect(controller.recoverOnlinePlaybackSource({ autoplay: true })).resolves.toBe(true);
    });
    it.each(['setup-required', 'auth-required', 'unsupported', 'network', 'unavailable'])('joins concurrent same-source recovery callers for %s without returning a skip result', async code => {
        let finish!: (value: unknown) => void;
        bridge.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const { controller, lastSource, autoPlay } = recovery();
        const first = controller.recoverOnlinePlaybackSource({ autoplay: true });
        const second = controller.recoverOnlinePlaybackSource({ autoplay: true });
        const settled = Promise.allSettled([first, second]);
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledOnce());
        finish({ spotifyError: { code, message: 'Spotify: request-failed' } });
        const results = await settled;
        expect(results).toEqual([
            { status: 'rejected', reason: expect.objectContaining({ code, providerId: 'spotify' }) },
            { status: 'rejected', reason: expect.objectContaining({ code, providerId: 'spotify' }) },
        ]);
        expect(bridge).toHaveBeenCalledOnce();
        expect(lastSource.current).toBeNull();
        expect(autoPlay.current).toBe(false);
    });
    it('keeps the completed same-source retry bound after concurrent callers join successfully', async () => {
        let finish!: (value: unknown) => void;
        bridge.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const { controller } = recovery();
        const first = controller.recoverOnlinePlaybackSource({ autoplay: true });
        const second = controller.recoverOnlinePlaybackSource({ autoplay: true });
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledOnce());
        finish({ url: 'http://127.0.0.1:12345/old', playbackTransport: 'soloist-pcm' });
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        await expect(controller.recoverOnlinePlaybackSource({ autoplay: true })).resolves.toBe(false);
        expect(bridge).toHaveBeenCalledOnce();
    });
    it('marks a superseded recovery as cancellation so callers do not skip or publish an old failure', async () => {
        let finish!: (value: unknown) => void;
        bridge.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const { controller, current } = recovery();
        const pending = controller.recoverOnlinePlaybackSource({ autoplay: true });
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledOnce());
        current.current = getPlaybackSongKey(nextSong);
        finish({ spotifyError: { code: 'setup-required', message: 'Spotify: playback-setup-required' } });
        await rejection;
        expect(useStatusMessageStore.getState().message).toBeNull();
    });
    it.each([true, false])('handles rejected recovery in the mounted transport (refresh=%s)', async refresh => {
        const resume = mountTransport(async () => { throw new OnlineProviderError('setup-required', 'Spotify: playback-setup-required', 'spotify'); }, refresh);
        await act(async () => { await expect(resume()).resolves.toBeUndefined(); });
        expect(useStatusMessageStore.getState().message?.text).toContain('账号授权与播放连接分别设置');
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.PAUSED);
    });
    it.each([true, false])('keeps cancelled transport recovery silent (refresh=%s)', async refresh => {
        const resume = mountTransport(async () => { throw new DOMException('Superseded', 'AbortError'); }, refresh);
        await act(async () => { await expect(resume()).resolves.toBeUndefined(); });
        expect(useStatusMessageStore.getState().message).toBeNull();
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.IDLE);
    });
    it('restores a session with actionable setup guidance instead of an uncaught failure', async () => {
        bridge.mockResolvedValue({ spotifyError: { code: 'setup-required', message: 'Spotify: playback-setup-required' } });
        await expect(restorePlaybackSourceForSong(song, { audioQuality: 'high', blobUrlRef: ref(null),
            currentOnlineAudioUrlFetchedAtRef: ref(null), setLyrics: vi.fn(), allowSessionBoundPlayback: true })).resolves.toBe(false);
        expect(useStatusMessageStore.getState().message?.text).toContain('Spotify播放连接');
    });
    it('does not change another provider’s existing error result', async () => {
        vi.spyOn(omni, 'getAudioSource').mockRejectedValue(new OnlineProviderError('network', 'Synthetic network error', 'qq'));
        const other = { ...song, sourceRef: { kind: 'online' as const, providerId: 'qq' as const, mediaId: 'synthetic' } };
        await expect(loadOnlineSongAudioSource(other, 'high', null)).resolves.toEqual({ kind: 'unavailable' });
    });
});

describe('Spotify restoration requires playback intent', () => {
    const freshSource = 'http://127.0.0.1:12345/fresh-source';
    function sharedProps() {
        return { blobUrlRef: ref(null), currentOnlineAudioUrlFetchedAtRef: ref(null), setLyrics: vi.fn(),
            restoreCachedThemeForSong: vi.fn(async () => 'none' as const), persistLastPlaybackCache: vi.fn(async () => {}),
            shouldAutoPlayRef: ref(false) };
    }
    beforeEach(() => {
        bridge.mockResolvedValue({ url: freshSource, playbackTransport: 'cable-pcm' });
        cachedSession.mockImplementation(async key => key === 'last_song' ? song : key === 'last_queue' ? [song] : null);
    });
    it.each([[false, false], [true, false], [false, true], [true, true]])('mounts startup restore autoplay=%s, StrictMode=%s with the same playback intent', async (autoplay, strict) => {
        useAudioSettingsStore.setState({ autoPlayOnLaunch: autoplay });
        const shared = sharedProps(), props = { ...shared, clearPersistedStagePlaybackCache: vi.fn(),
            loadLocalSongs: vi.fn(), loadLocalPlaylists: vi.fn(), canRestoreSession: true };
        function Probe() { useSessionRestoreController(props); return null; }
        root = createRoot(document.createElement('div'));
        await act(async () => { root!.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe)) : React.createElement(Probe)); });
        await vi.waitFor(() => expect(shared.setLyrics).toHaveBeenCalled());
        expect(usePlaybackStore.getState().currentSong?.id).toBe(song.id);
        expect(usePlaybackStore.getState().playQueue).toEqual([song]);
        expect(usePlaybackStore.getState().audioSrc).toBe(autoplay ? freshSource : null);
        expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(autoplay ? 1 : 0);
        expect(shared.shouldAutoPlayRef.current).toBe(autoplay);
    });
    it.each([[PlayerState.PAUSED, false, false], [PlayerState.PLAYING, false, false], [PlayerState.PAUSED, true, false],
        [PlayerState.PLAYING, true, false], [PlayerState.PLAYING, false, true]] as const)
    ('mounts handoff %s, StrictMode=%s, old recovery=%s with correctly owned playback intent', async (playerState, strict, oldRecovery) => {
        const shared = sharedProps();
        let finishOld!: (value: unknown) => void, cancelledOld: Promise<void> | undefined;
        if (oldRecovery) {
            usePlaybackStore.setState({ currentSong: song });
            bridge.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
            const recovery = createOnlineRecoveryController({ ...shared, audioQuality: 'high', currentSong: song, audioSrc: null,
                audioRef: ref({ currentTime: 0, currentSrc: '' } as HTMLAudioElement), currentSongRef: ref(getPlaybackSongKey(song)),
                pendingResumeTimeRef: ref(null), onlinePlaybackRecoveryRef: ref(null), lastAudioRecoverySourceRef: ref(null),
                playQueue: [song], onlineAudioUrlTtlMs: 1000, onlineAudioUrlRefreshBufferMs: 100 });
            cancelledOld = expect(recovery.recoverOnlinePlaybackSource({ autoplay: true })).rejects.toMatchObject({ name: 'AbortError' });
            await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
        }
        const snapshot = { currentSong: oldRecovery ? nextSong : song, lyrics: null, cachedCoverUrl: null, audioSrc: 'http://127.0.0.1:12345/expired',
            playQueue: [song], isFmMode: false, playerState, currentTime: 12, duration: 120, currentLineIndex: -1 };
        window.electron!.consumeWindowPlaybackHandoff = vi.fn(async () => ({ version: 1, activePlaybackContext: 'main',
            mainPlayback: snapshot, activePlayback: snapshot, ui: { currentView: 'player', playerChromeHidden: false, mainWindowBorderVisible: false },
        })) as any;
        let handoff: ReturnType<typeof useElectronWindowPlaybackHandoff>;
        const props = { ...shared, isElectronWindow: true, navigateToPlayer: vi.fn(), audioRef: ref(null),
            mainPlaybackSnapshotRef: ref(null), stageStatus: null, stageSource: null,
            stageLyricsClockRef: ref({ startTimeSec: 0, endTimeSec: 0, baseTimeSec: 0, startedAtMs: null }),
            nowPlayingTrack: null, nowPlayingLyricPayload: null, nowPlayingPaused: true, nowPlayingProgressMs: 0,
            nowPlayingProgressQuality: 'coarse' as const, getNowPlayingDisplayTime: () => 0, restoreStagePlaybackHandoff: vi.fn(),
            setIsLyricsLoading: vi.fn(), pendingResumeTimeRef: ref(null), lastAudioRecoverySourceRef: ref(null),
            applyTransparentPlayerBackground: vi.fn() };
        function Probe() { handoff = useElectronWindowPlaybackHandoff(props); return null; }
        root = createRoot(document.createElement('div'));
        await act(async () => { root!.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe)) : React.createElement(Probe)); });
        await vi.waitFor(() => expect(handoff!.restoreStatus).toBe('restored'));
        expect(usePlaybackStore.getState().audioSrc).toBe(playerState === PlayerState.PLAYING ? freshSource : null);
        expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength((playerState === PlayerState.PLAYING ? 1 : 0) + (oldRecovery ? 1 : 0));
        expect(shared.shouldAutoPlayRef.current).toBe(playerState === PlayerState.PLAYING);
        if (oldRecovery) {
            expect(bridge.mock.calls.filter(([input]) => input.action === 'cancelAudio')).toHaveLength(1);
            finishOld({ url: 'http://127.0.0.1:12345/old-recovery', playbackTransport: 'cable-pcm' }); await cancelledOld;
            expect(shared.shouldAutoPlayRef.current).toBe(true); expect(usePlaybackStore.getState().audioSrc).toBe(freshSource);
        }
        if (playerState === PlayerState.PAUSED) {
            expect(props.pendingResumeTimeRef.current).toBe(12);
            act(() => root!.unmount());
            const audio = { currentTime: 0, currentSrc: '', paused: true, ended: false, play: vi.fn() } as unknown as HTMLAudioElement;
            const audioRef = ref(audio), recovery = createOnlineRecoveryController({ ...shared, audioQuality: 'high', currentSong: song,
                audioSrc: null, audioRef, currentSongRef: ref(getPlaybackSongKey(song)), pendingResumeTimeRef: props.pendingResumeTimeRef,
                onlinePlaybackRecoveryRef: ref(null), lastAudioRecoverySourceRef: ref(null), playQueue: [song],
                onlineAudioUrlTtlMs: 1000, onlineAudioUrlRefreshBufferMs: 100 });
            let transport: ReturnType<typeof usePlaybackTransportController>;
            const resumeProps = { ...recovery, audioRef, stageActiveEntryKind: null, isNowPlayingStageActive: false,
                audioContextRef: ref(null), stageLyricsClockRef: props.stageLyricsClockRef, setupAudioAnalyzer: vi.fn(),
                syncOutputGain: vi.fn(), getTargetPlaybackVolume: () => 1, getSyntheticStageLyricsTime: () => 0, syncStageLyricsClock: vi.fn() };
            function Resume() { transport = usePlaybackTransportController(resumeProps); return null; }
            root = createRoot(document.createElement('div'));
            act(() => root!.render(React.createElement(Resume)));
            await act(async () => { await transport!.resumePlayback(); });
            expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(1);
            expect(usePlaybackStore.getState().audioSrc).toBe(freshSource);
            expect(props.pendingResumeTimeRef.current).toBe(12); expect(audio.play).not.toHaveBeenCalled();
        }
    });
    it('treats a legacy Spotify snapshot without a session-bound metadata flag as passive until Play', async () => {
        const legacy = { ...song, sourceRef: { ...song.sourceRef!, providerData: undefined } };
        const shared = sharedProps();
        await restorePlaybackSourceForSong(legacy, { ...shared, audioQuality: 'high' });
        expect(bridge.mock.calls.filter(([request]: any[]) => request.action !== 'lyrics')).toHaveLength(0); expect(usePlaybackStore.getState().audioSrc).toBeNull();
    });
    it.each(['paused-failed-source', 'active-uncertain-restore', 'paused-stage'] as const)
    ('never bypasses verified source restoration during %s window handoff', async mode => {
        const shared = sharedProps();
        const selected = { ...song, sourceRef: mode === 'paused-stage'
            ? { kind: 'stage' as const, mediaId: 'stage-local' }
            : { kind: 'online' as const, providerId: 'qq', mediaId: 'qq-local' } };
        const oldSource = 'https://example.invalid/expired-window-source.mp3';
        vi.spyOn(omni, 'getAudioSource').mockResolvedValue(mode === 'active-uncertain-restore'
            ? { url: 'https://example.invalid/fresh-source.mp3', fetchedAt: Date.now() } : null);
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 1, ownsRoute: true }
            : { spotifyError: { code: 'unavailable', message: 'Spotify: automatic-route-restore-unconfirmed' } });
        const snapshot = { currentSong: selected, lyrics: null, cachedCoverUrl: null, audioSrc: oldSource,
            playQueue: [selected], isFmMode: false, playerState: mode === 'active-uncertain-restore' ? PlayerState.PLAYING : PlayerState.PAUSED,
            currentTime: 12, duration: 120, currentLineIndex: -1 };
        window.electron!.consumeWindowPlaybackHandoff = vi.fn(async () => ({ version: 1, activePlaybackContext: 'main',
            mainPlayback: snapshot, activePlayback: snapshot, ui: { currentView: 'player', playerChromeHidden: false, mainWindowBorderVisible: false },
        })) as any;
        let handoff: ReturnType<typeof useElectronWindowPlaybackHandoff>;
        const props = { ...shared, isElectronWindow: true, navigateToPlayer: vi.fn(), audioRef: ref(null),
            mainPlaybackSnapshotRef: ref(null), stageStatus: null, stageSource: null,
            stageLyricsClockRef: ref({ startTimeSec: 0, endTimeSec: 0, baseTimeSec: 0, startedAtMs: null }),
            nowPlayingTrack: null, nowPlayingLyricPayload: null, nowPlayingPaused: true, nowPlayingProgressMs: 0,
            nowPlayingProgressQuality: 'coarse' as const, getNowPlayingDisplayTime: () => 0, restoreStagePlaybackHandoff: vi.fn(),
            setIsLyricsLoading: vi.fn(), pendingResumeTimeRef: ref(null), lastAudioRecoverySourceRef: ref(null),
            applyTransparentPlayerBackground: vi.fn() };
        function Probe() { handoff = useElectronWindowPlaybackHandoff(props); return null; }
        root = createRoot(document.createElement('div'));
        await act(async () => { root!.render(React.createElement(Probe)); });
        await vi.waitFor(() => expect(handoff!.restoreStatus).toBe('restored'));
        expect(usePlaybackStore.getState().audioSrc).toBe(mode === 'paused-stage' ? oldSource : null);
        if (mode === 'paused-stage') {
            const { isPassivePlaybackSource } = await import('@/services/playbackSourceIntent');
            expect(isPassivePlaybackSource(oldSource)).toBe(true);
        }
        expect(bridge.mock.calls.filter(([input]) => input.action === 'leaveProvider')).toHaveLength(mode === 'active-uncertain-restore' ? 1 : 0);
        if (mode === 'active-uncertain-restore') expect(useStatusMessageStore.getState().message?.text).toContain('恢复');
    });
    it('cancels an autoplay restore immediately when a new queue choice begins, before the displayed song changes', async () => {
        const shared = sharedProps(); usePlaybackStore.setState({ currentSong: song, audioSrc: null });
        let finishOld!: (value: unknown) => void, finishNew!: (value: any) => void;
        bridge.mockImplementation(input => input.action === 'audio' ? new Promise(resolve => { finishOld = resolve; })
            : Promise.resolve(input.action === 'sourceRevision' ? { revision: 1, ownsRoute: true } : null));
        const restoring = restorePlaybackSourceForSong(song, { ...shared, audioQuality: 'high', allowSessionBoundPlayback: true });
        await vi.waitFor(() => expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(1));
        const requestId = bridge.mock.calls.find(([input]) => input.action === 'audio')![0].requestId;
        const other = { ...nextSong, sourceRef: { kind: 'online' as const, providerId: 'qq' as const, mediaId: 'next-qq' } };
        vi.spyOn(omni, 'getAudioSource').mockImplementation(() => new Promise(resolve => { finishNew = resolve; }));
        vi.spyOn(omni, 'getLyrics').mockResolvedValue({ lyrics: null, isPureMusic: false } as any);
        mount(); const next = queue.playSong(other, [other]);
        await vi.waitFor(() => expect(finishNew).toBeTypeOf('function'));
        expect(usePlaybackStore.getState().currentSong?.id).toBe(song.id);
        expect(bridge).toHaveBeenCalledWith({ action: 'cancelAudio', requestId });
        await act(async () => { finishNew({ url: 'https://example.invalid/next.mp3', fetchedAt: Date.now() }); await next; });
        finishOld({ url: freshSource, playbackTransport: 'cable-pcm' });
        await expect(restoring).resolves.toBe(false);
        expect(usePlaybackStore.getState().currentSong?.id).toBe(other.id);
        expect(usePlaybackStore.getState().audioSrc).toBe('https://example.invalid/next.mp3');
    });
    it.each(['song-change', 'unmount'])('cancels missing-source recovery on %s and never publishes its late source', async reason => {
        const shared = sharedProps(); usePlaybackStore.setState({ currentSong: song, audioSrc: null });
        let finish!: (value: unknown) => void;
        bridge.mockImplementation(input => input.action === 'audio' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null));
        const recovery = createOnlineRecoveryController({ ...shared, audioQuality: 'high', currentSong: song, audioSrc: null,
            audioRef: ref({ currentTime: 0, currentSrc: '' } as HTMLAudioElement), currentSongRef: ref(getPlaybackSongKey(song)),
            pendingResumeTimeRef: ref(null), onlinePlaybackRecoveryRef: ref(null), lastAudioRecoverySourceRef: ref(null),
            playQueue: [song], onlineAudioUrlTtlMs: 1000, onlineAudioUrlRefreshBufferMs: 100 });
        const pending = recovery.recoverOnlinePlaybackSource({ autoplay: true });
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        const requestId = bridge.mock.calls.find(([input]) => input.action === 'audio')![0].requestId;
        if (reason === 'song-change') usePlaybackStore.setState({ currentSong: nextSong });
        else cancelPlaybackSourceRequest(); // The App's unmount cleanup owns this same cancellation.
        expect(bridge).toHaveBeenCalledWith({ action: 'cancelAudio', requestId });
        finish({ url: freshSource, playbackTransport: 'cable-pcm' }); await cancelled;
        expect(usePlaybackStore.getState().audioSrc).toBeNull(); expect(shared.shouldAutoPlayRef.current).toBe(false);
    });
    it('cancels on same-song Pause and lets a new Play own recovery before the late cancelled request completes', async () => {
        const shared = sharedProps(); usePlaybackStore.setState({ currentSong: song, audioSrc: null, playerState: PlayerState.PAUSED });
        const completions: Array<(value: unknown) => void> = [];
        bridge.mockImplementation(input => input.action === 'audio' ? new Promise(resolve => { completions.push(resolve); }) : Promise.resolve(null));
        const audio = { currentTime: 0, currentSrc: '', paused: true, ended: false, play: vi.fn(), pause: vi.fn() } as unknown as HTMLAudioElement;
        const pendingRef = ref<Promise<boolean> | null>(null), recovery = createOnlineRecoveryController({ ...shared,
            audioQuality: 'high', currentSong: song, audioSrc: null, audioRef: ref(audio), currentSongRef: ref(getPlaybackSongKey(song)),
            pendingResumeTimeRef: ref(null), onlinePlaybackRecoveryRef: pendingRef, lastAudioRecoverySourceRef: ref(null),
            playQueue: [song], onlineAudioUrlTtlMs: 1000, onlineAudioUrlRefreshBufferMs: 100 });
        let transport: ReturnType<typeof usePlaybackTransportController>;
        const props = { ...recovery, audioRef: ref(audio), stageActiveEntryKind: null, isNowPlayingStageActive: false,
            audioContextRef: ref(null), stageLyricsClockRef: ref({ startTimeSec: 0, endTimeSec: 0, baseTimeSec: 0, startedAtMs: null }),
            setupAudioAnalyzer: vi.fn(), syncOutputGain: vi.fn(), getTargetPlaybackVolume: () => 1,
            getSyntheticStageLyricsTime: () => 0, syncStageLyricsClock: vi.fn() };
        function Probe() { transport = usePlaybackTransportController(props); return null; }
        root = createRoot(document.createElement('div')); act(() => root!.render(React.createElement(Probe)));
        const first = transport!.resumePlayback(); await vi.waitFor(() => expect(completions).toHaveLength(1));
        act(() => transport!.pausePlayback()); expect(pendingRef.current).toBeNull();
        expect(bridge.mock.calls.filter(([input]) => input.action === 'cancelAudio')).toHaveLength(1);
        const second = transport!.resumePlayback(); await vi.waitFor(() => expect(completions).toHaveLength(2));
        const replacement = pendingRef.current;
        completions[0]({ url: 'http://127.0.0.1:12345/cancelled', playbackTransport: 'cable-pcm' }); await first;
        expect(pendingRef.current).toBe(replacement); expect(usePlaybackStore.getState().audioSrc).toBeNull();
        await act(async () => { completions[1]({ url: freshSource, playbackTransport: 'cable-pcm' }); await second; });
        expect(usePlaybackStore.getState().audioSrc).toBe(freshSource); expect(shared.shouldAutoPlayRef.current).toBe(true);
    });
    it.each(['unmount', 'pause', 'replacement'])('does not start a late startup restore after %s while the session cache is still pending', async reason => {
        const shared = sharedProps(); useAudioSettingsStore.setState({ autoPlayOnLaunch: true });
        let finish!: (value: unknown) => void;
        cachedSession.mockImplementation(key => key === 'last_song' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([song]));
        const props = { ...shared, clearPersistedStagePlaybackCache: vi.fn(), loadLocalSongs: vi.fn(), loadLocalPlaylists: vi.fn() };
        function Probe() { useSessionRestoreController(props); return null; }
        root = createRoot(document.createElement('div')); act(() => root!.render(React.createElement(Probe)));
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        if (reason === 'unmount') { act(() => root!.unmount()); root = undefined; }
        else if (reason === 'pause') cancelPlaybackSourceRequest();
        else beginPlaybackSourceRequest();
        finish(song); await new Promise(resolve => setTimeout(resolve, 0));
        expect(bridge.mock.calls.filter(([request]: any[]) => request.action !== 'lyrics')).toHaveLength(0); expect(usePlaybackStore.getState().currentSong).toBeNull();
    });
    it.each(['pause', 'play', 'unmount'])('does not consume a late window snapshot after a newer %s intent', async intent => {
        const shared = sharedProps(); let finish!: (value: unknown) => void;
        window.electron!.consumeWindowPlaybackHandoff = vi.fn(() => new Promise(resolve => { finish = resolve; })) as any;
        let handoff: ReturnType<typeof useElectronWindowPlaybackHandoff>;
        const props = { ...shared, isElectronWindow: true, navigateToPlayer: vi.fn(), audioRef: ref(null),
            mainPlaybackSnapshotRef: ref(null), stageStatus: null, stageSource: null,
            stageLyricsClockRef: ref({ startTimeSec: 0, endTimeSec: 0, baseTimeSec: 0, startedAtMs: null }),
            nowPlayingTrack: null, nowPlayingLyricPayload: null, nowPlayingPaused: true, nowPlayingProgressMs: 0,
            nowPlayingProgressQuality: 'coarse' as const, getNowPlayingDisplayTime: () => 0, restoreStagePlaybackHandoff: vi.fn(),
            setIsLyricsLoading: vi.fn(), pendingResumeTimeRef: ref(null), lastAudioRecoverySourceRef: ref(null),
            applyTransparentPlayerBackground: vi.fn() };
        function Probe() { handoff = useElectronWindowPlaybackHandoff(props); return null; }
        root = createRoot(document.createElement('div')); act(() => root!.render(React.createElement(Probe)));
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        let replacement: AbortController | undefined;
        if (intent === 'unmount') { act(() => root!.unmount()); root = undefined; }
        else if (intent === 'pause') cancelPlaybackSourceRequest(); else replacement = beginPlaybackSourceRequest();
        const snapshot = { currentSong: song, lyrics: null, cachedCoverUrl: null, audioSrc: 'http://127.0.0.1:12345/expired',
            playQueue: [song], isFmMode: false, playerState: PlayerState.PLAYING, currentTime: 12, duration: 120, currentLineIndex: -1 };
        await act(async () => { finish({ version: 1, activePlaybackContext: 'main', mainPlayback: snapshot, activePlayback: snapshot,
            ui: { currentView: 'player', playerChromeHidden: false, mainWindowBorderVisible: false } }); });
        expect(bridge.mock.calls.filter(([request]: any[]) => request.action !== 'lyrics')).toHaveLength(0); expect(usePlaybackStore.getState().currentSong).toBeNull();
        expect(shared.shouldAutoPlayRef.current).toBe(false);
        if (replacement) expect(replacement.signal.aborted).toBe(false);
        if (intent !== 'unmount') expect(handoff!.restoreStatus).toBe('superseded');
    });
    it('does not publish prepared queue audio or autoplay after Pause during its cover lookup', async () => {
        const props = mount(); let finishCover!: () => void;
        cachedCover.mockImplementationOnce(() => new Promise(resolve => { finishCover = () => resolve(null); }));
        const playing = queue.playSong(song, [song]);
        await vi.waitFor(() => expect(finishCover).toBeTypeOf('function'));
        expect(props.shouldAutoPlayRef.current).toBe(true);
        expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(1);
        cancelPlaybackSourceRequest(); // Same explicit Pause path exercised in the mounted transport test above.
        expect(props.shouldAutoPlayRef.current).toBe(false);
        await act(async () => { finishCover(); await playing; });
        expect(usePlaybackStore.getState().audioSrc).toBeNull();
        expect(props.shouldAutoPlayRef.current).toBe(false);
    });
    it.each(['aborted', 'stale'])('rejects an already-%s restore before it can cancel a valid replacement', async mode => {
        const replacement = beginPlaybackSourceRequest(), abort = new AbortController();
        if (mode === 'aborted') abort.abort();
        await expect(restorePlaybackSourceForSong(song, { ...sharedProps(), audioQuality: 'high', allowSessionBoundPlayback: true,
            signal: abort.signal, isCurrent: () => mode !== 'stale' })).resolves.toBe(false);
        expect(replacement.signal.aborted).toBe(false); expect(bridge.mock.calls.filter(([request]: any[]) => request.action !== 'lyrics')).toHaveLength(0);
    });
    it('rejects a stale retained recovery callback before it can cancel the replacement source owner', async () => {
        const replacement = beginPlaybackSourceRequest(), shared = sharedProps();
        const recovery = createOnlineRecoveryController({ ...shared, audioQuality: 'high', currentSong: song, audioSrc: null,
            audioRef: ref({ currentTime: 0, currentSrc: '' } as HTMLAudioElement), currentSongRef: ref(getPlaybackSongKey(nextSong)),
            pendingResumeTimeRef: ref(null), onlinePlaybackRecoveryRef: ref(null), lastAudioRecoverySourceRef: ref(null),
            playQueue: [song], onlineAudioUrlTtlMs: 1000, onlineAudioUrlRefreshBufferMs: 100 });
        await expect(recovery.recoverOnlinePlaybackSource({ autoplay: true })).rejects.toMatchObject({ name: 'AbortError' });
        expect(replacement.signal.aborted).toBe(false); expect(bridge.mock.calls.filter(([request]: any[]) => request.action !== 'lyrics')).toHaveLength(0);
    });
    it('defaults source restoration to metadata only and explicit Play prepares the missing source before touching the empty deck', async () => {
        const shared = sharedProps(); usePlaybackStore.setState({ currentSong: song, audioSrc: null, playerState: PlayerState.PAUSED });
        await restorePlaybackSourceForSong(song, { ...shared, audioQuality: 'high' });
        expect(bridge.mock.calls.filter(([request]: any[]) => request.action !== 'lyrics')).toHaveLength(0); expect(usePlaybackStore.getState().audioSrc).toBeNull();
        const audio = { currentTime: 0, currentSrc: '', paused: true, ended: false, play: vi.fn() } as unknown as HTMLAudioElement;
        const audioRef = ref(audio), recovery = createOnlineRecoveryController({ audioQuality: 'high', currentSong: song, audioSrc: null,
            audioRef, currentSongRef: ref(getPlaybackSongKey(song)), ...shared, pendingResumeTimeRef: ref(null),
            onlinePlaybackRecoveryRef: ref(null), lastAudioRecoverySourceRef: ref(null), playQueue: [song],
            onlineAudioUrlTtlMs: 1000, onlineAudioUrlRefreshBufferMs: 100 });
        expect(recovery.shouldRefreshCurrentOnlineAudioSource()).toBe(true);
        await expect(recovery.recoverOnlinePlaybackSource({ autoplay: false })).resolves.toBe(false);
        expect(bridge.mock.calls.filter(([request]: any[]) => request.action !== 'lyrics')).toHaveLength(0);
        let transport: ReturnType<typeof usePlaybackTransportController>;
        const props = { ...recovery, audioRef, stageActiveEntryKind: null, isNowPlayingStageActive: false,
            audioContextRef: ref(null), stageLyricsClockRef: ref({ startTimeSec: 0, endTimeSec: 0, baseTimeSec: 0, startedAtMs: null }),
            setupAudioAnalyzer: vi.fn(), syncOutputGain: vi.fn(), getTargetPlaybackVolume: () => 1,
            getSyntheticStageLyricsTime: () => 0, syncStageLyricsClock: vi.fn() };
        function Probe() { transport = usePlaybackTransportController(props); return null; }
        root = createRoot(document.createElement('div'));
        act(() => root!.render(React.createElement(Probe)));
        await act(async () => { await transport!.resumePlayback(); });
        expect(bridge.mock.calls.filter(([input]) => input.action === 'audio')).toHaveLength(1);
        expect(usePlaybackStore.getState().audioSrc).toBe(freshSource);
        expect(shared.shouldAutoPlayRef.current).toBe(true); expect(audio.play).not.toHaveBeenCalled();
    });
});
