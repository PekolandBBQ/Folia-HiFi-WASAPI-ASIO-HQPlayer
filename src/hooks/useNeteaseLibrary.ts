import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
    clearCache,
    getCacheKeysByPrefix,
    getCacheUsage,
    removeCacheEntries,
} from '../services/db';
import {
    getProviderCacheKey,
    getProviderCacheWithLegacyMigration,
    removeProviderSessionValue,
} from '../services/onlineMusic/providerStorage';
import { OnlineProviderError, type MediaId, type ProviderCollection, type ProviderUser } from '../types/onlineMusic';
import { StatusMessage } from '../types';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { omni } from '../services/onlineMusic/omni';
import {
    clearProviderAccountSnapshot,
    getProviderAccountSnapshotCacheKey,
    loadProviderAccountSnapshot,
    saveProviderAccountSnapshot,
} from '../services/onlineMusic/providerAccountCache';
import { setStatusMessage as setStatusMsg } from '../stores/useStatusMessageStore';
import { isAuthRequiredFailure } from '../services/onlineMusic/loginStatusFailure';
import { enqueueNeteaseCacheWrite, readNeteaseSession, useNeteaseLibrarySession, waitForNeteaseCacheWrites, type NeteaseRequestFence } from './neteaseLibrarySession';

type StatusSetter = Dispatch<SetStateAction<StatusMessage | null>>;

const NETEASE_USER_CACHE_KEYS = {
    profile: getProviderCacheKey('netease', 'user_profile'),
    playlists: getProviderCacheKey('netease', 'user_playlists'),
    likedSongs: getProviderCacheKey('netease', 'user_liked_songs'),
    cloudPlaylist: getProviderCacheKey('netease', 'user_cloud_playlist'),
};

const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const getAllUserPlaylists = async (userId: MediaId, active: () => boolean): Promise<ProviderCollection[]> => {
    const allPlaylists: ProviderCollection[] = [];
    let offset = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore && active()) {
        const page = await omni.getProviderUserPlaylists('netease', userId, { limit, offset });
        if (!active()) return [];
        allPlaylists.push(...page.items);
        hasMore = page.hasMore && page.nextOffset > offset;
        offset = page.nextOffset;
    }

    return allPlaylists;
};

const getUserCloudPlaylist = async (user: ProviderUser, t: (key: string) => string): Promise<ProviderCollection | null> => {
    const collection = await omni.getProviderCloudCollection('netease', user);
    return collection ? {
        ...collection,
        name: t('navidrome.cloudDrive'),
        description: t('navidrome.cloudDriveDesc'),
    } : null;
};

