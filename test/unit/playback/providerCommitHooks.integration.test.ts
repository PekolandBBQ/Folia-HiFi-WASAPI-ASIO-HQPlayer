// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Real React hooks -> source commit -> Omni -> Spotify adapter/IPC; media lookup and OS are fixtures.
vi.hoisted(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true,
        value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
});
const bridge = vi.hoisted(() => vi.fn());
const audioLookup = vi.hoisted(() => vi.fn());
const lyricLookup = vi.hoisted(() => vi.fn(async () => null));
const localLookup = vi.hoisted(() => vi.fn());
const localRows = vi.hoisted(() => vi.fn());
const externalCalls = vi.hoisted(() => [] as unknown[]);
vi.hoisted(() => { vi.stubGlobal('fetch', (...args: unknown[]) => {
    externalCalls.push(args); throw new Error('No network permitted in provider hook tests');
}); });
vi.mock('@/services/onlinePlayback', async original => ({
    ...await original<typeof import('@/services/onlinePlayback')>(),
    loadOnlineSongAudioSource: audioLookup, loadOnlineSongLyrics: lyricLookup,
}));
vi.mock('@/services/db', async original => ({
    ...await original<typeof import('@/services/db')>(), getFromCache: async () => null,
    getFromCacheWithMigration: async () => ({ noAutoMatch: true }), getLocalSongs: localRows,
}));
vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongAudioBlob: async () => null, hasCachedSongAudio: async () => false,
    getCachedSongCoverUrl: async () => null, getSongCacheWithLegacyMigration: async () => null,
}));
vi.mock('@/services/prefetchService', () => ({
    getPrefetchedData: () => null, prefetchNearbySongs: () => {}, invalidateAndRefetch: () => {},
    isUrlValid: () => false, updatePrefetchedAudioUrl: () => {},
}));
vi.mock('@/services/playbackFade', () => ({ playbackFade: {
    flush: () => {}, isFadingOut: () => false, prepareFadeIn: () => null, abortFadeIn: () => {},
    runFadeIn: () => {}, cancelPendingPause: () => false, fadeOutThen: () => false,
}, markProgrammaticPause: () => {} }));
vi.mock('@/utils/onlineLyricsState', async original => ({
    ...await original<typeof import('@/utils/onlineLyricsState')>(), loadOnlineLyricsState: async () => null,
}));
vi.mock('@/utils/lyrics/autoMatchBestLyric', () => ({ autoMatchBestLyric: async () => null }));
vi.mock('@/utils/lyrics/localSongLyrics', () => ({ resolveLocalSongLyrics: async () => ({ lyrics: null, source: null }) }));
vi.mock('@/utils/lyrics/localSongMatchContext', () => ({
    buildLocalSongLyricMatchContext: () => ({}), shouldRefreshLocalSongLyricsFromMetadata: () => false,
    shouldRunLocalSongAutomaticMatch: () => false,
}));
vi.mock('@/services/localMusicService', async original => ({
    ...await original<typeof import('@/services/localMusicService')>(),
    ensureLocalSongCoverAsset: async (song: unknown) => song, getAudioFromLocalSong: localLookup,
}));
vi.mock('@/services/localLibraryEntityRepository', () => ({ getLocalLibraryCatalogSnapshot: async () => ({ entities: [], assignments: [] }) }));
vi.mock('@/services/localPlaylistService', async original => ({
    ...await original<typeof import('@/services/localPlaylistService')>(), getLocalPlaylists: async () => [],
}));
vi.mock('@/services/navidromeService', async original => ({
    ...await original<typeof import('@/services/navidromeService')>(),
    getNavidromeConfig: () => ({ url: 'https://fixture.invalid' }),
    navidromeApi: { getStreamUrl: () => 'https://fixture.invalid/nav-audio', getSong: async () => null,
        getCoverArtUrl: () => '', updatePlaylist: async () => null, createPlaylist: async () => null },
}));
vi.mock('@/utils/appNavidromeLyrics', () => ({ hydrateNavidromeLyricPayload: async () => {}, resolvePreferredNavidromeLyrics: async () => null }));

