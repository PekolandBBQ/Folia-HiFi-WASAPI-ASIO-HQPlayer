import { createSpotifyLibraryObservation, observeSpotifyLibraryHydration } from '../services/onlineMusic/spotifyLibraryDiagnostics';
import { useCallback, useEffect, useRef } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { clearProviderAccountSnapshot, loadProviderAccountSnapshot, saveProviderAccountSnapshot } from '../services/onlineMusic/providerAccountCache';
import { isAuthRequiredFailure } from '../services/onlineMusic/loginStatusFailure';
import { revokeProviderPlayback } from '../services/onlineMusic/revokeProviderPlayback';
import { collectProviderPages } from '../services/onlineMusic/providerPagination';
import { createSpotifyLikedCollection } from '../services/onlineMusic/spotifyNormalize';
import { spotifyLikedCover } from '../services/onlineMusic/spotifyLikedCover';
import { spotifyActivation } from '../services/onlineMusic/spotifyActivation';

// Spotify uses the same account store and playlist snapshots as other providers, through Omni.
export function useSpotifyLibrary() {
    const generation = useRef(0);
    const writes = useRef<Promise<unknown>>(Promise.resolve());
    const pending = useRef<Promise<boolean> | null>(null);
    const connectionRevision = useOnlineProviderAccountStore(state => state.accounts.spotify?.connectionRevision || 0);
    const registered = () => omni.getProviderSummaries().some(provider => provider.providerId === 'spotify' && provider.availability.configured);
    const enqueue = useCallback((run: () => Promise<unknown>) => {
        const task = writes.current.catch(() => {}).then(run); writes.current = task; return task;
    }, []);
    const logout = useCallback(async () => {
        generation.current++; pending.current = null;
        useOnlineProviderAccountStore.getState().clearAccount('spotify');
        const results = await Promise.allSettled([omni.logout('spotify').then(() => revokeProviderPlayback('spotify')), enqueue(() => clearProviderAccountSnapshot('spotify'))]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
    }, [enqueue]);
    const refresh = useCallback(async (): Promise<boolean> => {
        if (!registered() || !spotifyActivation.selected()) return false;
        if (pending.current) return pending.current;
        const observation = createSpotifyLibraryObservation('spotify', useOnlineProviderAccountStore.getState().accounts.spotify?.collections);
        const expected = generation.current;
        const revision = useOnlineProviderAccountStore.getState().accounts.spotify?.connectionRevision || 0;
        const active = () => expected === generation.current && revision === (useOnlineProviderAccountStore.getState().accounts.spotify?.connectionRevision || 0);
        const update = (patch: Parameters<ReturnType<typeof useOnlineProviderAccountStore.getState>['updateAccount']>[1]) => {
            if (active()) useOnlineProviderAccountStore.getState().updateAccount('spotify', patch);
        };
        const task = (async () => {
            update({ freshness: 'refreshing' });
            try {
                const user = await omni.getLoginStatus('spotify');
                if (!active()) { observation.result(false, { reason: 'cancelled', revisionChanged: true }); return false; }
                if (!user) {
                    useOnlineProviderAccountStore.getState().clearAccount('spotify');
                    await enqueue(() => active() ? clearProviderAccountSnapshot('spotify') : Promise.resolve());
                    observation.result(false, { reason: 'failed' });
                    return false;
                }
                const previous = useOnlineProviderAccountStore.getState().accounts.spotify;
                const previousLikedIds = previous?.likedSongIds;
                const sameUser = previous?.user?.id === user.id;
                update({ status: 'authenticated', user, hydration: 'ready', error: undefined,
                    ...(!sameUser ? { collections: [], likedSongIds: [] } : {}) });
                const collections = await collectProviderPages({
                    providerId: 'spotify',
                    fetchPage: offset => omni.getProviderUserPlaylists('spotify', user.id, { limit: 50, offset }),
                    getKey: collection => `${collection.providerId}:${collection.type}:${String(collection.id)}`,
                    isCancelled: () => !active(),
                    onPage: observation.page,
                });
                if (!collections || !active()) { observation.result(false, { reason: 'cancelled', revisionChanged: !active() }); return false; }
                let likedSongIds = sameUser ? previous?.likedSongIds || [] : [];
                let likedFailure: unknown;
                let likedCover = sameUser ? previous?.collections.find(collection => collection.isLiked)?.coverUrl : undefined;
                try {
                    const likedSongs = await omni.getProviderLikedSongs('spotify', user.id);
                    likedSongIds = likedSongs.map(song => song.id);
                    likedCover = likedSongs.length ? await spotifyLikedCover(String(user.id), likedSongs) || likedCover : undefined;
                }
                catch (error) {
                    if (isAuthRequiredFailure(error)) throw error;
                    likedFailure = error;
                }
                if (!active()) { observation.result(false, { reason: 'cancelled', revisionChanged: true }); return false; }
                const previousLikedCount = sameUser ? previous?.collections.find(collection => collection.isLiked)?.trackCount : undefined;
                collections.unshift({ ...createSpotifyLikedCollection(likedFailure ? previousLikedCount : likedSongIds.length), coverUrl: likedCover });
                // A confirmed mutation may complete while this older refresh is fetching or saving.
                const preserveNewerLikes = () => {
                    const latest = useOnlineProviderAccountStore.getState().accounts.spotify;
                    const latestLiked = latest?.collections.find(collection => collection.isLiked);
                    if (sameUser && latest?.user?.id === user.id && latest.likedSongIds !== previousLikedIds) {
                        likedSongIds = latest.likedSongIds;
                        collections[0] = { ...collections[0], ...latestLiked, trackCount: likedSongIds.length };
                    } else if (latestLiked?.tracksUpdatedAt) {
                        collections[0] = { ...collections[0], tracksUpdatedAt: latestLiked.tracksUpdatedAt };
                    }
                };
                await enqueue(async () => {
                    preserveNewerLikes();
                    if (active()) await saveProviderAccountSnapshot('spotify', { user, collections, likedSongIds });
                });
                preserveNewerLikes();
                if (active()) observation.replace(useOnlineProviderAccountStore.getState().accounts.spotify?.collections || [], collections);
                update({ collections, likedSongIds, freshness: likedFailure ? 'error' : 'fresh', lastUpdatedAt: Date.now(),
                    error: likedFailure instanceof Error ? likedFailure.message : likedFailure ? 'Spotify: saved-tracks-unavailable' : undefined });
                observation.result(active(), { accountChanged: !sameUser, revisionChanged: !active() });
                return active();
            } catch (error) {
                observation.result(false, { reason: active() ? 'failed' : 'cancelled', revisionChanged: !active() });
                if (!active()) return false;
                if (isAuthRequiredFailure(error)) {
                    // An unreadable vault or failed refresh must not delete an otherwise recoverable grant.
                    useOnlineProviderAccountStore.getState().clearAccount('spotify', error instanceof Error ? error.message : 'Spotify: auth-required');
                    await enqueue(() => active() ? clearProviderAccountSnapshot('spotify') : Promise.resolve());
                }
                else update({ status: useOnlineProviderAccountStore.getState().accounts.spotify?.user ? 'authenticated' : 'error',
                    hydration: 'ready', freshness: 'error', error: error instanceof Error ? error.message : 'Spotify: request-failed' });
                return false;
            }
        })();
        pending.current = task;
        try { return await task; } finally { if (pending.current === task) pending.current = null; }
    }, [enqueue]);
    useEffect(() => {
        if (!registered()) return;
        const expected = generation.current;
        const beforeHydration = useOnlineProviderAccountStore.getState().accounts.spotify;
        void (async () => {
            // A client change invalidates snapshots even if a previous refresh was still writing one.
            if (connectionRevision) await enqueue(() => clearProviderAccountSnapshot('spotify'));
            const cached = connectionRevision ? null : await loadProviderAccountSnapshot('spotify').catch(() => null);
            if (expected !== generation.current || connectionRevision !== (useOnlineProviderAccountStore.getState().accounts.spotify?.connectionRevision || 0)) return;
            // A login/manual refresh may finish while disk hydration is still pending.
            if (cached) observeSpotifyLibraryHydration(cached.collections, beforeHydration === useOnlineProviderAccountStore.getState().accounts.spotify);
            if (cached && beforeHydration === useOnlineProviderAccountStore.getState().accounts.spotify) useOnlineProviderAccountStore.getState().updateAccount('spotify', { ...cached,
                status: 'authenticated', hydration: 'ready', freshness: 'stale', lastUpdatedAt: cached.savedAt });
            if (spotifyActivation.selected()) await refresh();
        })();
        const unsubscribe = spotifyActivation.subscribe(() => { void refresh(); });
        return () => { unsubscribe(); generation.current++; pending.current = null; };
    }, [refresh, connectionRevision, enqueue]);
    return { refresh, logout };
}
