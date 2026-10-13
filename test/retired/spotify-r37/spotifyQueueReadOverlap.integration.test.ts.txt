// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance as monotonic } from 'node:perf_hooks';

// test/unit/playback/spotifyQueueReadOverlap.integration.test.ts: actual queue/Omni/IPC/source execution with explicit offline native boundaries.
vi.hoisted(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true,
        value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
});
const externalFetch = vi.hoisted(() => {
    const request = vi.fn(async () => { throw new Error('External network is disabled'); });
    vi.stubGlobal('fetch', request); return request;
});
vi.mock('@/utils/lyrics/autoMatchBestLyric', () => ({ autoMatchBestLyric: vi.fn(async () => null) }));
vi.mock('@/services/db', async importOriginal => ({ ...await importOriginal<typeof import('@/services/db')>(), getFromCache: async () => null }));
vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongAudioBlob: async () => null, hasCachedSongAudio: async () => false,
    getCachedSongCoverUrl: async () => null, getSongCacheWithLegacyMigration: async () => null,
}));
vi.mock('@/services/prefetchService', () => ({ getPrefetchedData: () => null, prefetchNearbySongs: () => {},
    invalidateAndRefetch: () => {}, isUrlValid: () => false, updatePrefetchedAudioUrl: () => {} }));
