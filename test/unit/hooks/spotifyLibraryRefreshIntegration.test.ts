// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSpotifyLibrary } from '@/hooks/useSpotifyLibrary';
import { useHomeProviderRefresh } from '@/hooks/useHomeProviderRefresh';
import type { OnlineProviderPlatformState } from '@/hooks/useOnlineProviderPlatform';
import { omni } from '@/services/onlineMusic/omni';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';
import { registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import type { ProviderAccountSnapshot } from '@/services/onlineMusic/providerAccountCache';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import { useAppViewStore } from '@/stores/useAppViewStore';
import { useCollectionNavigationStore } from '@/stores/useCollectionNavigationStore';

// Exercise React effects, the real Omni/provider/normalizer and the real account store together.
// Only the desktop bridge and disk are fixtures; no network, credentials or browser is involved.
const fixture = vi.hoisted(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true,
        value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    return { request: vi.fn(), load: vi.fn(), save: vi.fn(), clear: vi.fn() };
});
vi.mock('@/services/onlineMusic/providerAccountCache', () => ({
    loadProviderAccountSnapshot: fixture.load, saveProviderAccountSnapshot: fixture.save,
    clearProviderAccountSnapshot: fixture.clear,
}));
vi.mock('@/services/onlineMusic/revokeProviderPlayback', () => ({ revokeProviderPlayback: vi.fn() }));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = { id: 'listener', nickname: 'Listener' };
const rawPlaylist = { id: '0123456789012345678901', name: 'Owned playlist', type: 'playlist', tracks: { total: 3 } };
const rawSong = (index: number) => ({ id: String(index).padStart(22, '0'), name: `Saved ${index}`, type: 'track', artists: [], album: {} });
const playlistPage = () => ({ items: [rawPlaylist], total: 1, next: null });
const deferred = <T,>() => { let resolve!: (value: T) => void;
    return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; };
const account = () => useOnlineProviderAccountStore.getState().accounts.spotify;
const refreshPlaylists = () => omni.refreshProviderPlaylists('spotify');
const noCheck = async () => null;
const flush = async () => { await act(async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); }); };
let root: Root | undefined, host: HTMLDivElement, current: ReturnType<typeof useSpotifyLibrary>;
let persisted: Omit<ProviderAccountSnapshot, 'version' | 'savedAt'> | null;

async function mount(strict = false) {
    function Probe() {
        current = useSpotifyLibrary();
        useOnlineProviderAccountStore(state => state.accounts.spotify);
        const activeProvider = omni.getProviderSummaries().find(provider => provider.providerId === 'spotify');
        const platform = { activeProviderId: 'spotify', activeProvider } as OnlineProviderPlatformState;
        useHomeProviderRefresh({ onlineProviderPlatform: platform,
            refreshActiveProviderPlaylists: refreshPlaylists, checkKugouLoginStatus: noCheck });
        return React.createElement('div', null, account()?.collections.map(collection =>
            React.createElement('span', { key: collection.id, 'data-collection': collection.id }, `${collection.name}:${collection.trackCount}`)));
    }
    host = document.createElement('div'); root = createRoot(host);
    act(() => root!.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe)) : React.createElement(Probe)));
    await flush();
}

beforeEach(() => {
    vi.resetAllMocks(); persisted = null;
    useOnlineProviderAccountStore.setState({ accounts: {}, activeProviderId: 'spotify' });
    useAppViewStore.setState({ view: 'player' }); useCollectionNavigationStore.getState().clear();
    Object.defineProperty(window, 'electron', { configurable: true, value: { spotify: { request: fixture.request } } });
    registerOnlineMusicProvider(spotifyProvider);
    fixture.load.mockResolvedValue(null); fixture.clear.mockImplementation(async () => { persisted = null; });
    fixture.save.mockImplementation(async (_provider, snapshot) => { persisted = snapshot; return { ...snapshot, version: 1, savedAt: 2 }; });
    fixture.request.mockImplementation(async ({ action, offset = 0, limit = 50 }) => {
        if (action === 'status') return { id: user.id, display_name: user.nickname };
        if (action === 'playlists') return playlistPage();
        if (action === 'savedTracks') return { items: Array.from({ length: Math.min(limit, 59 - offset) }, (_, index) => ({ track: rawSong(offset + index) })),
            total: 59, next: offset + limit < 59 ? 'next' : null };
        if (action === 'logout') return null;
        throw new Error(`Unexpected fixture request: ${action}`);
    });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; unregisterOnlineMusicProvider('spotify'); });

