import { OnlineProviderError } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import i18n from '../../i18n/config';
import { collectProviderPages } from './providerPagination';
import { requestSpotify } from './spotifyTransport';
import { normalizeSpotifyPage, normalizeSpotifySong } from './spotifyNormalize';

// src/services/onlineMusic/spotifySavedTracks.ts — Liked Songs is the public saved-tracks resource, not a playlist ID.
export function spotifyLibraryError(error: unknown, collection: 'playlist' | 'savedTracks'): never {
    if (collection === 'playlist' && error instanceof OnlineProviderError) {
        const key = error.message === 'Spotify: public-playlist-restart-required' ? 'publicPlaylistRestartRequired'
            : ['Spotify: public-playlist-schema', 'Spotify: public-playlist-limit'].includes(error.message) ? 'publicPlaylistInvalidMetadata'
            : ['Spotify: public-playlist-unavailable', 'Spotify: public-playlist-network', 'Spotify: public-playlist-timeout', 'Spotify: public-playlist-redirect'].includes(error.message) ? 'publicPlaylistUnavailable' : undefined;
        if (key) throw new OnlineProviderError(error.code, i18n.t(`spotifyLibrary.${key}`), 'spotify', error);
    }
    if (error instanceof OnlineProviderError && error.message === 'Spotify: catalog-http-403') {
        throw new OnlineProviderError(error.code, i18n.t(`spotifyLibrary.${collection}Forbidden`), 'spotify', error);
    }
    throw error;
}
export async function getSpotifySavedTracks(limit = 50, offset = 0) {
    try {
        return normalizeSpotifyPage(await requestSpotify({ action: 'savedTracks', limit, offset }), offset, normalizeSpotifySong, true);
    } catch (error) { return spotifyLibraryError(error, 'savedTracks'); }
}
export async function getAllSpotifySavedTracks() {
    return await collectProviderPages({ providerId: 'spotify', fetchPage: offset => getSpotifySavedTracks(50, offset),
        getKey: getPlaybackSongKey }) ?? [];
}