vi.mock('@/services/playbackFade', () => ({ registerPlaybackFadeGraph: () => {}, playbackFade: {
    flush: () => {}, isFadingOut: () => false, prepareFadeIn: () => null, abortFadeIn: () => {},
} }));
const lyricGate = vi.hoisted(() => ({ run: async () => null as unknown }));
vi.mock('@/utils/onlineLyricsState', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/onlineLyricsState')>(), loadOnlineLyricsState: () => lyricGate.run(),
}));
import { usePlaybackQueueController } from '@/hooks/usePlaybackQueueController';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { registerOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';
import { normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';
import { cancelPlaybackSourceRequest } from '@/services/playbackSourceRequest';
import { PlayerState } from '@/types';
import i18n from '@/i18n/config';
import { createSpotifyQueueDriver } from './spotifyQueueDriver';

// Electron main and undici run in Node; retain Node's byte constructor in the mixed DOM test realm.
vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer));
const require = createRequire(import.meta.url);
process.env.FOLIA_SOURCE_TEST_APP ||= process.cwd();
const modelRoot = process.env.FOLIA_QUEUE_MODEL_ROOT || path.resolve('../validation/model');
const rawFailures: any[] = [];
const diagnostics = require(path.join(process.env.FOLIA_SOURCE_TEST_APP, 'electron/spotify/requestDiagnostics.cjs'));
const reportFailure = diagnostics.reportSpotifyPreparationFailure;
diagnostics.reportSpotifyPreparationFailure = (...args: any[]) => { rawFailures.push(args.map(value => value instanceof Error ? { message: value.message, code: (value as any).code, stack: value.stack } : value)); return reportFailure(...args); };
const { buildMain, waitFor, TRACK, OTHER } = require(path.join(modelRoot, 'main-fixture.cjs'));
const { createRenderer } = require(path.join(modelRoot, 'renderer-fixture.cjs'));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const THIRD = '5n5Rram7vgaVa1iaRUc9Lp';
const songFor = (id: string) => normalizeSpotifySong({ id, name: `Synthetic ${id}`, type: 'track' });
const oldSong = songFor(TRACK), nextSong = songFor(OTHER), thirdSong = songFor(THIRD);
const ref = <T,>(current: T) => ({ current });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
let uiDriver: ReturnType<typeof createSpotifyQueueDriver> | undefined;
let root: Root | undefined, main: any, renderer: any, queue: ReturnType<typeof usePlaybackQueueController>, caseName = '';
let timeline: any[] = [], bridge: any[] = [], start = 0, observed: Record<string, unknown> = {};
const releases: Array<() => void> = [];
function event(name: string, fields: Record<string, unknown> = {}) { timeline.push({ name, atMs: monotonic.now(), ...fields }); }
function gate() { const value = deferred(); releases.push(value.resolve); return value; }
function mount() {
    const props = {
        isNowPlayingStageActive: false, shouldNavigateToPlayerOnTrackChange: false,
        localSongs: [], localLibraryCatalog: {}, setLyrics: vi.fn(), setIsLyricsLoading: vi.fn(),
        navigateToPlaybackView: vi.fn(), navigateToSearch: vi.fn(), persistLastPlaybackCache: vi.fn(),
        restoreCachedThemeForSong: vi.fn(), interruptStagePlaybackForMainTransition: vi.fn(),
        onPlayLocalSong: vi.fn(), onPlayNavidromeSong: vi.fn(), onAddLocalSongToQueue: vi.fn(),
        onAddNavidromeSongsToQueue: vi.fn(), searchDeps: { submitSearch: vi.fn(), loadMoreSearchResults: vi.fn() },
        audioRef: ref(renderer.transport.asMediaElement()), blobUrlRef: ref(null), shouldAutoPlayRef: ref(true), currentSongRef: ref(null),
        mainPlaybackSnapshotRef: ref(null), playbackAutoSkipCountRef: ref(0), pendingResumeTimeRef: ref(null),
        currentOnlineAudioUrlFetchedAtRef: ref(null), lastAudioRecoverySourceRef: ref(null),
    } as unknown as Parameters<typeof usePlaybackQueueController>[0];
    function Probe() { queue = usePlaybackQueueController(props); return null; }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(React.createElement(Probe)));
    return props;
}
async function boot(name: string, realVault = false) {
    caseName = name;
    main = await buildMain('asio', { getDelayMs: 2, putDelayMs: 3, pacedPcm: true, fullService: true, realVault });
    renderer = createRenderer(main);
    const oldPrepared = await main.f.prepare(TRACK);
    renderer.transport.setSource(oldPrepared.url); await renderer.transport.play(); main.heard(17);
    usePlaybackStore.setState({ currentSong: oldSong, audioSrc: oldPrepared.url, playQueue: [oldSong, nextSong, thirdSong],
        activePlaybackContext: 'main', playerState: PlayerState.PLAYING, isFmMode: false });
    window.electron = { spotify: { request: async (input: any) => {
        const item = { ...input, startedMs: monotonic.now() }; bridge.push(item); event('spotify-ipc-start', { action: input.action, trackId: input.id });
        try { return await main.f.request(input); } finally { Object.assign(item, { finishedMs: monotonic.now() }); event('spotify-ipc-finish', { action: input.action, trackId: input.id }); }
    }, onProgress: () => () => {} } } as unknown as typeof window.electron;
    mount();
    start = monotonic.now(); event('ready-old-track');
    return oldPrepared;
}
function requests() { return main.f.requests.filter((value: any) => value.startedMs >= start); }
function noNewWrites() {
    expect(requests().filter((value: any) => value.method === 'PUT').every((value: any) => value.operation === 'pause')).toBe(true);
    expect(main.f.publications.filter((value: any) => value.atMs >= start)).toHaveLength(0);
    expect(main.f.controlPreparations).toHaveLength(1);
    expect(main.f.bridge.transcript.filter((value: any) => value.atMs >= start && value.type === 'native-send')
        .some((value: any) => ['acquire', 'rebindPreparedSelection', 'resumePreparation', 'armCaptureInterval'].includes(value.operation))).toBe(false);
}
async function bothReads() {
    await waitFor(() => requests().some((r: any) => r.operation === 'metadata') && requests().some((r: any) => r.operation === 'devices'), 'Both preparation GETs did not dispatch');
    event('both-preparation-gets-observed');
}
async function nextIntent() { event('user-next-intent'); await act(async () => queue.handleNextTrack()); }
async function committed(id: string) { await waitFor(() => usePlaybackStore.getState().currentSong?.id === id && Boolean(usePlaybackStore.getState().audioSrc), 'Queue did not commit selected source'); }
beforeEach(async () => {
    vi.clearAllMocks(); rawFailures.length = 0; timeline = []; bridge = []; observed = {}; lyricGate.run = async () => null;
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    registerOnlineMusicProvider(spotifyProvider); await i18n.changeLanguage('zh-CN');
    useAudioSettingsStore.setState({ audioQuality: 'high', nativeAudioBackend: 'asio', autoPlayOnLaunch: false, enableMediaCache: false, loopMode: 'all' });
    useStatusMessageStore.setState({ message: null });
});
afterEach(async context => {
    for (const release of releases.splice(0)) release();
    if (main) {
        const directory = path.resolve('../validation/evidence'); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `${caseName}.json`), JSON.stringify({ caseName, productionRoot: process.env.FOLIA_SOURCE_TEST_APP, modelRoot, result: context.task.result, startMs: start,
            scope: 'Actual React queue hook, loader, Omni, Spotify provider and IPC adapter, registered main cable IPC/service/runtime, source/setup/controller, NativeAudioTransport/native main/live PCM, managed route and capture cores. Explicit fixtures: HTTP, token data, OS identity/devices, downstream output, lyrics/cache/fade. Incoming PlaybackDeck/autoplay and target PCM are exercised only where observed.productionQueueDeckAutoplay or observed.productionDeckAndAutoplayReachedTarget is true; other cases stop at source commit. Full App and DOM button dispatch are excluded.',
            observed, rawFailures, playReadiness: main.playReadiness, timeline, events: main.f.events, spotifyBridge: bridge, http: requests(), nativeOutputBridge: main.bridge.filter((value: any) => value.atMs >= start),
            publications: (main.f.publications || []).filter((value: any) => value.atMs >= start), preparations: main.f.controlPreparations,
            route: main.f.bridge.transcript.filter((value: any) => value.atMs >= start), capture: main.f.captureBoundary.calls.filter((value: any) => value.atMs >= start),
            captureReplies: main.f.captureBoundary.replies.filter((value: any) => value.atMs >= start), jsArtifacts: main.f.bridge.jsArtifacts,
            desktop: main.f.desktop ? { ...main.f.desktop.model, traffic: main.f.desktop.trafficSince(start), composition: main.f.desktop.inspect(), calls: main.f.desktop.calls.filter((value: any) => value.startedMs >= start), observations: main.f.desktop.observations.filter((value: any) => value.startedMs >= start) } : null,
            nativeArtifacts: main.f.bridge.artifacts, captureArtifacts: main.f.captureBoundary.artifacts, refreshes: main.f.refreshes,
        }, null, 2));
    }
    cancelPlaybackSourceRequest(); uiDriver?.close(); uiDriver = undefined; act(() => root?.unmount()); root = undefined;
    if (main) { renderer?.transport.dispose(); await main.close(); }
    main = renderer = undefined;
    expect(externalFetch).not.toHaveBeenCalled(); vi.restoreAllMocks();
}, 20000);