import { usePlaybackQueueController } from '@/hooks/usePlaybackQueueController';
import { usePlaybackTransportController } from '@/hooks/usePlaybackTransportController';
import { restorePlaybackSourceForSong } from '@/components/app/playback/restorePlaybackSource';
import { buildUnifiedLocalSong } from '@/services/playbackAdapters';
import { activatePlaybackSource, isPassivePlaybackSource } from '@/services/playbackSourceIntent';
import { useLibraryPlaybackController } from '@/hooks/useLibraryPlaybackController';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';
import { registerOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';
import { normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';
import { cancelPlaybackSourceRequest } from '@/services/playbackSourceRequest';
import { PlayerState, type LocalSong, type SongResult } from '@/types';
import type { NavidromeSong } from '@/types/navidrome';
import i18n from '@/i18n/config';
import fs from 'node:fs';
import { parse } from '@babel/parser';
// test/unit/playback/providerCommitHooks.integration.test.ts

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ref = <T,>(current: T) => ({ current });
const spotifySong = normalizeSpotifySong({ id: '0123456789012345678901', name: 'Spotify A', type: 'track' });
const spotifyNext = normalizeSpotifySong({ id: '1123456789012345678901', name: 'Spotify B', type: 'track' });
const online = (providerId: string): SongResult => ({ id: `${providerId}-1`, name: 'Fixture song', artists: [], album: { id: 0, name: '' },
    durationMs: 120000, sourceRef: { kind: 'online', providerId, mediaId: `${providerId}-1` } });
const localSong = { id: 'local-one', title: 'Local fixture', titleOrigin: 'import', duration: 120000,
    importedMetadata: { artistNames: [], albumName: '' }, hasLocalLyrics: true, hasEmbeddedLyrics: true,
} as unknown as LocalSong;
const navSong = { id: 'nav-one', name: 'Nav fixture', artists: [], durationMs: 120000,
    navidromeData: { id: 'nav-one', title: 'Nav fixture', duration: 120, artist: '', album: '' },
    isNavidrome: true, sourceRef: { kind: 'navidrome', mediaId: 'nav-one' },
} as unknown as NavidromeSong;
const deferred = <T,>() => {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};
let root: Root | undefined;
let queue: ReturnType<typeof usePlaybackQueueController>;
let library: ReturnType<typeof useLibraryPlaybackController>;

function mount() {
    const shared = { setLyrics: vi.fn(), setIsLyricsLoading: vi.fn(), navigateToPlaybackView: vi.fn(),
        persistLastPlaybackCache: vi.fn(async () => {}), restoreCachedThemeForSong: vi.fn(async () => null),
        interruptStagePlaybackForMainTransition: vi.fn(() => null), blobUrlRef: ref<string | null>(null),
        shouldAutoPlayRef: ref(false), currentSongRef: ref<string | number | null>(null), playbackGenerationRef: ref(0),
        currentOnlineAudioUrlFetchedAtRef: ref<number | null>(null) };
    const audio = { pause: vi.fn(), play: vi.fn(async () => {}), currentTime: 0, paused: false, ended: false };
    const props = { ...shared, isNowPlayingStageActive: false, shouldNavigateToPlayerOnTrackChange: false,
        localSongs: [localSong], localLibraryCatalog: { entities: [], assignments: [] }, navigateToSearch: vi.fn(),
        onAddLocalSongToQueue: vi.fn(), onAddNavidromeSongsToQueue: vi.fn(),
        searchDeps: { submitSearch: vi.fn(), loadMoreSearchResults: vi.fn() }, audioRef: ref(audio),
        mainPlaybackSnapshotRef: ref(null), playbackAutoSkipCountRef: ref(0), pendingResumeTimeRef: ref(null),
        lastAudioRecoverySourceRef: ref(null),
    };
    function Probe() {
        library = useLibraryPlaybackController({ ...shared, likedSongIds: new Set(), setLikedSongIds: vi.fn() });
        queue = usePlaybackQueueController({ ...props, onPlayLocalSong: library.onPlayLocalSong,
            onPlayNavidromeSong: library.onPlayNavidromeSong } as unknown as Parameters<typeof usePlaybackQueueController>[0]);
        return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(React.createElement(Probe)));
    return { ...shared, audio };
}
beforeEach(async () => {
    vi.clearAllMocks(); lyricLookup.mockReset().mockResolvedValue(null); externalCalls.length = 0;
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    window.electron = { spotify: { request: bridge, onProgress: () => () => {} } } as unknown as typeof window.electron;
    registerOnlineMusicProvider(spotifyProvider);
    bridge.mockImplementation(async (input: { action: string }) => input.action === 'sourceRevision' ? { revision: 7 } : null);
    audioLookup.mockImplementation(async (song: SongResult) => ({ kind: 'ok', audioSrc: `https://fixture.invalid/${song.id}.flac` }));
    localLookup.mockResolvedValue('blob:local-one');
    localRows.mockResolvedValue([localSong]);
    activatePlaybackSource('blob:local-one');
    await i18n.changeLanguage('zh-CN');
    usePlaybackStore.setState({ currentSong: spotifySong, audioSrc: 'https://fixture.invalid/old-spotify',
        playQueue: [spotifySong, spotifyNext], activePlaybackContext: 'main', playerState: PlayerState.PLAYING, isFmMode: false });
    useAudioSettingsStore.setState({ audioQuality: 'high', nativeAudioBackend: 'browser', autoPlayOnLaunch: false, loopMode: 'off' });
    useStatusMessageStore.setState({ message: null });
});
afterEach(() => {
    cancelPlaybackSourceRequest(); act(() => root?.unmount()); root = undefined;
    expect(externalCalls).toEqual([]); vi.restoreAllMocks();
});

describe('actual queue/library source commit through Omni and Spotify adapter', () => {
    it('Spotify track selection never dispatches leaveProvider', async () => {
        const state = mount(); await act(async () => queue.playSong(spotifyNext, [spotifySong, spotifyNext]));
        expect(bridge).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id);
        expect(state.shouldAutoPlayRef.current).toBe(true);
    });
    it.each(['netease', 'qq', 'kugou'])('waits for exact old provider exit before %s queue source commit', async provider => {
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const state = mount(), target = online(provider);
        let task!: Promise<void>;
        await act(async () => { task = queue.playSong(target, [target]); });
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith({ action: 'leaveProvider', expectedSourceRevision: 7 }));
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id);
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        await act(async () => { restore.resolve(null); await task; });
        expect(usePlaybackStore.getState().currentSong?.sourceRef).toMatchObject({ providerId: provider });
        expect(state.shouldAutoPlayRef.current).toBe(true);
        expect(bridge.mock.calls.map(([x]) => x.action)).toEqual(['sourceRevision', 'leaveProvider']);
    });
    it('a rejected provider restore cannot publish the new online track', async () => {
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 }
            : { spotifyError: { code: 'setup-required', message: 'Spotify: route-restore-unconfirmed' } });
        const state = mount(), target = online('qq'); await act(async () => queue.playSong(target, [target]));
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id);
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        expect(state.shouldAutoPlayRef.current).toBe(false);
        expect(useStatusMessageStore.getState().message?.type).toBe('error');
    });
    it('late cancelled old provider barrier cannot cancel newer Spotify autoplay intent', async () => {
        const revision = deferred<{ revision: number }>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? revision.promise : null);
        const state = mount(), target = online('netease');
        let old!: Promise<void>; await act(async () => { old = queue.playSong(target, [target]); });
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith({ action: 'sourceRevision' }));
        await act(async () => queue.playSong(spotifyNext, [spotifyNext]));
        expect(state.shouldAutoPlayRef.current).toBe(true);
        await act(async () => { revision.resolve({ revision: 7 }); await old; });
        expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(false);
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id);
        expect(state.shouldAutoPlayRef.current).toBe(true);
    });
    it('local file commits only after the same provider restore barrier', async () => {
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const state = mount(); let task!: Promise<void>;
        await act(async () => { task = library.onPlayLocalSong(localSong); });
        await vi.waitFor(() => expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(true));
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        await act(async () => { restore.resolve(null); await task; });
        expect(usePlaybackStore.getState().audioSrc).toBe('blob:local-one');
        expect(usePlaybackStore.getState().currentSong?.sourceRef?.kind).toBe('local');
        expect(state.shouldAutoPlayRef.current).toBe(true);
    });
    it('unavailable local file does not leave Spotify', async () => {
        localLookup.mockResolvedValue(null); mount(); await act(async () => library.onPlayLocalSong(localSong));
        expect(bridge).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id);
    });
    it('slow old local read cannot later leave a newer Spotify selection', async () => {
        const local = deferred<string>(); localLookup.mockReturnValue(local.promise); const state = mount();
        let old!: Promise<void>; await act(async () => { old = library.onPlayLocalSong(localSong); });
        await act(async () => queue.playSong(spotifyNext, [spotifyNext]));
        await act(async () => { local.resolve('blob:stale-local'); await old; });
        expect(bridge).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id);
        expect(state.shouldAutoPlayRef.current).toBe(true);
    });
    it('failed local restore leaves old source and error visible', async () => {
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 }
            : { spotifyError: { code: 'setup-required', message: 'Spotify: route-restore-unconfirmed' } });
        const state = mount(); await act(async () => library.onPlayLocalSong(localSong));
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id);
        expect(state.shouldAutoPlayRef.current).toBe(false);
        expect(useStatusMessageStore.getState().message?.type).toBe('error');
    });
    it('Navidrome uses the same real hook and awaits Spotify restoration before source commit', async () => {
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const state = mount(); let task!: Promise<void>;
        await act(async () => { task = library.onPlayNavidromeSong(navSong); });
        await vi.waitFor(() => expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(true));
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        await act(async () => { restore.resolve(null); await task; });
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/nav-audio');
        expect(state.shouldAutoPlayRef.current).toBe(true);
    });
    it('late old local restore cannot publish over a newer Spotify intent', async () => {
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const state = mount(); let old!: Promise<void>;
        await act(async () => { old = library.onPlayLocalSong(localSong); });
        await vi.waitFor(() => expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(true));
        await act(async () => queue.playSong(spotifyNext, [spotifyNext]));
        await act(async () => { restore.resolve(null); await old; });
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id);
        expect(state.shouldAutoPlayRef.current).toBe(true);
    });
});


