import type { UnifiedSong } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import type { ProviderCollection, ProviderMetadataStatus, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import i18n from '../../i18n/config';

// Normalize both current `item` and extended-quota `track` envelopes at the adapter boundary.
type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {};
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9]{22}$/.test(id);
const cover = (raw: RecordValue) => Array.isArray(raw.images) ? raw.images.find((image: RecordValue) => typeof image?.url === 'string' && image.url.startsWith('https://'))?.url : undefined;
// Only typed provider metadata leaves the adapter; unknown counts stay absent.
const metadataStatus = (raw: RecordValue): ProviderMetadataStatus => ({
    metadataSource: raw.metadataSource === 'spotify-public-embed' ? 'spotify-public-embed' : 'spotify-api',
    ...(typeof raw.sourceUrl === 'string' && /^https:\/\/open\.spotify\.com\/(?:embed\/playlist|playlist|track|album)\/[A-Za-z0-9]{22}$/.test(raw.sourceUrl) ? { sourceUrl: raw.sourceUrl } : {}),
    ...(['complete', 'partial', 'unknown'].includes(raw.metadataCompleteness) ? { metadataCompleteness: raw.metadataCompleteness } : {}),
    ...(Number.isSafeInteger(raw.loadedCount) && raw.loadedCount >= 0 ? { loadedCount: raw.loadedCount } : {}),
});
export const SPOTIFY_LIKED_COLLECTION_ID = 'spotify-liked-songs';
export function createSpotifyLikedCollection(trackCount?: number): ProviderCollection {
    return { id: SPOTIFY_LIKED_COLLECTION_ID, providerId: 'spotify', type: 'playlist', isLiked: true, isOwned: true, metadataSource: 'spotify-api',
        name: i18n.t('spotifyLibrary.likedSongs'), description: i18n.t('spotifyLibrary.likedSongsDescription'),
        ...(Number.isSafeInteger(trackCount) && trackCount! >= 0 ? { trackCount } : {}) };
}
export function normalizeSpotifySong(value: unknown): UnifiedSong {
    const raw = object(value);
    if (raw.sourceRef?.kind === 'online' && raw.sourceRef.providerId === 'spotify' && validId(raw.sourceRef.mediaId)) {
        if (raw.sourceRef.providerData?.metadataSource === 'spotify-public-embed') {
            const { playable: _playable, ...providerData } = raw.sourceRef.providerData;
            return { ...raw, sourceRef: { ...raw.sourceRef, providerData: { ...providerData, playbackVerified: false, sessionBoundAudio: true } } } as UnifiedSong;
        }
        if (raw.sourceRef.providerData?.sessionBoundAudio === true) return value as UnifiedSong;
        return { ...raw, sourceRef: { ...raw.sourceRef, providerData: { ...raw.sourceRef.providerData, sessionBoundAudio: true } } } as UnifiedSong;
    }
    if (!validId(raw.id) || typeof raw.name !== 'string' || raw.type === 'episode' || raw.is_local) {
        throw new OnlineProviderError('invalid-response', 'Spotify track metadata unavailable', 'spotify');
    }
    const album = object(raw.album);
    const publicMetadata = raw.metadataSource === 'spotify-public-embed';
    const albumCover = cover(album);
    const publicArtwork = raw.artworkSource === 'spotify-oembed' && raw.artworkStatus === 'available'
        && typeof albumCover === 'string' && /^https:\/\/(?:image-cdn-fa\.spotifycdn\.com|image-cdn-ak\.spotifycdn\.com|i\.scdn\.co)\/image\/[a-f0-9]{40}$/.test(albumCover);

    return { id: raw.id, name: raw.name, durationMs: Math.max(0, Number(raw.duration_ms) || 0),
        artists: Array.isArray(raw.artists) ? raw.artists.map((artist: RecordValue) => ({ id: String(artist.id || ''), name: String(artist.name || '') })) : [],
        album: { id: String(album.id || ''), name: String(album.name || ''), coverUrl: publicMetadata ? publicArtwork ? albumCover : undefined : albumCover },
        sourceRef: { kind: 'online', providerId: 'spotify', mediaId: raw.id,
            providerData: { ...(publicMetadata ? { playbackVerified: false, durationKnown: Number.isSafeInteger(raw.duration_ms) && raw.duration_ms >= 0 } : { playable: raw.is_playable !== false && !raw.restrictions?.reason }),
                ...(publicMetadata ? { artworkStatus: publicArtwork ? 'available' : 'unavailable',
                    ...(publicArtwork ? { artworkSource: 'spotify-oembed',
                        artworkSourceUrl: `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${raw.id}`)}` } : {}) } : {}),
                sessionBoundAudio: true, uri: `spotify:track:${raw.id}`, metadataSource: publicMetadata ? 'spotify-public-embed' : 'spotify-api',
                sourceUrl: `https://open.spotify.com/track/${raw.id}`,
                ...(publicMetadata && typeof raw.metadataUrl === 'string' && /^https:\/\/open\.spotify\.com\/embed\/playlist\/[A-Za-z0-9]{22}$/.test(raw.metadataUrl) ? { metadataUrl: raw.metadataUrl } : {}),
                ...(typeof raw.originUrl === 'string' && /^https:\/\/open\.spotify\.com\/(?:embed\/)?playlist\/[A-Za-z0-9]{22}$/.test(raw.originUrl) ? { originUrl: raw.originUrl } : {}) } } };
}
export function normalizeSpotifyCollection(value: unknown): ProviderCollection {
    const raw = object(value);
    // The local bridge queue is a Folia collection, not an official Spotify playlist ID.
    if (raw.providerId === 'spotify' && raw.id === 'folia-local-queue' && raw.providerData?.localQueue === true
        && raw.type === 'playlist' && typeof raw.name === 'string') return value as ProviderCollection;
    if (raw.providerId === 'spotify' && raw.id === SPOTIFY_LIKED_COLLECTION_ID && raw.isLiked === true) return value as ProviderCollection;
    if (!validId(raw.id) || typeof raw.name !== 'string') throw new OnlineProviderError('invalid-response', 'Spotify collection unavailable', 'spotify');
    if (raw.providerId === 'spotify') return value as ProviderCollection;
    const trackCount = raw.items?.total ?? raw.tracks?.total ?? raw.total_tracks;
    const owner = object(raw.owner);
    return { id: raw.id, providerId: 'spotify', type: raw.type === 'album' ? 'album' : 'playlist', name: raw.name,
        coverUrl: cover(raw), ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        ...(Number.isSafeInteger(trackCount) && trackCount >= 0 ? { trackCount } : {}),
        ...(typeof raw.isOwned === 'boolean' ? { isOwned: raw.isOwned } : {}),
        ...(typeof owner.id === 'string' && owner.id ? { creator: { id: owner.id, nickname: owner.display_name || owner.id } } : {}),
        providerData: { ...(raw.metadataSource === 'spotify-public-embed' && typeof raw.providerData?.metadataUrl === 'string'
                && /^https:\/\/open\.spotify\.com\/embed\/playlist\/[A-Za-z0-9]{22}$/.test(raw.providerData.metadataUrl) ? { metadataUrl: raw.providerData.metadataUrl } : {}),
            ...(typeof raw.public === 'boolean' ? { public: raw.public } : {}),
            ...(typeof raw.collaborative === 'boolean' ? { collaborative: raw.collaborative } : {}),
            ...(typeof raw.providerData?.playlistRelationship === 'string' ? { playlistRelationship: raw.providerData.playlistRelationship } : {}) },
        ...metadataStatus({ ...raw, sourceUrl: raw.sourceUrl || `https://open.spotify.com/${raw.type === 'album' ? 'album' : 'playlist'}/${raw.id}` }) };
}
export function normalizeSpotifyUser(value: unknown): ProviderUser | null {
    if (value == null) return null;
    const raw = object(value);
    if (typeof raw.id !== 'string' || !raw.id) throw new OnlineProviderError('invalid-response', 'Spotify account unavailable', 'spotify');
    return { id: raw.id, nickname: raw.display_name || raw.id, avatarUrl: cover(raw),
        ...(typeof raw.product === 'string' ? { vipType: raw.product === 'premium' ? 1 : 0 } : {}) };
}
export function normalizeSpotifyPage<T>(value: unknown, offset: number, normalize: (entry: unknown) => T, tracks = false): ProviderPage<T> {
    const raw = object(value);
    if (!Array.isArray(raw.items)) throw new OnlineProviderError('invalid-response', 'Spotify page unavailable', 'spotify');
    const rows = tracks ? raw.items.map((entry: unknown) => object(entry).item ?? object(entry).track ?? entry)
        .filter((entry: RecordValue | null) => entry && validId(entry.id) && entry.type !== 'episode' && !entry.is_local) : raw.items;
    const consumed = Number.isInteger(raw.consumed) && raw.consumed >= raw.items.length ? raw.consumed : raw.items.length;
    const nextOffset = offset + consumed;
    return { items: rows.map(normalize), total: Number.isSafeInteger(raw.total) && raw.total >= 0 ? raw.total : undefined,
        hasMore: Boolean(raw.next), nextOffset, ...metadataStatus(raw),
        ...(raw.preserveDuplicates === true ? { preserveDuplicates: true } : {}) };
}
