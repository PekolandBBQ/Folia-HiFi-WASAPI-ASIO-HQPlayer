import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appDatabase } from '@/services/appDatabase';
import { clearBrowserCacheByCategory, getBrowserCacheUsageByCategory, putCacheEntry, readCacheEntry } from '@/services/repositories/cacheRepository';

// test/unit/cache/providerPlaylistCategory.test.ts — the playlist button also owns provider home snapshots.
const keys = ['spotify', 'qq', 'kugou'].map(provider => `online_provider_${provider}_user_home_snapshot`);
const snapshot = { version: 1, user: { id: 'synthetic-user' }, collections: [{ id: 'synthetic-playlist' }], likedSongIds: [] };
beforeEach(async () => {
  await Promise.all([appDatabase.api_cache.clear(), appDatabase.user_cache.clear(), appDatabase.metadata_cache.clear(), appDatabase.media_cache.clear()]);
});

describe('provider home snapshots are playlist cache data', () => {
  it('counts and clears snapshots together with playlist detail and tracks without clearing other provider state', async () => {
    const playlistKeys = [...keys, 'online_provider_spotify_playlist_tracks_synthetic', 'online_provider_spotify_playlist_detail_synthetic'];
    for (const key of playlistKeys) await putCacheEntry(key, snapshot);
    await putCacheEntry('online_provider_spotify_user_other_state', { keep: true });
    await putCacheEntry('audio_synthetic', new Blob(['audio']));
    expect((await getBrowserCacheUsageByCategory()).playlist).toBe(JSON.stringify(snapshot).length * playlistKeys.length);
    await clearBrowserCacheByCategory('playlist');
    for (const key of playlistKeys) expect(await readCacheEntry(key)).toBeNull();
    expect(await readCacheEntry('online_provider_spotify_user_other_state')).toEqual({ keep: true });
    expect(await readCacheEntry('audio_synthetic')).not.toBeNull();
  });

  it('clears a snapshot in an older table and preserves snapshots when another category is cleared', async () => {
    await appDatabase.api_cache.put({ key: keys[0], data: snapshot, timestamp: 1 });
    await putCacheEntry(keys[1], snapshot);
    await clearBrowserCacheByCategory('media');
    expect((await getBrowserCacheUsageByCategory()).playlist).toBe(JSON.stringify(snapshot).length * 2);
    await clearBrowserCacheByCategory('playlist');
    expect(await appDatabase.api_cache.get(keys[0])).toBeUndefined();
    expect(await readCacheEntry(keys[1])).toBeNull();
  });
});