describe('Spotify library survives home refresh and late responses', () => {
    it.each([false, true])('keeps Liked Songs in the rendered home and disk after the second playlist request (StrictMode=%s)', async strict => {
        await mount(strict);
        expect(account().collections[0]).toMatchObject({ id: 'spotify-liked-songs', trackCount: 59 });
        expect(host.querySelector('[data-collection="spotify-liked-songs"]')?.textContent).toContain(':59');
        act(() => useAppViewStore.getState().setView('home')); await flush();
        expect(fixture.request.mock.calls.filter(([request]) => request.action === 'playlists')).toHaveLength(2);
        expect(account().collections.map(collection => collection.id)).toEqual(['spotify-liked-songs', rawPlaylist.id]);
        expect(host.querySelector('[data-collection="spotify-liked-songs"]')).not.toBeNull();
        expect(persisted?.collections[0]).toMatchObject({ id: 'spotify-liked-songs', trackCount: 59 });
        expect(persisted?.likedSongIds).toHaveLength(59);
    });

    it('merges a late playlist page with the latest liked collection rather than its request-start snapshot', async () => {
        const cache = deferred<null>(), page = deferred<ReturnType<typeof playlistPage>>();
        fixture.load.mockReturnValueOnce(cache.promise);
        useOnlineProviderAccountStore.getState().updateAccount('spotify', { user, collections: [], hydration: 'ready', status: 'authenticated' });
        await mount();
        fixture.request.mockImplementationOnce(() => page.promise);
        let refreshing!: Promise<unknown>; act(() => { refreshing = refreshPlaylists(); });
        await act(async () => { expect(await current.refresh()).toBe(true); });
        expect(account().collections[0].isLiked).toBe(true);
        await act(async () => { page.resolve(playlistPage()); await refreshing; });
        expect(account().collections[0]).toMatchObject({ id: 'spotify-liked-songs', trackCount: 59 });
        expect(persisted?.likedSongIds).toHaveLength(59);
        await act(async () => { cache.resolve(null); });
    });

    it('never hydrates an old snapshot over a completed fresh refresh', async () => {
        const cache = deferred<ProviderAccountSnapshot>(); fixture.load.mockReturnValueOnce(cache.promise);
        await mount(); await act(async () => { expect(await current.refresh()).toBe(true); });
        const observed: string[][] = [];
        const unsubscribe = useOnlineProviderAccountStore.subscribe(state => {
            observed.push(state.accounts.spotify.collections.map(collection => String(collection.id)));
        });
        await act(async () => { cache.resolve({ version: 1, savedAt: 1, user, collections: [], likedSongIds: [] }); });
        await flush(); unsubscribe();
        expect(observed.every(ids => ids.includes('spotify-liked-songs'))).toBe(true);
        expect(account().likedSongIds).toHaveLength(59);
    });

    it('does not restore a late shared refresh after logout', async () => {
        await mount(); const page = deferred<ReturnType<typeof playlistPage>>();
        fixture.request.mockImplementationOnce(() => page.promise);
        let refreshing!: Promise<unknown>; act(() => { refreshing = refreshPlaylists(); });
        await act(async () => { await current.logout(); }); fixture.save.mockClear();
        await act(async () => { page.resolve(playlistPage()); await refreshing; });
        expect(account()).toMatchObject({ user: null, collections: [], status: 'anonymous' });
        expect(fixture.save).not.toHaveBeenCalled(); expect(persisted).toBeNull();
    });
});

describe('passive Spotify library provenance', () => {
    it('observes cache hydration and replacement through the actual hook without an additional Spotify request', async () => {
        const record = vi.fn();
        Object.assign(window.electron!, { privatePreview: true, privateDiagnostics: { record } });
        const cachedId = '9999999999999999999999';
        fixture.load.mockResolvedValue({ version: 1, savedAt: 1, user,
            collections: [{ id: cachedId, providerId: 'spotify', type: 'playlist', name: 'PRIVATE_CACHE_TITLE', metadataSource: 'spotify-public-embed' }],
            likedSongIds: [] });
        await mount();
        expect(fixture.request.mock.calls.map(([request]) => request.action)).toEqual(['status', 'playlists', 'savedTracks', 'savedTracks']);
        expect(account().collections.map(collection => collection.id)).toEqual(['spotify-liked-songs', rawPlaylist.id]);
        const fields = record.mock.calls.map(([event]) => event.fields);
        expect(fields).toContainEqual(expect.objectContaining({ phase: 'hydrate', source: 'cache', ok: true, afterCount: 1 }));
        expect(fields).toContainEqual(expect.objectContaining({ phase: 'cache-before', playlistId: cachedId, source: 'public', reason: 'removed' }));
        expect(fields).toContainEqual(expect.objectContaining({ phase: 'cache-replace', publicBeforeCount: 1, publicAfterCount: 0, removedCount: 1 }));
        expect(fields).toContainEqual(expect.objectContaining({ phase: 'refresh-result', ok: true, accountChanged: false }));
        // IDs are local main-IPC correlation inputs; no title, username, account ID or exception message is sent.
        expect(JSON.stringify(fields)).not.toMatch(/PRIVATE_CACHE_TITLE|listener|nickname|display_name|https?:/);
    });
});