const unifiedLocal = () => buildUnifiedLocalSong({ localSong, matchedSong: null, coverUrl: null, preferOnlineMetadata: false });
const restoreOptions = (activatePlayback: boolean) => ({ audioQuality: 'high' as const,
    blobUrlRef: ref<string | null>(null), currentOnlineAudioUrlFetchedAtRef: ref<number | null>(null),
    setLyrics: vi.fn(), restoreCachedThemeForSong: vi.fn(async () => null), activatePlayback });

function mountTransport() {
    let transport!: ReturnType<typeof usePlaybackTransportController>;
    const audio = { paused: true, ended: false, currentTime: 17, currentSrc: 'blob:local-one',
        src: 'blob:local-one', play: vi.fn(async () => {}), pause: vi.fn() } as unknown as HTMLAudioElement;
    const props = { stageActiveEntryKind: null, isNowPlayingStageActive: false,
        audioRef: ref(audio), audioContextRef: ref<AudioContext | null>(null),
        stageLyricsClockRef: ref({ startTimeSec: 0, endTimeSec: 0, baseTimeSec: 0, startedAtMs: null as number | null }),
        setupAudioAnalyzer: vi.fn(), syncOutputGain: vi.fn(), getTargetPlaybackVolume: () => 1,
        shouldRefreshCurrentOnlineAudioSource: () => false, recoverOnlinePlaybackSource: vi.fn(async () => ({ status: 'not-attempted' as const })),
        getSyntheticStageLyricsTime: () => 0, syncStageLyricsClock: vi.fn() };
    function Probe() { transport = usePlaybackTransportController(props); return null; }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(React.createElement(Probe)));
    return { audio, props, get transport() { return transport; } };
}

