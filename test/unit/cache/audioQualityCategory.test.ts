import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appDatabase } from '@/services/appDatabase';
import { clearBrowserCacheByCategory, getBrowserCacheUsageByCategory, putCacheEntry, readCacheEntry } from '@/services/repositories/cacheRepository';

// Several encodings consume several files but remain one cached song in the storage readout.
beforeEach(async () => { await Promise.all([appDatabase.api_cache.clear(), appDatabase.media_cache.clear(), appDatabase.metadata_cache.clear()]); });
describe('quality-aware audio cache accounting', () => {
  it('counts all bytes, deduplicates song count and clears every quality with the media category', async () => {
    const keys = ['audio_online:qq:one', 'audio_online:qq:one:quality:standard', 'audio_online:qq:one:quality:high'];
    for (const key of keys) await putCacheEntry(key, new Blob(['audio']));
    const usage = await getBrowserCacheUsageByCategory();
    expect(usage.media).toBe(15); expect(usage.mediaCount).toBe(1);
    await clearBrowserCacheByCategory('media');
    for (const key of keys) expect(await readCacheEntry(key)).toBeNull();
  });
});