export function useNeteaseLibrary({
    t,
}: {
    t: (key: string) => string;
}) {
    const [user, setUser] = useState<ProviderUser | null>(null);
    const [playlists, setPlaylists] = useState<ProviderCollection[]>([]);
    const [cloudPlaylist, setCloudPlaylist] = useState<ProviderCollection | null>(null);
    const [likedSongIds, setLikedSongIds] = useState<Set<MediaId>>(new Set());
    const [isSyncing, setIsSyncing] = useState(false);
    const [cacheSize, setCacheSize] = useState<string>('0 B');
    const [isUserDataReady, setIsUserDataReady] = useState(false);
    const lastRefreshAuthExpiredRef = useRef(false);
    const initialBackgroundRefreshStartedRef = useRef(false);
    const { beginRequest, captureRequest, isAlive } = useNeteaseLibrarySession();
    const updateProviderAccount = useOnlineProviderAccountStore(state => state.updateAccount);
    const clearProviderAccount = useOnlineProviderAccountStore(state => state.clearAccount);

    const clearAuthState = useCallback(async (fence: NeteaseRequestFence) => {
        if (!fence.active()) return;
        removeProviderSessionValue('netease', 'cookie', ['netease_cookie']);
        setUser(null);
        setPlaylists([]);
        setCloudPlaylist(null);
        setLikedSongIds(new Set());
        clearProviderAccount('netease');
        setIsUserDataReady(true);
        setIsSyncing(false);

        try {
            // Enqueue synchronously after an authorized clear; every newer snapshot writes after it.
            await enqueueNeteaseCacheWrite(() => Promise.all([
                removeCacheEntries([...Object.values(NETEASE_USER_CACHE_KEYS), 'user_profile', 'user_playlists', 'user_liked_songs', 'user_cloud_playlist']),
                clearProviderAccountSnapshot('netease'),
            ]));
        } catch (error) {
            console.warn('Failed to clear auth cache', error);
        }
    }, [clearProviderAccount]);

    useEffect(() => {
        if (isUserDataReady && user && String(useOnlineProviderAccountStore.getState().accounts.netease?.user?.id) === String(user.id)) {
            updateProviderAccount('netease', { likedSongIds: Array.from(likedSongIds) });
        }
    }, [isUserDataReady, likedSongIds, updateProviderAccount, user]);

    const updateCacheSize = useCallback(async () => {
        const size = await getCacheUsage();
        if (isAlive()) setCacheSize(formatBytes(size));
    }, [isAlive]);

    const refreshUserData = useCallback(async (uid?: MediaId) => {
        const fence = beginRequest();
        if (!fence.active()) return false;
        lastRefreshAuthExpiredRef.current = false;
        const retainedAccount = useOnlineProviderAccountStore.getState().accounts.netease;
        updateProviderAccount('netease', {
            status: retainedAccount?.user ? 'authenticated' : 'unknown',
            hydration: retainedAccount?.user ? 'ready' : 'loading',
            freshness: 'refreshing',
            error: undefined,
        });
        try {
            const profile = await omni.getLoginStatus('netease');
            if (!fence.active()) return false;
            if (profile) {
                if (uid != null && String(uid) !== String(profile.id)) {
                    throw new OnlineProviderError('unavailable', 'NetEase account changed before library refresh', 'netease');
                }
                const targetUid = profile.id;
                const allPlaylists = await getAllUserPlaylists(targetUid, fence.active);
                if (!fence.active()) return false;
                const sameAccount = String(retainedAccount?.user?.id) === String(profile.id);
                let nextCloudPlaylist = sameAccount ? retainedAccount?.collections.find(collection => collection.type === 'cloud') || null : null;
                let nextLikedSongIds = sameAccount ? retainedAccount?.likedSongIds || [] : [];

                try {
                    nextCloudPlaylist = await getUserCloudPlaylist(profile, t);
                } catch (error) {
                    if (isAuthRequiredFailure(error)) throw error;
                    console.warn('Failed to fetch user cloud playlist', error);
                }
                if (!fence.active()) return false;

                try {
                    const ids = await omni.getProviderLikedSongIds('netease', targetUid);
                    if (ids) {
                        nextLikedSongIds = ids;
                    }
                } catch (error) {
                    if (isAuthRequiredFailure(error)) throw error;
                    console.warn('Failed to fetch liked songs', error);
                }
                if (!fence.active()) return false;

                const collections = [...allPlaylists, ...(nextCloudPlaylist ? [nextCloudPlaylist] : [])];
                const snapshot = await enqueueNeteaseCacheWrite(() => fence.active() ? saveProviderAccountSnapshot('netease', {
                    user: profile,
                    collections,
                    likedSongIds: nextLikedSongIds,
                }) : Promise.resolve(null));
                if (!fence.active() || !snapshot) return false;
                setUser(profile);
                setPlaylists(allPlaylists);
                setCloudPlaylist(nextCloudPlaylist);
                setLikedSongIds(new Set(nextLikedSongIds));
                updateProviderAccount('netease', {
                    status: 'authenticated',
                    user: profile,
                    collections,
                    likedSongIds: nextLikedSongIds,
                    hydration: 'ready',
                    freshness: 'fresh',
                    lastUpdatedAt: snapshot.savedAt,
                    error: undefined,
                });

                return true;
            }

            lastRefreshAuthExpiredRef.current = true;
            await clearAuthState(fence);
        } catch (error) {
            if (!fence.active()) return false;
            if (isAuthRequiredFailure(error)) {
                lastRefreshAuthExpiredRef.current = true;
                await clearAuthState(fence);
            } else {
                const cachedAccount = useOnlineProviderAccountStore.getState().accounts.netease;
                updateProviderAccount('netease', {
                    status: cachedAccount?.user ? 'authenticated' : 'error',
                    hydration: 'ready',
                    freshness: 'error',
                    error: error instanceof Error ? error.message : 'netease_refresh_failed',
                });
            }
        } finally {
            if (fence.current()) { setIsUserDataReady(true); setIsSyncing(false); }
        }
        return false;
    }, [beginRequest, clearAuthState, t, updateProviderAccount]);

    const loadUserData = useCallback(async () => {
        const fence = beginRequest();
        try {
            await waitForNeteaseCacheWrites();
            if (!fence.active()) return;
            const snapshot = await loadProviderAccountSnapshot('netease');
            if (!fence.active()) return;
            const cachedUserRaw = snapshot?.user
                ?? await enqueueNeteaseCacheWrite(() => fence.active() ? getProviderCacheWithLegacyMigration<unknown>('netease', 'user_profile', ['user_profile']) : Promise.resolve(null));
            if (!fence.active()) return;
            const cachedPlaylistsRaw = snapshot?.collections.filter(collection => collection.type === 'playlist')
                ?? await enqueueNeteaseCacheWrite(() => fence.active() ? getProviderCacheWithLegacyMigration<unknown>('netease', 'user_playlists', ['user_playlists']) : Promise.resolve(null));
            if (!fence.active()) return;
            const cachedLikedSongs = snapshot?.likedSongIds
                ?? await enqueueNeteaseCacheWrite(() => fence.active() ? getProviderCacheWithLegacyMigration<unknown>('netease', 'user_liked_songs', ['user_liked_songs']) : Promise.resolve(null));
            if (!fence.active()) return;
            const cachedCloudPlaylistRaw = snapshot?.collections.find(collection => collection.type === 'cloud')
                ?? await enqueueNeteaseCacheWrite(() => fence.active() ? getProviderCacheWithLegacyMigration<unknown>('netease', 'user_cloud_playlist', ['user_cloud_playlist']) : Promise.resolve(null));
            if (!fence.active()) return;
            const cachedUser: ProviderUser | null = cachedUserRaw != null
                ? omni.normalizeCachedUser('netease', cachedUserRaw)
                : null;
            const cachedPlaylists = Array.isArray(cachedPlaylistsRaw)
                ? cachedPlaylistsRaw.map(item => omni.normalizeCachedCollection('netease', item, 'playlist')).filter(Boolean) as ProviderCollection[]
                : [];
            const cachedCloudPlaylist = cachedCloudPlaylistRaw
                ? omni.normalizeCachedCollection('netease', cachedCloudPlaylistRaw, 'cloud')
                : null;

            if (cachedUser) {
                const collections = [...cachedPlaylists, ...(cachedCloudPlaylist ? [cachedCloudPlaylist] : [])];
                const normalizedLikedSongIds = Array.isArray(cachedLikedSongs) ? cachedLikedSongs as MediaId[] : [];
                const cachedSnapshot = snapshot ?? await enqueueNeteaseCacheWrite(() => fence.active() ? saveProviderAccountSnapshot('netease', {
                    user: cachedUser,
                    collections,
                    likedSongIds: normalizedLikedSongIds,
                }) : Promise.resolve(null));
                if (!fence.active() || !cachedSnapshot) return;
                setUser(cachedUser);
                setPlaylists(cachedPlaylists);
                setLikedSongIds(new Set(normalizedLikedSongIds));
                setCloudPlaylist(cachedCloudPlaylist);
                updateProviderAccount('netease', {
                    status: 'authenticated',
                    user: cachedUser,
                    collections,
                    likedSongIds: normalizedLikedSongIds,
                    hydration: 'ready',
                    freshness: 'stale',
                    lastUpdatedAt: cachedSnapshot.savedAt,
                });
                return;
            }

            initialBackgroundRefreshStartedRef.current = true;
            await refreshUserData();
        } catch (error) {
            if (fence.active()) {
                updateProviderAccount('netease', { hydration: 'ready', freshness: 'error', error: 'netease_cache_load_failed' });
                console.warn('Failed to load NetEase account cache', error);
            }
        } finally {
            if (fence.current()) setIsUserDataReady(true);
        }
    }, [beginRequest, refreshUserData, updateProviderAccount]);

    useEffect(() => {
        if (!isUserDataReady || !user || initialBackgroundRefreshStartedRef.current) return;
        initialBackgroundRefreshStartedRef.current = true;
        void refreshUserData(user.id);
    }, [isUserDataReady, refreshUserData, user]);

    const handleClearCache = useCallback(async () => {
        const preserveKeys = [
            ...Object.values(NETEASE_USER_CACHE_KEYS),
            ...omni.getProviderSummaries().map(provider => getProviderAccountSnapshotCacheKey(provider.providerId)),
            'last_song',
            'last_queue',
            'last_theme',
        ];

        try {
            const playlistKeys = await getCacheKeysByPrefix([
                getProviderCacheKey('netease', 'playlist_tracks_'),
                getProviderCacheKey('netease', 'playlist_detail_'),
            ]);

            await clearCache([...preserveKeys, ...playlistKeys]);
            updateCacheSize();
            setStatusMsg({ type: 'success', text: t('status.cacheCleared') });
        } catch (error) {
            console.error('Failed to clear cache:', error);
            setStatusMsg({ type: 'error', text: t('status.cacheCleared') });
        }
    }, [setStatusMsg, t, updateCacheSize]);

    const handleSyncData = useCallback(async () => {
        if (!user) return;

        setIsSyncing(true);
        console.info('[NeteaseSync] Sync data requested', { userId: user.id });
        const request = refreshUserData(user.id);
        const fence = captureRequest();
        try {
            const synced = await request;
            if (!fence.current()) return;
            if (!synced) {
                console.info('[NeteaseSync] Sync data skipped because login is expired or unavailable', {
                    userId: user.id,
                    authExpired: lastRefreshAuthExpiredRef.current,
                });
                setStatusMsg({
                    type: 'error',
                    text: lastRefreshAuthExpiredRef.current ? t('status.loginExpired') : t('status.syncFailed'),
                });
                return;
            }
            updateCacheSize();
            console.info('[NeteaseSync] Sync data completed', { userId: user.id });
            setStatusMsg({ type: 'success', text: t('status.dataSynced') });
        } catch (error) {
            console.warn('[NeteaseSync] Sync data failed', error);
            setStatusMsg({ type: 'error', text: t('status.syncFailed') });
        } finally {
            if (fence.current()) setIsSyncing(false);
        }
    }, [captureRequest, refreshUserData, setStatusMsg, t, updateCacheSize, user]);

    const handleLogout = useCallback(async () => {
        const fence = beginRequest();
        if (!fence.active()) return;
        // The transport captures the old session synchronously; invalidate and clear locally now.
        const notifyLogout = omni.logout('netease');
        const clear = clearAuthState(fence);
        try {
            await notifyLogout;
        } catch (error) {
            console.warn('Failed to notify logout endpoint', error);
        }

        await clear;
        if (fence.current() && readNeteaseSession() === null) setStatusMsg({ type: 'info', text: t('status.loggedOut') });
    }, [beginRequest, clearAuthState, setStatusMsg, t]);

    useEffect(() => {
        loadUserData();
    }, [loadUserData]);

    return {
        user,
        playlists,
        cloudPlaylist,
        likedSongIds,
        isSyncing,
        isUserDataReady,
        cacheSize,
        refreshUserData,
        updateCacheSize,
        handleClearCache,
        handleSyncData,
        handleLogout,
        setLikedSongIds,
    };
}