describe('passive rehydration and later real Play intent', () => {
    it('remembered paused local source performs no provider exit and marks lazy output', async () => {
        expect(await restorePlaybackSourceForSong(unifiedLocal(), restoreOptions(false))).toBe('restored');
        expect(bridge).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().audioSrc).toBe('blob:local-one');
        expect(isPassivePlaybackSource('blob:local-one')).toBe(true);
    });
    it('autoplay rehydration waits for provider restore before publishing the local source', async () => {
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const task = restorePlaybackSourceForSong(unifiedLocal(), restoreOptions(true));
        await vi.waitFor(() => expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(true));
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        restore.resolve(null); expect(await task).toBe('restored');
        expect(usePlaybackStore.getState().audioSrc).toBe('blob:local-one');
        expect(isPassivePlaybackSource('blob:local-one')).toBe(false);
    });
    it('failed restore during autoplay cannot publish or load the new source', async () => {
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 }
            : { spotifyError: { code: 'setup-required', message: 'Spotify: route-restore-unconfirmed' } });
        expect(await restorePlaybackSourceForSong(unifiedLocal(), restoreOptions(true))).toBe('failed');
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        expect(useStatusMessageStore.getState().message?.type).toBe('error');
    });
    it('explicit Play of a passively restored source waits for the real provider exit', async () => {
        await restorePlaybackSourceForSong(unifiedLocal(), restoreOptions(false));
        usePlaybackStore.setState({ playerState: PlayerState.PAUSED });
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const mounted = mountTransport(); let task!: Promise<void>;
        await act(async () => { task = mounted.transport.resumePlayback(); });
        await vi.waitFor(() => expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(true));
        expect(mounted.audio.play).not.toHaveBeenCalled();
        await act(async () => { restore.resolve(null); await task; });
        expect(mounted.audio.play).toHaveBeenCalledTimes(1);
        expect(isPassivePlaybackSource('blob:local-one')).toBe(false);
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.PLAYING);
    });
    it('failed provider restore blocks explicit Play and preserves its error', async () => {
        await restorePlaybackSourceForSong(unifiedLocal(), restoreOptions(false));
        usePlaybackStore.setState({ playerState: PlayerState.PAUSED });
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 }
            : { spotifyError: { code: 'setup-required', message: 'Spotify: route-restore-unconfirmed' } });
        const mounted = mountTransport(); await act(async () => mounted.transport.resumePlayback());
        expect(mounted.audio.play).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.PAUSED);
        expect(useStatusMessageStore.getState().message?.type).toBe('error');
    });
    it('Pause while provider exit is pending cancels the waiting Play intent', async () => {
        await restorePlaybackSourceForSong(unifiedLocal(), restoreOptions(false));
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const mounted = mountTransport(); let task!: Promise<void>;
        await act(async () => { task = mounted.transport.resumePlayback(); });
        await vi.waitFor(() => expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(true));
        act(() => mounted.transport.pausePlayback());
        await act(async () => { restore.resolve(null); await task; });
        expect(mounted.audio.play).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.PAUSED);
    });
    it('new Spotify selection prevents old pending local Play from firing', async () => {
        await restorePlaybackSourceForSong(unifiedLocal(), restoreOptions(false));
        const restore = deferred<unknown>();
        bridge.mockImplementation(async input => input.action === 'sourceRevision' ? { revision: 7 } : restore.promise);
        const mounted = mountTransport(); let task!: Promise<void>;
        await act(async () => { task = mounted.transport.resumePlayback(); });
        await vi.waitFor(() => expect(bridge.mock.calls.some(([x]) => x.action === 'leaveProvider')).toBe(true));
        act(() => usePlaybackStore.setState({ currentSong: spotifyNext, audioSrc: 'https://fixture.invalid/new-spotify' }));
        await act(async () => { restore.resolve(null); await task; });
        expect(mounted.audio.play).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id);
    });
});


