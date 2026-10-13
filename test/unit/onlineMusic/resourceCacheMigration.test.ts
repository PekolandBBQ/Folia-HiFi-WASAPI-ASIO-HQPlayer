import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFromCache, saveToCache } from '@/services/db';
import { getCachedAudioBlob, hasCachedAudio, saveAudioBlob } from '@/services/audioCache';
import { getCachedSongAudioBlob, getSongCacheWithLegacyMigration, hasCachedSongAudio } from '@/services/onlineMusic/resourceCache';
import type { SongResult } from '@/types';

// test/unit/onlineMusic/resourceCacheMigration.test.ts

vi.mock('@/services/db', () => ({
    getFromCache: vi.fn(),
    saveToCache: vi.fn(),
}));

vi.mock('@/services/audioCache', () => ({
    getCachedAudioBlob: vi.fn(),
    hasCachedAudio: vi.fn(),
    saveAudioBlob: vi.fn(),
}));

vi.mock('@/services/coverCache', () => ({
    getCachedCoverUrl: vi.fn(),
    saveCoverBlob: vi.fn(),
}));

const legacyNeteaseSong: SongResult = {
    id: 42,
    name: 'Legacy',
    artists: [],
    album: { id: 1, name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '42' },
};

describe('provider-aware resource cache migration', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(hasCachedAudio).mockResolvedValue(false);
        vi.mocked(getCachedAudioBlob).mockResolvedValue(null);
    });
    it('lets analysis reuse a quality variant without relabelling it as generic audio', async () => {
        const blob = new Blob(['high']);
        const key = 'audio_online:netease:42:quality:high';
        vi.mocked(hasCachedAudio).mockImplementation(async candidate => candidate === key);
        vi.mocked(getCachedAudioBlob).mockImplementation(async candidate => candidate === key ? blob : null);
        await expect(getCachedSongAudioBlob(legacyNeteaseSong)).resolves.toBe(blob);
        await expect(hasCachedSongAudio(legacyNeteaseSong)).resolves.toBe(true);
        expect(saveAudioBlob).not.toHaveBeenCalled();
        await expect(getCachedSongAudioBlob(legacyNeteaseSong, 'lossless')).resolves.toBeNull();
    });
    it('does not reuse legacy or lower-quality bytes for an explicitly requested tier', async () => {
        const blob = new Blob(['standard']);
        vi.mocked(getCachedAudioBlob).mockImplementation(async key => key === 'audio_online:netease:42:quality:high' ? null : blob);
        vi.mocked(hasCachedAudio).mockImplementation(async key => key !== 'audio_online:netease:42:quality:high');
        await expect(getCachedSongAudioBlob(legacyNeteaseSong, 'high')).resolves.toBeNull();
        await expect(hasCachedSongAudio(legacyNeteaseSong, 'high')).resolves.toBe(false);
        expect(getCachedAudioBlob).toHaveBeenCalledTimes(1);
        expect(hasCachedAudio).toHaveBeenCalledTimes(1);
        await expect(getCachedSongAudioBlob(legacyNeteaseSong, 'standard')).resolves.toBe(blob);
    });

    it('reads an old lyric key and writes the provider-aware key', async () => {
        const lyric = { lines: [{ fullText: 'legacy' }] };
        vi.mocked(getFromCache).mockImplementation(async key => (
            key === 'lyric_42' ? lyric : null
        ) as any);

        await expect(getSongCacheWithLegacyMigration('lyric', legacyNeteaseSong)).resolves.toEqual(lyric);
        expect(saveToCache).toHaveBeenCalledWith('lyric_online:netease:42', lyric);
    });

    it('reads an old audio key and writes the provider-aware key', async () => {
        const blob = new Blob(['audio'], { type: 'audio/mpeg' });
        vi.mocked(getCachedAudioBlob).mockImplementation(async key => key === 'audio_42' ? blob : null);

        await expect(getCachedSongAudioBlob(legacyNeteaseSong)).resolves.toBe(blob);
        expect(saveAudioBlob).toHaveBeenCalledWith('audio_online:netease:42', blob);
    });

    it('checks current audio cache existence without reading the audio blob', async () => {
        vi.mocked(hasCachedAudio).mockImplementation(async key => key === 'audio_online:netease:42');

        await expect(hasCachedSongAudio(legacyNeteaseSong)).resolves.toBe(true);
        expect(hasCachedAudio).toHaveBeenCalledTimes(1);
        expect(getCachedAudioBlob).not.toHaveBeenCalled();
    });

    it('checks legacy audio cache existence without reading or migrating the audio blob', async () => {
        vi.mocked(hasCachedAudio).mockImplementation(async key => key === 'audio_42');

        await expect(hasCachedSongAudio(legacyNeteaseSong)).resolves.toBe(true);
        expect(hasCachedAudio).toHaveBeenNthCalledWith(1, 'audio_online:netease:42');
        expect(hasCachedAudio).toHaveBeenNthCalledWith(2, 'audio_42');
        expect(getCachedAudioBlob).not.toHaveBeenCalled();
        expect(saveAudioBlob).not.toHaveBeenCalled();
    });
});
