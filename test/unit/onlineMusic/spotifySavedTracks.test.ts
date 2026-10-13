import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n/config';
import { OnlineProviderError } from '@/types/onlineMusic';
import { createSpotifyLikedCollection, normalizeSpotifyCollection, SPOTIFY_LIKED_COLLECTION_ID } from '@/services/onlineMusic/spotifyNormalize';

// test/unit/onlineMusic/spotifySavedTracks.test.ts — public saved-track fixtures; no live Spotify requests.
const fixture = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/services/onlineMusic/spotifyTransport', () => ({ requestSpotify: fixture.request, spotifyAvailable: () => true }));
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';

const song = (index: number) => ({ id: String(index).padStart(22, '0'), name: `Saved ${index}`, type: 'track', artists: [], album: {} });
beforeEach(async () => { fixture.request.mockReset(); await i18n.changeLanguage('en'); });

describe('Spotify Liked Songs public library resource', () => {
    it('reads 60 saved songs across two pages without depending on playlist listing', async () => {
        fixture.request.mockImplementation(async ({ action, limit, offset }) => {
            expect(action).toBe('savedTracks');
            return { items: Array.from({ length: Math.min(limit, 60 - offset) }, (_, index) => ({ track: song(index + offset) })),
                total: 60, next: offset + limit < 60 ? 'next' : null };
        });
        const ids = await spotifyProvider.library!.getLikedSongIds!('synthetic-account');
        expect(ids).toHaveLength(60);
        expect(ids.at(-1)).toBe(song(59).id);
        expect(fixture.request.mock.calls.map(([request]) => request.offset)).toEqual([0, 50]);
    });

    it('continues through filtered-only pages and retains valid later saved songs', async () => {
        fixture.request.mockImplementation(async ({ offset }) => offset === 0
            ? { items: Array(50).fill({ track: null }), total: 51, next: 'next' }
            : { items: [{ track: song(50) }], total: 51, next: null });
        const songs = await spotifyProvider.library!.getLikedSongs!('synthetic-account');
        expect(songs.map(song => song.id)).toEqual([song(50).id]);
        expect(fixture.request.mock.calls.map(([request]) => request.offset)).toEqual([0, 50]);
    });

    it('does not report a partially loaded saved library as complete after the second page fails', async () => {
        fixture.request.mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, index) => ({ track: song(index) })), total: 60, next: 'next' })
            .mockRejectedValueOnce(new OnlineProviderError('network', 'Spotify: request-failed', 'spotify'));
        await expect(spotifyProvider.library!.getLikedSongIds!('synthetic-account')).rejects.toMatchObject({ code: 'network' });
        expect(fixture.request.mock.calls.map(([request]) => request.offset)).toEqual([0, 50]);
    });

    it('routes virtual collection detail and track pages to savedTracks and preserves snapshot normalization', async () => {
        fixture.request.mockResolvedValue({ items: [{ track: song(1) }], total: 60, next: null });
        const collection = createSpotifyLikedCollection(60);
        expect(normalizeSpotifyCollection(collection)).toBe(collection);
        expect(collection).toMatchObject({ providerId: 'spotify', name: 'Liked Songs', isLiked: true, trackCount: 60 });
        expect(await spotifyProvider.catalog!.getPlaylistDetail!(SPOTIFY_LIKED_COLLECTION_ID)).toMatchObject({ trackCount: 60 });
        const page = await spotifyProvider.catalog!.getPlaylistTracks!(SPOTIFY_LIKED_COLLECTION_ID, 50, 50);
        expect(page.items[0].id).toBe(song(1).id);
        expect(fixture.request.mock.calls.map(([request]) => request)).toEqual([
            { action: 'savedTracks', limit: 1, offset: 0 }, { action: 'savedTracks', limit: 50, offset: 50 },
        ]);
        expect(spotifyProvider.capabilities.mutations).toBe(false);
    });

    it('distinguishes playlist access denial from saved-tracks permission without relabeling authentication', async () => {
        fixture.request.mockRejectedValue(new OnlineProviderError('unsupported', 'Spotify: catalog-http-403', 'spotify'));
        await expect(spotifyProvider.catalog!.getPlaylistTracks!(song(1).id, 50, 0)).rejects.toMatchObject({
            code: 'unsupported', message: 'Access to this playlist’s contents is restricted (Spotify 403).',
        });
        await expect(spotifyProvider.catalog!.getPlaylistTracks!(SPOTIFY_LIKED_COLLECTION_ID, 50, 0)).rejects.toThrow('Access to Liked Songs is restricted (Spotify 403).');
        const error = new OnlineProviderError('auth-required', 'Spotify: catalog-http-401', 'spotify');
        fixture.request.mockRejectedValue(error);
        await expect(spotifyProvider.library!.getLikedSongs!('synthetic-account')).rejects.toBe(error);
    });

    it('does not treat readable playlist metadata as permission to read its contents', async () => {
        fixture.request.mockImplementation(async ({ action }) => {
            if (action === 'playlist') return { id: song(1).id, name: 'Followed playlist', owner: { id: 'another-owner' },
                collaborative: false, tracks: { total: 23 } };
            throw new OnlineProviderError('unsupported', 'Spotify: catalog-http-403', 'spotify');
        });
        await expect(spotifyProvider.catalog!.getPlaylistDetail!(song(1).id)).resolves.toMatchObject({ name: 'Followed playlist', trackCount: 23 });
        await expect(spotifyProvider.catalog!.getPlaylistTracks!(song(1).id, 50, 0)).rejects.toThrow('contents is restricted');
    });
});