// Extract the actual App handler, rather than copying its queue decisions into the fixture.
const appSource = fs.readFileSync(process.cwd() + '/src/App.tsx', 'utf8');
const appTree = parse(appSource, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
const endedHandlers: string[] = [];
function collectEnded(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collectEnded); return; }
    const node = value as { type?: string; name?: { name?: string }; value?: { expression?: { start: number; end: number } } };
    if (node.type === 'JSXAttribute' && node.name?.name === 'onEnded' && node.value?.expression) {
        endedHandlers.push(appSource.slice(node.value.expression.start, node.value.expression.end));
    }
    Object.values(value).forEach(collectEnded);
}
collectEnded(appTree);
if (endedHandlers.length !== 1) throw new Error('Update fixture to bind the single actual App onEnded handler');
const compiledEnded = 'const ended = ' + endedHandlers[0] + ';';
function actualAppEnded(mode: 'one' | 'all' | 'off', currentElement: unknown, active = true) {
    const tailEnded = vi.fn(), cached = vi.fn();
    const handler = new Function('automix', 'audioSrc', 'currentSong', 'isStagePlaybackSong',
        'cacheSongAssets', 'playbackFade', 'effectiveLoopMode', 'handleNextTrack',
        compiledEnded + '; return ended;')(
        { isActiveDeck: (element: unknown) => active && element === currentElement, handleTailEnded: tailEnded },
        usePlaybackStore.getState().audioSrc, usePlaybackStore.getState().currentSong, () => false,
        cached, { isFadingOut: () => false, flush: vi.fn() }, mode,
        (options: Parameters<typeof queue.handleNextTrack>[0]) => queue.handleNextTrack(options));
    return { fire: () => handler({ currentTarget: currentElement }), tailEnded, cached };
}

