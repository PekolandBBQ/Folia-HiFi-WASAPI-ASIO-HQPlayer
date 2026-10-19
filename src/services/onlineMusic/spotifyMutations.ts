import type { OnlineMutationProvider } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { requestSpotify } from './spotifyTransport';
import { getAllSpotifySavedTracks } from './spotifySavedTracks';
import { SPOTIFY_LIKED_COLLECTION_ID } from './spotifyNormalize';
import { setSpotifyCollectionSubscription } from './spotifyCollectionSubscriptions';

// Serialize writes and server refresh together; only return Spotify-confirmed library snapshots.
let writes: Promise<unknown> = Promise.resolve();
export const spotifyMutations: OnlineMutationProvider = {
    subscribeAlbum: (id, subscribed) => setSpotifyCollectionSubscription('album', id, subscribed),
    subscribeArtist: (id, subscribed) => setSpotifyCollectionSubscription('artist', id, subscribed),
    likeSong(song, liked) {
        const source = typeof song === 'object' ? getPlaybackSourceRef(song) : null;
        const id = typeof song === 'object' ? source?.kind === 'online' && source.providerId === 'spotify' ? String(source.mediaId) : '' : String(song);
        const task = writes.catch(() => {}).then(async () => {
            if (!/^[A-Za-z0-9]{22}$/.test(id)) throw new OnlineProviderError('invalid-response', 'Spotify 歌曲标识无效，未修改收藏。', 'spotify');
            const receipt = await requestSpotify<{ trackId: string; liked: boolean; confirmed: boolean }>({ action: 'likeSong', id, liked });
            if (!receipt?.confirmed || receipt.trackId !== id || receipt.liked !== liked)
                throw new OnlineProviderError('unavailable', 'Spotify 尚未确认收藏状态，本地未标记成功。', 'spotify');
            let songs;
            try { songs = await getAllSpotifySavedTracks(); }
            catch (cause) { throw new OnlineProviderError('unavailable', 'Spotify 已确认收藏操作，但已点赞歌单刷新失败；请刷新歌单，播放不受影响。', 'spotify', cause); }
            const ids = songs.map(item => item.id);
            if (ids.some(value => String(value) === id) !== liked)
                throw new OnlineProviderError('unavailable', 'Spotify 已确认收藏操作，但已点赞歌单尚未同步；请稍后刷新歌单。', 'spotify');
            return { likedSongIds: ids, collectionId: SPOTIFY_LIKED_COLLECTION_ID };
        });
        writes = task;
        return task;
    },
};
