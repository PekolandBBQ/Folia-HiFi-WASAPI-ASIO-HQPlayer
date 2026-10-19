import { observeSpotifyLibraryPage } from './spotifyLibraryDiagnostics';
import type { OnlineMusicProvider, QrLoginState } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { requestSpotify, spotifyAvailable } from './spotifyTransport';
import { createSpotifyLikedCollection, normalizeSpotifyCollection, normalizeSpotifyPage, normalizeSpotifySong, normalizeSpotifyUser, SPOTIFY_LIKED_COLLECTION_ID } from './spotifyNormalize';
import { normalizeSpotifyAudioSource } from './spotifyAudioSource';
import { getAllSpotifySavedTracks, getSpotifySavedTracks, spotifyLibraryError } from './spotifySavedTracks';
import { normalizeSpotifyLyrics } from './spotifyLyrics';
import { spotifyMutations } from './spotifyMutations';

// Desktop preview routes temporary PCM through Folia's normal playback engines via Omni.
export const spotifyProvider: OnlineMusicProvider = {
    id: 'spotify', displayName: 'Spotify', shortName: 'Spotify',
    getAvailability: () => ({ configured: spotifyAvailable(), ...(!spotifyAvailable() ? { reason: 'runtime-unavailable' as const } : {}) }),
    capabilities: { search: true, playback: true, lyrics: true, auth: true, userLibrary: true, playlists: true,
        albums: true, artists: true, userAlbums: true, userArtists: true, recommendations: true, mutations: true, wordByWordLyrics: false, likes: true,
        albumSearch: true, artistSearch: true, albumSubscription: true, artistSubscription: true },
    mutations: spotifyMutations,
    normalizeSong: normalizeSpotifySong, normalizeCollection: normalizeSpotifyCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    getSongPageUrl: song => `https://open.spotify.com/track/${encodeURIComponent(String(song.id))}`,
    auth: {
        getLoginStatus: async () => normalizeSpotifyUser(await requestSpotify({ action: 'status' })),
        logout: async () => { await requestSpotify({ action: 'logout' }); },
        getQrKey: () => requestSpotify<string>({ action: 'loginBegin' }),
        createQr: key => requestSpotify<string>({ action: 'loginImage', key }),
        checkQr: key => requestSpotify<QrLoginState>({ action: 'loginCheck', key }),
        cancelQr: async key => { await requestSpotify({ action: 'loginCancel', key }); },
    },
    connection: {
        getSettings: () => requestSpotify({ action: 'configuration' }),
        setSettings: settings => requestSpotify({ action: 'configure', settings }),
    },
    playbackSetup: { request: (input, options) => requestSpotify({ action: 'playbackSetup', ...input }, options) },
    lyrics: { async getLyrics(song) {
        const id = song.sourceRef?.mediaId || String(song.id);
        return normalizeSpotifyLyrics(await requestSpotify({ action: 'lyrics', id }), id);
    } },
    search: {
        searchAlbums: async (query,limit,offset) => normalizeSpotifyPage(await requestSpotify({action:'searchAlbums',query,limit,offset}),offset,normalizeSpotifyCollection),
        searchArtists: async (query,limit,offset) => normalizeSpotifyPage(await requestSpotify({action:'searchArtists',query,limit,offset}),offset,normalizeSpotifyCollection),
        async searchSongs(query, limit, offset) {
        return normalizeSpotifyPage(await requestSpotify({ action: 'search', query, limit, offset }), offset, normalizeSpotifySong, true);
    } },
    playback: {
        resolveExternalSelection: (token, choice) => requestSpotify({ action: 'externalSelection', token, choice }),
        async repeatMode(mode) {
            const result = await requestSpotify<{mode: import('../../types/onlineMusic').ProviderRepeatMode}>({action: 'repeatMode', mode});
            if (!['off', 'all', 'one'].includes(result?.mode)) throw new Error('Spotify 未返回有效循环模式');
            return result.mode;
        },
        async leaveSource(options) {
            if (!spotifyAvailable()) return;
            const current = () => !options?.signal?.aborted && options?.isCurrent?.() !== false;
            if (!current()) throw new DOMException('Request cancelled', 'AbortError');
            const snapshot = await requestSpotify<{ revision: number; ownsRoute?: boolean }>({ action: 'sourceRevision' });
            if (!current()) throw new DOMException('Request cancelled', 'AbortError');
            if (snapshot.ownsRoute === false) return;
            try { await requestSpotify({ action: 'leaveProvider', expectedSourceRevision: snapshot.revision }); }
            catch (error) {
                if (error instanceof Error && error.message === 'Spotify: request-cancelled')
                    throw new DOMException('Request cancelled', 'AbortError');
                throw error;
            }
            if (!current()) throw new DOMException('Request cancelled', 'AbortError');
        },
        getSongDetail: async id => normalizeSpotifySong(await requestSpotify({ action: 'song', id: String(id) })),
        getAudioSource: async (song, quality, options) => normalizeSpotifyAudioSource(
            await requestSpotify<Record<string, unknown>>({ action: 'audio', id: song.sourceRef?.mediaId || String(song.id), quality, streaming: options?.streaming === true }, options), quality),
        getAvailability: song => ({
            state: song.sourceRef?.kind === 'online' && song.sourceRef.providerData?.playable === false ? 'unavailable' : 'unknown',
            labelKey: 'spotifyPlaybackErrors.notPlayable',
        }),
    },
    library: {
        async getUserPlaylists(_id, limit, offset) {
            const raw = await requestSpotify({ action: 'playlists', limit, offset });
            return observeSpotifyLibraryPage(raw, offset, () => normalizeSpotifyPage(raw, offset, normalizeSpotifyCollection));
        },
        getLikedSongs: () => getAllSpotifySavedTracks(),
        getLikedSongIds: async () => (await getAllSpotifySavedTracks()).map(song => song.id),
        getUserAlbums: async (_id, limit, offset) => normalizeSpotifyPage(await requestSpotify({action:'albums',limit,offset}),offset,normalizeSpotifyCollection),
        getUserArtists: async (_id, limit, offset) => normalizeSpotifyPage(await requestSpotify({action:'artists',limit,offset}),offset,normalizeSpotifyCollection),
    },
    recommendations: {
        getRecommendedCollections: async limit => (await requestSpotify<{items:unknown[]}>({action:'recommendations',limit})).items.map(normalizeSpotifyCollection),
    },
    catalog: {
        getSubscriptionStatus: async (type,id) => {
            if (type !== 'album' && type !== 'artist') throw new Error('当前 Spotify 收藏操作仅支持专辑和艺人');
            return (await requestSpotify<{subscribed:boolean}>({action:'subscriptionStatus',collectionType:type,id:String(id)})).subscribed;
        },
        getArtistDetail: async id => normalizeSpotifyCollection(await requestSpotify({action:'artist',id:String(id)})),
        getArtistSongs: async (id,limit,offset) => normalizeSpotifyPage(await requestSpotify({action:'artistSongs',id:String(id),limit,offset}),offset,normalizeSpotifySong,true),
        getArtistAlbums: async (id,limit,offset) => normalizeSpotifyPage(await requestSpotify({action:'artistAlbums',id:String(id),limit,offset}),offset,normalizeSpotifyCollection),
        getPlaylistDetail: async id => {
            if (id === SPOTIFY_LIKED_COLLECTION_ID) return createSpotifyLikedCollection((await getSpotifySavedTracks(1, 0)).total);
            try { return normalizeSpotifyCollection(await requestSpotify({ action: 'playlist', id: String(id) })); }
            catch (error) { return spotifyLibraryError(error, 'playlist'); }
        },
        getPlaylistTracks: async (id, limit, offset) => {
            if (id === SPOTIFY_LIKED_COLLECTION_ID) return getSpotifySavedTracks(limit, offset);
            try { return { ...normalizeSpotifyPage(await requestSpotify({ action: 'playlistTracks', id: String(id), limit, offset }), offset, normalizeSpotifySong, true), preserveDuplicates: true }; }
            catch (error) { return spotifyLibraryError(error, 'playlist'); }
        },
        getAlbumDetail: async id => normalizeSpotifyCollection(await requestSpotify({ action: 'album', id: String(id) })),
        getAlbumTracks: async (id, limit = 50, offset = 0) => {
            return normalizeSpotifyPage(await requestSpotify({ action: 'albumTracks', id: String(id), limit, offset }), offset, normalizeSpotifySong, true);
        },
    },
};