describe('actual queue navigation and actual App EOF decisions', () => {
    it('Next then Previous keep Spotify provider ownership and reset track start', async () => {
        const mounted = mount();
        await act(async () => { await queue.handleNextTrack(); });
        await vi.waitFor(() => expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id));
        expect(mounted.shouldAutoPlayRef.current).toBe(true);
        await act(async () => { queue.handlePrevTrack(); });
        await vi.waitFor(() => expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id));
        expect(bridge).not.toHaveBeenCalled();
        expect(mounted.shouldAutoPlayRef.current).toBe(true);
    });
    it('list loop wraps last Next and first Previous without leaving Spotify', async () => {
        useAudioSettingsStore.setState({ loopMode: 'all' });
        usePlaybackStore.setState({ currentSong: spotifyNext });
        mount(); await act(async () => { await queue.handleNextTrack(); });
        await vi.waitFor(() => expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id));
        await act(async () => { queue.handlePrevTrack(); });
        await vi.waitFor(() => expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id));
        expect(bridge).not.toHaveBeenCalled();
    });
    it('natural EOF advances through the actual App handler and queue hook', async () => {
        const mounted = mount();
        await act(async () => { actualAppEnded('off', mounted.audio).fire(); });
        await vi.waitFor(() => expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id));
        expect(bridge).not.toHaveBeenCalled();
    });
    it('final EOF with repeat off settles IDLE while retaining provider route', async () => {
        usePlaybackStore.setState({ currentSong: spotifyNext }); const mounted = mount();
        await act(async () => { actualAppEnded('off', mounted.audio).fire(); });
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.IDLE);
        expect(mounted.audio.pause).toHaveBeenCalledTimes(1);
        expect(bridge).not.toHaveBeenCalled();
    });
    it('list-loop natural EOF wraps through the same real queue hook', async () => {
        useAudioSettingsStore.setState({ loopMode: 'all' });
        usePlaybackStore.setState({ currentSong: spotifyNext }); const mounted = mount();
        await act(async () => { actualAppEnded('all', mounted.audio).fire(); });
        await vi.waitFor(() => expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id));
        expect(bridge).not.toHaveBeenCalled();
    });
    it('single-loop EOF stays with native looping rather than selecting another song', async () => {
        useAudioSettingsStore.setState({ loopMode: 'one' }); const mounted = mount();
        await act(async () => { actualAppEnded('one', mounted.audio).fire(); });
        expect(audioLookup).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id);
        expect(bridge).not.toHaveBeenCalled();
    });
    it('late ended from an inactive deck cannot advance the current queue', async () => {
        const mounted = mount(), handler = actualAppEnded('off', mounted.audio, false);
        await act(async () => { handler.fire(); });
        expect(handler.tailEnded).toHaveBeenCalledTimes(1);
        expect(audioLookup).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id);
    });
    it('EOF after the queue is emptied settles instead of leaving PLAYING', async () => {
        usePlaybackStore.setState({ playQueue: [] }); const mounted = mount();
        await act(async () => { actualAppEnded('off', mounted.audio).fire(); });
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.IDLE);
        expect(mounted.audio.pause).toHaveBeenCalledTimes(1);
        expect(bridge).not.toHaveBeenCalled();
    });
    it('passive restore aborted during local read cannot publish a stale source', async () => {
        const source = deferred<string>(); localLookup.mockReturnValue(source.promise);
        const abort = new AbortController();
        const task = restorePlaybackSourceForSong(unifiedLocal(), { ...restoreOptions(false), signal: abort.signal });
        await vi.waitFor(() => expect(localLookup).toHaveBeenCalled());
        abort.abort(); source.resolve('blob:cancelled');
        expect(await task).toBe('stale');
        expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/old-spotify');
        expect(bridge).not.toHaveBeenCalled();
    });
});

