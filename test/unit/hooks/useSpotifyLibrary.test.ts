import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnlineProviderAccountState } from '@/stores/useOnlineProviderAccountStore';
import type { ProviderCollection } from '@/types/onlineMusic';

// test/unit/hooks/useSpotifyLibrary.test.ts
// Drive the real hook with the same small React hook runtime used by the existing hook tests.

const fixture = vi.hoisted(() => ({
    selected: true,
    slots: [] as Array<{ current: unknown }>, cursor: 0,
    account: {} as OnlineProviderAccountState,
    playlists: vi.fn(), liked: vi.fn(), status: vi.fn(), save: vi.fn(), clear: vi.fn(),
}));
vi.mock('@/services/onlineMusic/spotifyActivation', () => ({ spotifyActivation: { selected: () => fixture.selected, subscribe: () => () => {} } }));
vi.mock('react', () => ({
    useRef: (initial: unknown) => { const index = fixture.cursor++; return fixture.slots[index] ??= { current: initial }; },
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: {
    getProviderSummaries: () => [{ providerId: 'spotify', availability: { configured: true } }],
    getLoginStatus: fixture.status, getProviderUserPlaylists: fixture.playlists, getProviderLikedSongIds: fixture.liked,
    getProviderLikedSongs: async () => (await fixture.liked()).map((id: string) => ({ id, name: id, artists: [], album: {} })), logout: vi.fn(),
} }));
vi.mock('@/stores/useOnlineProviderAccountStore', () => {
    const getState = () => ({ accounts: { spotify: fixture.account },
        updateAccount: (_provider: string, patch: Partial<OnlineProviderAccountState>) => Object.assign(fixture.account, patch),
        clearAccount: () => { fixture.account.user = null; fixture.account.collections = []; },
    });
    return { useOnlineProviderAccountStore: Object.assign((selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()), { getState }) };
});
vi.mock('@/services/onlineMusic/providerAccountCache', () => ({
    saveProviderAccountSnapshot: fixture.save, clearProviderAccountSnapshot: fixture.clear, loadProviderAccountSnapshot: async () => null,
}));
vi.mock('@/services/onlineMusic/revokeProviderPlayback', () => ({ revokeProviderPlayback: vi.fn() }));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));

import { useSpotifyLibrary } from '@/hooks/useSpotifyLibrary';

const collection = (index: number): ProviderCollection => ({ providerId: 'spotify', id: String(index), type: 'playlist', name: `Playlist ${index}` });

beforeEach(() => {
    fixture.selected = true;
    fixture.slots = []; fixture.cursor = 0;
    fixture.account = { user: { id: 'user', nickname: 'Listener' }, collections: [collection(-1)], likedSongIds: [], likedSongFileIds: {},
        status: 'authenticated', hydration: 'ready', freshness: 'stale', connectionRevision: 0 };
    fixture.playlists.mockReset(); fixture.status.mockReset().mockResolvedValue(fixture.account.user);
    fixture.liked.mockReset().mockResolvedValue([]);
    fixture.save.mockReset().mockResolvedValue(undefined); fixture.clear.mockReset().mockResolvedValue(undefined);
});

