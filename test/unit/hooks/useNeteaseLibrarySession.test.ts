// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNeteaseLibrary } from '@/hooks/useNeteaseLibrary';
import { waitForNeteaseCacheWrites } from '@/hooks/neteaseLibrarySession';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import { OnlineProviderError, type ProviderUser } from '@/types/onlineMusic';

// Deferred responses exercise real hook lifetime, logout, QR-session and cache-write races.
const mocks = vi.hoisted(() => ({ login: vi.fn(), playlists: vi.fn(), cloud: vi.fn(), liked: vi.fn(), logout: vi.fn(),
    load: vi.fn(), save: vi.fn(), clear: vi.fn(), removeCache: vi.fn(), legacy: vi.fn(), status: vi.fn() }));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: {
    getLoginStatus: mocks.login, getProviderUserPlaylists: mocks.playlists, getProviderCloudCollection: mocks.cloud,
    getProviderLikedSongIds: mocks.liked, logout: mocks.logout, getProviderSummaries: () => [],
    normalizeCachedUser: (_provider: string, raw: unknown) => raw,
    normalizeCachedCollection: (_provider: string, raw: unknown) => raw,
} }));
vi.mock('@/services/db', () => ({ clearCache: vi.fn(), getCacheKeysByPrefix: vi.fn().mockResolvedValue([]),
    getCacheUsage: vi.fn().mockResolvedValue(0), removeCacheEntries: mocks.removeCache, getFromCache: vi.fn(), saveToCache: vi.fn() }));
vi.mock('@/services/onlineMusic/providerStorage', async importOriginal => ({ ...(await importOriginal<object>()), getProviderCacheWithLegacyMigration: mocks.legacy }));
vi.mock('@/services/onlineMusic/providerAccountCache', () => ({ clearProviderAccountSnapshot: mocks.clear,
    loadProviderAccountSnapshot: mocks.load, saveProviderAccountSnapshot: mocks.save,
    getProviderAccountSnapshotCacheKey: () => 'snapshot' }));