// A retired deck can report EOF while the selected song is still resolving.
it('does not let old-deck automatic next replace a pending card selection', async () => {
    mount(); const pending = deferred<any>();
    const selected = normalizeSpotifySong({ id: '2123456789012345678901', name: 'Selected C', type: 'track' });
    audioLookup.mockImplementation(song => song.id === selected.id ? pending.promise
        : Promise.resolve({ kind: 'ok', audioSrc: 'https://fixture.invalid/' + song.id }));
    let task!: Promise<void>;
    await act(async () => { task = queue.playSong(selected, [spotifySong, spotifyNext, selected]); });
    await vi.waitFor(() => expect(audioLookup).toHaveBeenCalledTimes(1));
    await act(async () => { await queue.handleNextTrack({ trigger: 'ended', allowStopOnMissing: true }); });
    expect(audioLookup).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ kind: 'ok', audioSrc: 'https://fixture.invalid/selected' }); await task; });
    expect(usePlaybackStore.getState().currentSong?.id).toBe(selected.id);
});
it('rapid A/B/C selections commit only C even when B resolves last', async () => {
    mount(); const pending = deferred<any>();
    const selected = normalizeSpotifySong({ id: '2123456789012345678901', name: 'Selected C', type: 'track' });
    audioLookup.mockImplementation(song => song.id === spotifyNext.id ? pending.promise
        : Promise.resolve({ kind: 'ok', audioSrc: 'https://fixture.invalid/' + song.id }));
    let old!: Promise<void>;
    await act(async () => { old = queue.playSong(spotifyNext, [spotifySong, spotifyNext, selected]); });
    await vi.waitFor(() => expect(audioLookup).toHaveBeenCalledTimes(1));
    await act(async () => { await queue.playSong(selected, [spotifySong, spotifyNext, selected]); });
    await act(async () => { pending.resolve({ kind: 'ok', audioSrc: 'https://fixture.invalid/old' }); await old; });
    expect(usePlaybackStore.getState().currentSong?.id).toBe(selected.id);
    expect(usePlaybackStore.getState().audioSrc).toBe('https://fixture.invalid/' + selected.id);
});

it('late outgoing lyric failure cannot erase the new track lyrics', async () => {
 const slow=deferred<null>(); lyricLookup.mockImplementationOnce(()=>slow.promise);
 const state=mount(); let first!:Promise<void>;
 await act(async()=>{first=queue.playSong(spotifySong,[spotifySong,spotifyNext]);});
 await vi.waitFor(()=>expect(lyricLookup).toHaveBeenCalledTimes(1));
 await act(async()=>queue.playSong(spotifyNext,[spotifySong,spotifyNext]));
 state.setLyrics.mockClear();state.setIsLyricsLoading.mockClear();
 await act(async()=>{slow.reject(Error('late lyric failure'));await first;});
 expect(state.setLyrics).not.toHaveBeenCalled();expect(state.setIsLyricsLoading).not.toHaveBeenCalled();
});
it('next, previous and automatic advance preserve inline navigation', async () => {
 const state=mount();
 await act(async()=>queue.handleNextTrack());
 await vi.waitFor(()=>expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id));
 await act(async()=>queue.handlePrevTrack());
 await vi.waitFor(()=>expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifySong.id));
 await act(async()=>queue.handleNextTrack({trigger:'ended'}));
 await vi.waitFor(()=>expect(usePlaybackStore.getState().currentSong?.id).toBe(spotifyNext.id));
 expect(state.navigateToPlaybackView).not.toHaveBeenCalled();
});

it('A to B to A does not accept lyrics from the first A request', async () => {
 const slow=deferred<null>();let firstIsCurrent!:()=>boolean;
 lyricLookup.mockImplementationOnce((...args:unknown[])=>{firstIsCurrent=(args[3] as {isCurrent:()=>boolean}).isCurrent;return slow.promise;});
 mount();let first!:Promise<void>;
 await act(async()=>{first=queue.playSong(spotifySong,[spotifySong,spotifyNext]);});
 await vi.waitFor(()=>expect(lyricLookup).toHaveBeenCalledTimes(1));
 await act(async()=>queue.playSong(spotifyNext,[spotifySong,spotifyNext]));
 await act(async()=>queue.playSong(spotifySong,[spotifySong,spotifyNext]));
 expect(firstIsCurrent()).toBe(false);
 await act(async()=>{slow.resolve(null);await first;});
});