it('actual Next dispatches both GETs while previous Pause is blocked; lyric state is a separate post-audio barrier', async () => {
    await boot('next-pause-overlap'); const pause = gate(), lyrics = gate(); let pauseEntered = false;
    main.f.hooks.http = async ({ operation }: any) => {
        if (operation === 'pause' && !pauseEntered) { pauseEntered = true; event('old-pause-held'); await pause.promise; event('old-pause-released'); }
    };
    lyricGate.run = async () => { event('lyrics-state-enter'); await lyrics.promise; event('lyrics-state-leave'); return null; };
    await nextIntent(); await bothReads(); await waitFor(() => pauseEntered, 'Old Pause did not dispatch');
    noNewWrites();
    expect(main.bridge.filter((value: any) => value.atMs >= start && value.action === 'stop')).toHaveLength(0);
    expect(main.f.officialMetadata.get(OTHER, main.f.officialMetadata.bind())).toBeNull();
    observed.readsBeforeOldPauseAck = true; observed.noExplicitNativeStopBeforeReads = true; pause.resolve();
    await waitFor(() => timeline.some(value => value.name === 'lyrics-state-enter'), 'Audio never reached lyric state barrier');
    expect(usePlaybackStore.getState().currentSong?.id).toBe(TRACK);
    expect(bridge.some(value => value.action === 'audio' && value.id === OTHER && value.finishedMs)).toBe(true);
    observed.audioResolvedBeforeLyricStateAndQueueCommit = true; lyrics.resolve(); await act(async () => committed(OTHER));
}, 20000);

it('actual Next keeps both reads inert while exact old capture-stop remains pending', async () => {
    await boot('next-capture-stop-overlap'); const stop = gate(); let entered = false;
    main.f.hooks.capture = async (operation: string) => { if (operation === 'capture-stop' && !entered) { entered = true; event('old-capture-stop-held'); await stop.promise; event('old-capture-stop-released'); } };
    await nextIntent(); await bothReads(); await waitFor(() => entered, 'Old capture stop did not dispatch'); noNewWrites();
    observed.readsBeforeOldCaptureStopAck = true; stop.resolve(); await act(async () => committed(OTHER));
}, 20000);