vi.mock('@/stores/useStatusMessageStore', () => ({ setStatusMessage: mocks.status }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = 'online_provider:netease:cookie';
const oldUser: ProviderUser = { id: 1, nickname: 'Old' }, newUser: ProviderUser = { id: 2, nickname: 'New' };
const t = (key: string) => key;
let root: Root | undefined, current: ReturnType<typeof useNeteaseLibrary>, diskUser: ProviderUser | null;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { await act(async () => { for (let step = 0; step < 18; step++) await Promise.resolve(); }); };
async function mount(strict = false) {
    function Probe() { current = useNeteaseLibrary({ t }); return null; }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe)) : React.createElement(Probe)));
    await flush();
}
const account = () => useOnlineProviderAccountStore.getState().accounts.netease;
beforeEach(async () => {
    await waitForNeteaseCacheWrites(); vi.resetAllMocks(); localStorage.clear(); localStorage.setItem(key, 'old-session');
    useOnlineProviderAccountStore.setState({ accounts: {} }); diskUser = oldUser;
    mocks.load.mockResolvedValue({ version: 1, savedAt: 1, user: oldUser, collections: [], likedSongIds: [] });
    mocks.login.mockResolvedValue(oldUser); mocks.playlists.mockResolvedValue({ items: [], hasMore: false, nextOffset: 0 });
    mocks.cloud.mockResolvedValue(null); mocks.liked.mockResolvedValue([]); mocks.logout.mockResolvedValue(undefined);
    mocks.legacy.mockResolvedValue(null); mocks.removeCache.mockResolvedValue(undefined);
    mocks.save.mockImplementation(async (_provider, snapshot) => { diskUser = snapshot.user; return { ...snapshot, version: 1, savedAt: 2 }; });
    mocks.clear.mockImplementation(async () => { diskUser = null; });
});
afterEach(async () => { act(() => root?.unmount()); root = undefined; await waitForNeteaseCacheWrites(); });
describe('NetEase library request ownership', () => {
    it.each([new OnlineProviderError('unavailable', 'temporary', 'netease'), new Error('NETEASE_AUTH_EXPIRED')])('retains the account and cookie on unverified errors (%s)', async error => {
        await mount(); mocks.login.mockRejectedValueOnce(error);
        await act(async () => { expect(await current.refreshUserData()).toBe(false); });
        expect(account()).toMatchObject({ status: 'authenticated', user: oldUser, freshness: 'error' });
        expect(current.user).toEqual(oldUser); expect(localStorage.getItem(key)).toBe('old-session'); expect(mocks.clear).not.toHaveBeenCalled();
    });
    it('clears only a current explicit authentication rejection', async () => {
        await mount(); mocks.login.mockResolvedValueOnce(null);
        await act(async () => { expect(await current.refreshUserData()).toBe(false); });
        expect(account()).toMatchObject({ status: 'anonymous', user: null }); expect(current.user).toBeNull();
        expect(localStorage.getItem(key)).toBeNull(); expect(diskUser).toBeNull();
        expect(mocks.removeCache).toHaveBeenCalledWith(expect.arrayContaining(['user_profile', 'user_playlists', 'user_liked_songs', 'user_cloud_playlist']));
    });
    it('handles explicit expiry from a liked-songs request instead of silently saving it', async () => {
        await mount(); mocks.save.mockClear(); mocks.liked.mockRejectedValueOnce(new OnlineProviderError('auth-required', 'Rejected', 'netease'));
        await act(async () => { await current.refreshUserData(); });
        expect(account().user).toBeNull(); expect(mocks.save).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBeNull();
    });
    it('ignores a late null from an earlier refresh after successful new login', async () => {
        await mount(); const old = deferred<ProviderUser | null>(); mocks.login.mockReturnValueOnce(old.promise);
        let first!: Promise<boolean>; act(() => { first = current.refreshUserData(); }); await flush();
        localStorage.setItem(key, 'new-session'); mocks.login.mockResolvedValueOnce(newUser);
        await act(async () => { expect(await current.refreshUserData()).toBe(true); });
        await act(async () => { old.resolve(null); expect(await first).toBe(false); });
        expect(account().user).toEqual(newUser); expect(current.user).toEqual(newUser); expect(diskUser).toEqual(newUser);
        expect(localStorage.getItem(key)).toBe('new-session'); expect(mocks.clear).not.toHaveBeenCalled();
    });
    it('ignores a changed cookie even before the new login starts its refresh', async () => {
        await mount(); const old = deferred<ProviderUser | null>(); mocks.login.mockReturnValueOnce(old.promise);
        let first!: Promise<boolean>; act(() => { first = current.refreshUserData(); });
        localStorage.setItem(key, 'new-session');
        await act(async () => { old.resolve(null); expect(await first).toBe(false); });
        expect(localStorage.getItem(key)).toBe('new-session'); expect(account().user).toEqual(oldUser); expect(mocks.clear).not.toHaveBeenCalled();
    });
    it('makes logout immediate and never restores a late successful refresh', async () => {
        await mount(); const old = deferred<ProviderUser | null>(), logout = deferred<void>();
        mocks.login.mockReturnValueOnce(old.promise); mocks.logout.mockReturnValueOnce(logout.promise);
        let refresh!: Promise<boolean>, stopping!: Promise<void>;
        act(() => { refresh = current.refreshUserData(); stopping = current.handleLogout(); });
        expect(current.user).toBeNull(); expect(account().user).toBeNull(); expect(localStorage.getItem(key)).toBeNull();
        await act(async () => { old.resolve(oldUser); logout.resolve(); await Promise.all([refresh, stopping]); });
        expect(account().user).toBeNull(); expect(diskUser).toBeNull();
    });
    it('cannot late-clear a new login when an old logout completes', async () => {
        await mount(); const logout = deferred<void>(); mocks.logout.mockReturnValueOnce(logout.promise);
        let stopping!: Promise<void>; act(() => { stopping = current.handleLogout(); });
        localStorage.setItem(key, 'new-session'); mocks.login.mockResolvedValueOnce(newUser);
        await act(async () => { expect(await current.refreshUserData()).toBe(true); });
        await act(async () => { logout.resolve(); await stopping; });
        expect(current.user).toEqual(newUser); expect(account().user).toEqual(newUser); expect(diskUser).toEqual(newUser);
        expect(localStorage.getItem(key)).toBe('new-session'); expect(mocks.status).not.toHaveBeenCalled();
    });
    it('orders logout cache deletion after an already-started old snapshot save', async () => {
        await mount(); const saving = deferred<void>();
        mocks.save.mockImplementationOnce(async (_provider, snapshot) => { await saving.promise; diskUser = snapshot.user; return { ...snapshot, savedAt: 3 }; });
        let refresh!: Promise<boolean>, stopping!: Promise<void>;
        act(() => { refresh = current.refreshUserData(); }); await flush();
        act(() => { stopping = current.handleLogout(); }); expect(account().user).toBeNull();
        await act(async () => { saving.resolve(); await Promise.all([refresh, stopping]); });
        expect(diskUser).toBeNull(); expect(account().user).toBeNull();
    });
    it('discards an old cache hydration after a new login refresh', async () => {
        const cached = deferred<any>(); mocks.load.mockReturnValueOnce(cached.promise); await mount();
        localStorage.setItem(key, 'new-session'); mocks.login.mockResolvedValueOnce(newUser);
        await act(async () => { await current.refreshUserData(); });
        await act(async () => { cached.resolve({ version: 1, savedAt: 1, user: oldUser, collections: [], likedSongIds: [] }); });
        expect(account().user).toEqual(newUser); expect(current.user).toEqual(newUser); expect(diskUser).toEqual(newUser);
    });
    it('does not write or clear after its hook lifetime ends', async () => {
        await mount(); const old = deferred<ProviderUser | null>(); mocks.login.mockReturnValueOnce(old.promise);
        let first!: Promise<boolean>; act(() => { first = current.refreshUserData(); });
        mocks.save.mockClear(); act(() => root!.unmount()); root = undefined;
        old.resolve(null); expect(await first).toBe(false);
        expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe('old-session');
    });
    it('hydrates and refreshes normally under StrictMode lifetime replacement', async () => {
        await mount(true); expect(current.isUserDataReady).toBe(true); expect(current.user).toEqual(oldUser);
        expect(account()).toMatchObject({ status: 'authenticated', freshness: 'fresh', user: oldUser });
    });
    it('refuses to fetch library data for an identity other than the validated account', async () => {
        await mount(); mocks.playlists.mockClear(); mocks.login.mockResolvedValueOnce(newUser);
        await act(async () => { expect(await current.refreshUserData(1)).toBe(false); });
        expect(mocks.playlists).not.toHaveBeenCalled(); expect(account()).toMatchObject({ user: oldUser, freshness: 'error' });
        expect(localStorage.getItem(key)).toBe('old-session');
    });
});
