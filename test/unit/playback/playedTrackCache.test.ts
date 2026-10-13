import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '../../../src/types';
import { rememberAudioSourceQuality } from '../../../src/services/onlineMusic/audioSourceQuality';

const hasCachedSongAudio = vi.fn<(song: SongResult) => Promise<boolean>>();
const hasCachedSongCover = vi.fn<(song: SongResult) => Promise<boolean>>();
const saveAudioBlob = vi.fn<(key: string, blob: Blob) => Promise<void>>();
const saveToCache = vi.fn<(key: string, value: unknown) => Promise<void>>();

vi.mock('../../../src/services/onlineMusic/resourceCache', () => ({
    hasCachedSongAudio: (song: SongResult) => hasCachedSongAudio(song),
    hasCachedSongCover: (song: SongResult) => hasCachedSongCover(song),
}));
vi.mock('../../../src/services/audioCache', () => ({
    saveAudioBlob: (key: string, blob: Blob) => saveAudioBlob(key, blob),
}));
vi.mock('../../../src/services/db', () => ({
    saveToCache: (key: string, value: unknown) => saveToCache(key, value),
}));

const { cachePlayedTrackAssets } = await import('../../../src/services/playedTrackCache');

// The audio and cover caches are pruned under separate categories, so every combination of
// "one present, the other missing" is a state ordinary use reaches. Each resource has to be asked
// about on its own: chaining them is what left a track whose audio was still cached unable to ever
// get its cover back.
describe('cachePlayedTrackAssets', () => {
    const onlineSong = {
        id: '1',
        name: 'Song',
        sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' },
        album: { coverUrl: 'https://cdn.example/cover.jpg' },
    } as unknown as SongResult;

    const localSong = {
        id: 'local-1',
        name: 'Local Song',
        sourceRef: { kind: 'local', mediaId: 'local-1' },
        album: { coverUrl: 'https://cdn.example/matched-cover.jpg' },
    } as unknown as SongResult;

    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        hasCachedSongAudio.mockResolvedValue(false);
        hasCachedSongCover.mockResolvedValue(false);
        saveAudioBlob.mockResolvedValue(undefined);
        saveToCache.mockResolvedValue(undefined);
        vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['x']) })));
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    it('stores both when neither is cached', async () => {
        const written = await cachePlayedTrackAssets(onlineSong, 'https://cdn.example/audio.mp3');

        expect(written).toEqual({ audio: true, cover: true });
        expect(saveAudioBlob).toHaveBeenCalledTimes(1);
        expect(saveToCache).toHaveBeenCalledTimes(1);
    });
    it('saves under the actual source tier rather than whichever preference is now selected', async () => {
        const url = 'https://cdn.example/resolved-standard.mp3';
        rememberAudioSourceQuality(onlineSong, { url, fetchedAt: Date.now(), quality: 'standard' });
        await cachePlayedTrackAssets(onlineSong, url);
        expect(saveAudioBlob).toHaveBeenCalledWith('audio_online:netease:1:quality:standard', expect.any(Blob));
    });
    it('keeps unknown-quality bytes unlabelled even when a higher tier was requested', async () => {
        const url = 'https://cdn.example/unknown-tier.mp3';
        rememberAudioSourceQuality(onlineSong, { url, fetchedAt: Date.now(), requestedQuality: 'hires' });
        await cachePlayedTrackAssets(onlineSong, url);
        expect(saveAudioBlob).toHaveBeenCalledWith('audio_online:netease:1', expect.any(Blob));
    });

    // The P15 case: the cover was pruned while the audio survived, and the cover has to come back
    // without waiting for the audio to go missing too.
    it('refills a missing cover while the audio is still cached', async () => {
        hasCachedSongAudio.mockResolvedValue(true);

        const written = await cachePlayedTrackAssets(onlineSong, 'https://cdn.example/audio.mp3');

        expect(written).toEqual({ audio: false, cover: true });
        expect(saveAudioBlob).not.toHaveBeenCalled();
        expect(saveToCache).toHaveBeenCalledTimes(1);
    });

    // Playing from cache renders a blob: URL. There is nothing to refetch for the audio, but that
    // says nothing about the cover - which is exactly what the old single early return assumed.
    it('still caches the cover when playback runs off a blob source', async () => {
        hasCachedSongAudio.mockResolvedValue(true);

        const written = await cachePlayedTrackAssets(onlineSong, 'blob:whatever');

        expect(written).toEqual({ audio: false, cover: true });
        expect(saveToCache).toHaveBeenCalledTimes(1);
    });

    it('stores the audio alone when the cover is already cached', async () => {
        hasCachedSongCover.mockResolvedValue(true);

        const written = await cachePlayedTrackAssets(onlineSong, 'https://cdn.example/audio.mp3');

        expect(written).toEqual({ audio: true, cover: false });
        expect(saveToCache).not.toHaveBeenCalled();
    });

    // A cover that is already cached reaches this as the app's own blob: URL for it. Refetching that
    // and writing it back is what the old code did on every play.
    it('ignores a blob cover URL', async () => {
        const written = await cachePlayedTrackAssets(onlineSong, 'https://cdn.example/audio.mp3', 'blob:cover');

        expect(written).toEqual({ audio: true, cover: false });
        expect(saveToCache).not.toHaveBeenCalled();
    });

    // A local song's cover has its own `cover_local_<id>` entry written by the library path. Storing
    // a matched online cover here would land under `cover_local:<id>`, which nothing reads.
    it('does not store a cover for a local song', async () => {
        const written = await cachePlayedTrackAssets(localSong, 'blob:local-file');

        expect(written).toEqual({ audio: false, cover: false });
        expect(saveToCache).not.toHaveBeenCalled();
    });

    it('reports nothing written when a download fails', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        vi.spyOn(console, 'error').mockImplementation(() => { });

        const written = await cachePlayedTrackAssets(onlineSong, 'https://cdn.example/audio.mp3');

        expect(written).toEqual({ audio: false, cover: false });
        expect(saveAudioBlob).not.toHaveBeenCalled();
        expect(saveToCache).not.toHaveBeenCalled();
    });
    it('saves the already downloaded native original instead of refetching the remote song', async () => {
        hasCachedSongCover.mockResolvedValue(true);
        const url = `http://127.0.0.1:43820/${'a'.repeat(48)}.wav`, request = vi.fn(async () => ({ url }));
        vi.stubGlobal('window', { electron: { nativeAudio: { supported: true, request } } });
        expect(await cachePlayedTrackAssets(onlineSong, 'https://cdn.example/audio.mp3')).toEqual({ audio: true, cover: false });
        expect(request).toHaveBeenCalledWith({ action: 'cached-source', url: 'https://cdn.example/audio.mp3', trackKey: 'online:netease:1' });
        expect(fetch).toHaveBeenCalledExactlyOnceWith(url); expect(saveAudioBlob).toHaveBeenCalledOnce();
    });
    it('falls back after an expired native handle and never persistently caches a Spotify session source', async () => {
        hasCachedSongCover.mockResolvedValue(true);
        const local = `http://127.0.0.1:43820/${'a'.repeat(48)}.wav`, request = vi.fn(async () => ({ url: local }));
        vi.stubGlobal('window', { electron: { nativeAudio: { supported: true, request } } });
        vi.stubGlobal('fetch', vi.fn(async url => url === local ? new Response('', { status: 404 }) : new Response('audio')));
        await cachePlayedTrackAssets(onlineSong, 'https://cdn.example/audio.mp3');
        expect(fetch).toHaveBeenCalledTimes(2); expect(saveAudioBlob).toHaveBeenCalledOnce();
        vi.clearAllMocks();
        const spotify = { ...onlineSong, sourceRef: { kind: 'online', providerId: 'spotify', mediaId: '1', providerData: { sessionBoundAudio: true } } } as SongResult;
        expect(await cachePlayedTrackAssets(spotify, 'http://127.0.0.1/spotify')).toEqual({ audio: false, cover: false });
        expect(fetch).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(saveAudioBlob).not.toHaveBeenCalled();
    });
});