describe('Spotify library completeness through the real refresh hook', () => {
    it('keeps cached library data and does not contact Spotify before explicit selection', async () => {
        fixture.selected = false;
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(false);
        expect(fixture.status).not.toHaveBeenCalled(); expect(fixture.playlists).not.toHaveBeenCalled();
        expect(fixture.account.collections).toHaveLength(1);
    });
    it('refreshes beyond 1000 playlists before publishing a fresh snapshot', async () => {
        fixture.playlists.mockImplementation(async (_provider, _user, { offset, limit }) => ({
            items: Array.from({ length: Math.min(limit, 1050 - offset) }, (_, index) => collection(offset + index)),
            nextOffset: Math.min(1050, offset + limit), total: 1050, hasMore: offset + limit < 1050,
        }));
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(true);
        expect(fixture.account.collections).toHaveLength(1051);
        expect(fixture.account.collections[0]).toMatchObject({ isLiked: true, trackCount: 0 });
        expect(fixture.account.freshness).toBe('fresh');
        expect(fixture.save).toHaveBeenCalledOnce();
        expect(fixture.save.mock.calls[0][1].collections).toHaveLength(1051);
    });

    it('retains its previous snapshot when paging stalls', async () => {
        fixture.playlists.mockResolvedValue({ items: [], nextOffset: 0, hasMore: true });
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(false);
        expect(fixture.account.collections).toEqual([collection(-1)]);
        expect(fixture.account.freshness).toBe('error');
        expect(fixture.save).not.toHaveBeenCalled();
    });

    it('drops an in-flight page when the connection changes', async () => {
        fixture.playlists.mockImplementation(async () => {
            fixture.account.connectionRevision = 1;
            return { items: [collection(1)], nextOffset: 1, hasMore: false };
        });
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(false);
        expect(fixture.account.collections).toEqual([collection(-1)]);
        expect(fixture.save).not.toHaveBeenCalled();
    });

    it('shares one in-flight refresh rather than interleaving separate page walks', async () => {
        let finish!: (page: unknown) => void;
        fixture.playlists.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const hook = useSpotifyLibrary();
        const first = hook.refresh(), second = hook.refresh();
        await Promise.resolve();
        finish({ items: [collection(1)], nextOffset: 1, hasMore: false });
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(fixture.playlists).toHaveBeenCalledOnce();
        expect(fixture.save).toHaveBeenCalledOnce();
    });

    it('adds Liked Songs as an independent collection and saves the actual liked IDs', async () => {
        const liked = Array.from({ length: 60 }, (_, index) => `saved-${index}`);
        fixture.liked.mockResolvedValue(liked);
        fixture.playlists.mockResolvedValue({ items: [collection(1)], nextOffset: 1, hasMore: false });
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(true);
        expect(fixture.account.collections).toHaveLength(2);
        expect(fixture.account.collections[0]).toMatchObject({ id: 'spotify-liked-songs', isLiked: true, trackCount: 60 });
        expect(fixture.account.likedSongIds).toEqual(liked);
        expect(fixture.save.mock.calls[0][1].likedSongIds).toEqual(liked);
    });

    it('keeps usable playlists and previous likes when only saved-tracks access fails', async () => {
        fixture.account.likedSongIds = ['saved-before'];
        fixture.account.collections.unshift({ ...collection(0), isLiked: true, trackCount: 1 });
        fixture.liked.mockRejectedValue(new Error('Saved tracks access denied'));
        fixture.playlists.mockResolvedValue({ items: [collection(1)], nextOffset: 1, hasMore: false });
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(true);
        expect(fixture.account.status).toBe('authenticated');
        expect(fixture.account.freshness).toBe('error');
        expect(fixture.account.error).toBe('Saved tracks access denied');
        expect(fixture.account.collections[1]).toEqual(collection(1));
        expect(fixture.account.collections[0].trackCount).toBe(1);
        expect(fixture.account.likedSongIds).toEqual(['saved-before']);
        expect(fixture.clear).not.toHaveBeenCalled();
    });

    it('does not copy another account’s likes or claim zero tracks after a denied first read', async () => {
        fixture.account.likedSongIds = ['other-account-song'];
        fixture.status.mockResolvedValue({ id: 'new-account', nickname: 'New listener' });
        fixture.liked.mockRejectedValue(new Error('Saved tracks access denied'));
        fixture.playlists.mockResolvedValue({ items: [], nextOffset: 0, hasMore: false });
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(true);
        expect(fixture.account.likedSongIds).toEqual([]);
        expect(fixture.account.collections[0]).toMatchObject({ isLiked: true });
        expect(fixture.account.collections[0].trackCount).toBeUndefined();
    });

    it('discards saved-track results if the connection changes while that read is pending', async () => {
        fixture.playlists.mockResolvedValue({ items: [collection(1)], nextOffset: 1, hasMore: false });
        fixture.liked.mockImplementation(async () => {
            fixture.account.connectionRevision = 1;
            return ['stale-saved-song'];
        });
        await expect(useSpotifyLibrary().refresh()).resolves.toBe(false);
        expect(fixture.account.collections).toEqual([collection(-1)]);
        expect(fixture.account.likedSongIds).toEqual([]);
        expect(fixture.save).not.toHaveBeenCalled();
    });
});

it('a completed like is not overwritten by an older background library refresh',async()=>{
 fixture.playlists.mockResolvedValue({items:[],nextOffset:0,hasMore:false});
 fixture.liked.mockImplementation(async()=>{
  fixture.account.likedSongIds=['newly-liked'];
  fixture.account.collections=[{...collection(0),id:'spotify-liked-songs',isLiked:true,trackCount:1,tracksUpdatedAt:42}];
  return [];
 });
 await expect(useSpotifyLibrary().refresh()).resolves.toBe(true);
 expect(fixture.account.likedSongIds).toEqual(['newly-liked']);
 expect(fixture.account.collections[0]).toMatchObject({trackCount:1,tracksUpdatedAt:42});
 expect(fixture.save.mock.calls[0][1].likedSongIds).toEqual(['newly-liked']);
});