it('failed old native retirement cannot admit speculative metadata or new control', async () => {
    await boot('failed-native-retirement'); const stop = gate(); let entered = false;
    main.f.hooks.native = async (operation: string) => { if (operation === 'suspendPaused') throw Object.assign(new Error('Synthetic old hold failure'), { code: 'ROUTE_PROOF_UNCONFIRMED' }); };
    main.f.hooks.capture = async (operation: string) => { if (operation === 'capture-stop' && !entered) { entered = true; event('old-capture-stop-held'); await stop.promise; event('old-capture-stop-released'); } };
    await nextIntent(); await bothReads(); await waitFor(() => entered, 'Old capture stop did not dispatch'); noNewWrites(); stop.resolve();
    await waitFor(() => bridge.some(value => value.action === 'audio' && value.id === OTHER && value.finishedMs), 'Failed audio did not settle');
    noNewWrites(); expect(main.f.officialMetadata.get(OTHER, main.f.officialMetadata.bind())).toBeNull();
    expect(usePlaybackStore.getState().currentSong?.id).toBe(TRACK); observed.failedRetirementNeverPublished = true;
}, 20000);

it('newer queue selection cancels the first speculative track and only commits the latest track', async () => {
    await boot('newer-selection-cancels'); const pause = gate(); let entered = false;
    main.f.hooks.http = async ({ operation }: any) => { if (operation === 'pause' && !entered) { entered = true; event('old-pause-held'); await pause.promise; event('old-pause-released'); } };
    await nextIntent(); await bothReads(); noNewWrites();
    event('newer-user-selection', { trackId: THIRD }); let pending!: Promise<void>;
    await act(async () => { pending = queue.playSong(thirdSong, [oldSong, nextSong, thirdSong]); });
    await waitFor(() => bridge.some(value => value.action === 'cancelAudio'), 'Superseded audio was not cancelled');
    noNewWrites(); pause.resolve(); await act(async () => pending);
    expect(usePlaybackStore.getState().currentSong?.id).toBe(THIRD);
    expect(main.f.controlPreparations.map((value: any) => value.trackId)).toEqual([TRACK, THIRD]);
    expect(main.f.officialMetadata.get(OTHER, main.f.officialMetadata.bind())).toBeNull(); observed.onlyLatestTrackCommitted = true;
}, 20000);

it('grant changes while old Pause is pending reject both speculative facts before new control', async () => {
    await boot('account-change-cancels'); const pause = gate(); let entered = false;
    main.f.hooks.http = async ({ operation }: any) => { if (operation === 'pause' && !entered) { entered = true; event('old-pause-held'); await pause.promise; } };
    await nextIntent(); await bothReads(); await waitFor(() => entered, 'Old Pause did not dispatch'); noNewWrites();
    main.f.changeGrant(); event('grant-changed'); pause.resolve();
    await waitFor(() => bridge.some(value => value.action === 'audio' && value.id === OTHER && value.finishedMs), 'Invalidated audio did not settle');
    noNewWrites(); expect(usePlaybackStore.getState().currentSong?.id).toBe(TRACK); observed.grantChangeNeverPublished = true;
}, 20000);


it('composed production queue, PlaybackDeck and autoplay reach distinct target PCM on first Play and Next', async () => {
    caseName = 'queue-deck-autoplay-smoke';
    main = await buildMain('asio', { getDelayMs: 2, putDelayMs: 3, pacedPcm: true, fullService: true });
    usePlaybackStore.setState({ currentSong: null, audioSrc: null, playQueue: [oldSong, nextSong],
        activePlaybackContext: 'main', playerState: PlayerState.IDLE, isFmMode: false });
    window.electron = { spotify: { request: (input: any) => main.f.request(input), onProgress: () => () => {} } } as unknown as typeof window.electron;
    uiDriver = createSpotifyQueueDriver(main, { onEvent: event }); start = monotonic.now();
    await uiDriver.select(oldSong, [oldSong, nextSong]);
    await act(async () => waitFor(() => main.output()?.firstTargetConsumedAtMs != null, 'First Play did not reach correct PCM'));
    expect(uiDriver.transport.error).toBeNull(); expect(uiDriver.transport.paused).toBe(false);
    const previous = main.output(); event('old-target-consumed');
    await uiDriver.next();
    await act(async () => waitFor(() => main.output() !== previous && main.output()?.firstTargetConsumedAtMs != null, 'Next did not reach correct PCM'));
    expect(uiDriver.transport.error).toBeNull(); expect(usePlaybackStore.getState().currentSong?.id).toBe(OTHER);
    expect(main.f.state.item.uri).toBe(`spotify:track:${OTHER}`); observed.productionDeckAndAutoplayReachedTarget = true;
}, 30000);


