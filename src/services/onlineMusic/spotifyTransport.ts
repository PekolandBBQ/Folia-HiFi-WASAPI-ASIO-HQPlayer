import { OnlineProviderError } from '../../types/onlineMusic';
import type { ProviderErrorCode, AudioSourceRequestOptions, ProviderConnectionSettings, ProviderPlaybackSetupRequest } from '../../types/onlineMusic';

// The renderer sees metadata and opaque login handles, never a Spotify bearer token.
export type SpotifyRequest = { action: 'searchArtists' | 'searchAlbums' | 'subscriptionStatus' | 'subscribeCollection' | 'loginBegin' | 'loginImage' | 'loginCheck' | 'loginCancel' | 'status' | 'logout'
    | 'externalSelection' | 'repeatMode' | 'desktopSetup' | 'search' | 'likeSong' | 'playlists' | 'albums' | 'artists' | 'artist' | 'artistSongs' | 'artistAlbums' | 'recommendations' | 'savedTracks' | 'song' | 'lyrics' | 'playlist' | 'playlistTracks' | 'album' | 'albumTracks' | 'audio' | 'cancelAudio' | 'configuration' | 'configure' | 'playbackSetup' | 'sourceRevision' | 'leaveProvider';
    mode?: import('../../types/onlineMusic').ProviderRepeatMode;
    token?: number; choice?: 'follow' | 'pause' | 'spotify';
    liked?: boolean; collectionType?: 'album' | 'artist'; subscribed?: boolean; preferences?: {quitOnFoliaExit:boolean};
    expectedSourceRevision?: number; key?: string; id?: string; query?: string; quality?: import('../../types/onlineMusic').AudioQualityPreference; streaming?: boolean; limit?: number; offset?: number; requestId?: string; settings?: ProviderConnectionSettings;
    operation?: ProviderPlaybackSetupRequest['operation'] | 'preferences' | 'choose' | 'open' | 'launch' | 'install' | 'configure'; component?: string; installation?: string; keyValue?: string; selection?: import('../../types/onlineMusic').ProviderCableSelection };
export type SpotifyProgress = Parameters<NonNullable<AudioSourceRequestOptions['onProgress']>>[0] & { requestId: string };
export const spotifyAvailable = () => typeof window !== 'undefined' && typeof window.electron?.spotify?.request === 'function';
export async function requestSpotify<T>(request: SpotifyRequest, options?: AudioSourceRequestOptions): Promise<T> {
    if (!spotifyAvailable()) throw new OnlineProviderError('unavailable', 'Spotify desktop runtime unavailable', 'spotify');
    const bridge = window.electron!.spotify!;
    const setupStart = request.action === 'playbackSetup' && ['start', 'probe'].includes(request.operation || '');
    const desktopLaunch = request.action === 'desktopSetup' && request.operation === 'launch';
    const requestId = request.action === 'audio' || setupStart || desktopLaunch ? crypto.randomUUID() : undefined;
    if (options?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    const unsubscribe = requestId ? bridge.onProgress?.(value => {
        if (value.requestId === requestId && !options?.signal?.aborted) options?.onProgress?.(value);
    }) : undefined;
    const cancel = () => { if (requestId && !desktopLaunch) void bridge.request(setupStart
        ? { action: 'playbackSetup', operation: 'stop' } : { action: 'cancelAudio', requestId }).catch(() => {}); };
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
        const result = await bridge.request({ ...request, ...(requestId ? { requestId } : {}) }) as T & { spotifyError?: { code: ProviderErrorCode; message: string; detail?: string; stage?: string; nativeCode?: string; causeCode?: string } };
        if (options?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        if (result?.spotifyError) throw new OnlineProviderError(result.spotifyError.code,
            ['searchArtists', 'searchAlbums', 'subscriptionStatus', 'subscribeCollection', 'search', 'likeSong', 'savedTracks', 'playlists', 'albums', 'artists', 'artist', 'artistSongs', 'artistAlbums', 'recommendations', 'playlist', 'playlistTracks', 'album', 'albumTracks'].includes(request.action) ? result.spotifyError.detail || result.spotifyError.message : result.spotifyError.message,
            'spotify', undefined, undefined, undefined, { userMessage: result.spotifyError.detail, stage: result.spotifyError.stage, nativeCode: result.spotifyError.nativeCode, causeCode: result.spotifyError.causeCode });
        return result;
    } finally { unsubscribe?.(); options?.signal?.removeEventListener('abort', cancel); }
}