const uiScenarios = process.env.FOLIA_QUEUE_SCENARIO ? [process.env.FOLIA_QUEUE_SCENARIO] : ['warm', 'cold', 'next', 'previous', 'list-wrap'];
it.each(uiScenarios)('controlled UI intent %s uses production queue/deck/autoplay through target PCM', async scenario => {
    const model = process.env.DELAY_MODEL || 'functional';
    caseName = `ui-${scenario}-${model}-${process.env.VARIANT || 'http'}`;
    expect(['warm', 'cold', 'next', 'previous', 'list-wrap']).toContain(scenario);
    main = await buildMain('asio', { cold: scenario === 'cold', getDelayMs: 2, putDelayMs: 3, pacedPcm: true, fullService: true });
    usePlaybackStore.setState({ currentSong: null, audioSrc: null, playQueue: [oldSong, nextSong],
        activePlaybackContext: 'main', playerState: PlayerState.IDLE, isFmMode: false });
    window.electron = { spotify: { request: async (input: any) => {
        const entry = { ...input, startedMs: monotonic.now() }; bridge.push(entry);
        event('spotify-ipc-start', { action: input.action, trackId: input.id });
        try { return await main.f.request(input); } finally { Object.assign(entry, { finishedMs: monotonic.now() }); event('spotify-ipc-finish', { action: input.action, trackId: input.id }); }
    }, onProgress: () => () => {} } } as unknown as typeof window.electron;
    let measureIntent = false;
    uiDriver = createSpotifyQueueDriver(main, { onEvent: (name, data) => { if (measureIntent && name.startsWith('user-')) { start = monotonic.now(); measureIntent = false; } event(name, data); } });
    const previousTrack = ['previous', 'list-wrap'].includes(scenario) ? nextSong : oldSong;
    if (!['warm', 'cold'].includes(scenario)) {
        await uiDriver.select(previousTrack, [oldSong, nextSong]);
        await act(async () => waitFor(() => main.output()?.firstTargetConsumedAtMs != null, 'Previous track did not reach target PCM'));
    }
    const previous = main.output(), oldHttpAt = main.f.requests.length, oldReadyAt = main.playReadiness.length;
    let reference: unknown = { model: 'functional', getDelayMs: 2, putDelayMs: 3 };
    if (model !== 'functional') {
        const { chooseDelays } = require(path.join(modelRoot, 'delay-model.cjs'));
        reference = chooseDelays(main.f, ['next', 'previous', 'list-wrap'].includes(scenario) ? 'next' : scenario);
    }
    measureIntent = true;
    if (scenario === 'next' || scenario === 'list-wrap') await uiDriver.next();
    else if (scenario === 'previous') await uiDriver.previous();
    else await uiDriver.select(oldSong, [oldSong, nextSong]);
    await act(async () => waitFor(() => main.output() !== previous && main.output()?.firstTargetConsumedAtMs != null, 'Selected UI intent did not reach target PCM', 45000));
    const output = main.output(), target = scenario === 'next' ? OTHER : TRACK;
    expect(uiDriver.transport.error).toBeNull(); expect(uiDriver.transport.paused).toBe(false);
    expect(usePlaybackStore.getState().currentSong?.id).toBe(target);
    expect(main.f.state.item.uri).toBe(`spotify:track:${target}`);
    expect([...output.byteValues].every(value => value === 0 || value === output.targetMarker)).toBe(true);
    expect(main.playReadiness.length).toBeGreaterThan(oldReadyAt);
    expect(main.playReadiness.at(-1).bufferedMs).toBeGreaterThanOrEqual(350);
    expect(main.f.requests.slice(oldHttpAt).some((value: any) => value.url.includes('/volume'))).toBe(false);
    const requests = main.f.requests.slice(oldHttpAt);
    observed = { scenario, model, reference, actualUserIntentEntry: true, productionQueueDeckAutoplay: true,
        firstTargetPcmConsumedMs: output.firstTargetConsumedAtMs - start,
        outputPlayAckMs: main.playReadiness.at(-1).atMs - start,
        firstTargetPcmReceivedMs: output.firstTargetReceivedAtMs - start,
        targetMarker: output.targetMarker, targetMarkerFrameOffset: output.firstTargetByteOffset / 8,
        gets: requests.filter((value: any) => value.method === 'GET').length,
        puts: requests.filter((value: any) => value.method === 'PUT').length,
        defaultPrebufferMs: 350, localCacheFixture: 'misses resolve asynchronously without injected disk delay',
        lyricsFixture: 'no stored state, no matching request; real hook waits and changes loading state',
        excluded: 'DOM button event dispatch, full App/automix, real IndexedDB disk, real Spotify/network, real Windows/DAC',
        interpretation: model === 'functional' ? 'functionality only; elapsed times are diagnostics' : 'controlled intent-to-target-PCM model; no physical latency or real-user timing claim',
        loopMeaning: scenario === 'list-wrap' ? 'actual queue loop-all wrap' : null };
}, 60000);

it('metadata errors during old retirement never create a new controller or publish speculative facts', async () => {
    await boot('metadata-error-inert'); const pause = gate(); let entered = false;
    main.f.hooks.http = async ({ operation }: any) => {
        if (operation === 'metadata') { event('metadata-refused'); return { status: 403, body: {} }; }
        if (operation === 'pause' && !entered) { entered = true; event('old-pause-held'); await pause.promise; event('old-pause-released'); }
    };
    await nextIntent(); await bothReads(); await waitFor(() => entered, 'Old Pause did not dispatch'); noNewWrites(); pause.resolve();
    await waitFor(() => bridge.some(value => value.action === 'audio' && value.id === OTHER && value.finishedMs), 'Metadata failure did not settle');
    noNewWrites(); expect(usePlaybackStore.getState().currentSong?.id).toBe(TRACK);
    expect(main.f.officialMetadata.get(OTHER, main.f.officialMetadata.bind())).toBeNull(); observed.failedReadNeverPublished = true;
}, 20000);

it('cancelling the queue request during old retirement never admits either speculative read', async () => {
    await boot('queue-cancel-inert'); const pause = gate(); let entered = false;
    main.f.hooks.http = async ({ operation }: any) => { if (operation === 'pause' && !entered) { entered = true; event('old-pause-held'); await pause.promise; event('old-pause-released'); } };
    await nextIntent(); await bothReads(); noNewWrites();
    act(() => cancelPlaybackSourceRequest()); event('user-cancel-intent');
    await waitFor(() => bridge.some(value => value.action === 'cancelAudio'), 'Cancel did not reach provider IPC'); pause.resolve();
    await waitFor(() => bridge.some(value => value.action === 'audio' && value.id === OTHER && value.finishedMs), 'Cancelled audio did not settle');
    noNewWrites(); expect(main.f.officialMetadata.get(OTHER, main.f.officialMetadata.bind())).toBeNull(); observed.cancelNeverPublished = true;
}, 20000);

it('a real vault expiry discards early reads and refreshes only after old route retirement settles', async () => {
    await boot('token-expiry-after-barrier', true); const hold = gate(); let entered = false;
    main.f.hooks.native = async (operation: string) => { if (operation === 'suspendPaused' && !entered) { entered = true; event('old-native-hold-pending'); await hold.promise; event('old-native-hold-released'); } };
    await nextIntent(); await bothReads(); await waitFor(() => entered, 'Old native hold did not start'); noNewWrites();
    expect(main.f.refreshes).toHaveLength(0); main.f.advanceVault(61000); event('token-now-in-no-refresh-window'); hold.resolve();
    await act(async () => committed(OTHER));
    expect(main.f.refreshes).toHaveLength(1);
    const retired = main.f.bridge.transcript.find((value: any) => value.atMs >= start && value.type === 'native-result' && value.operation === 'suspendPaused');
    expect(main.f.refreshes[0].atMs).toBeGreaterThanOrEqual(retired.atMs);
    observed.realVaultFallbackAfterExactRetirement = true; observed.liveAccountRequests = 0;
}, 20000);
