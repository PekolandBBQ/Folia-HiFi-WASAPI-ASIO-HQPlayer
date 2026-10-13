import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { normalizeSpotifyCollection, normalizeSpotifyPage, normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';
const { createSpotifyCatalog } = createRequire(import.meta.url)('../../../electron/spotify/catalog.cjs');

// Controlled API and public-page fixtures. No credentials or requests reach a live service.
const id = '0123456789012345678901';
const trackId = '1123456789012345678901';
const track = { id: trackId, type: 'track', uri: `spotify:track:${trackId}`, name: 'API song', artists: [], album: {} };
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, headers: new Headers(), json: async () => body });
const playlist = { id, type: 'playlist', name: 'Followed', owner: { id: 'other-account', display_name: 'Same display name' },
    public: true, collaborative: false, items: { total: 999 } };
function fixture(override: Record<string, unknown> = {}) {
    let time = 0, detailStatus = 200, itemsStatus = 403, profile = 'my-account';
    const rawPlaylist = { ...playlist, ...override };
    const snapshot = { id, name: 'Public title', uri: `spotify:playlist:${id}`, source: 'public_embed', sourceUrl: `https://open.spotify.com/embed/playlist/${id}`, playlistUrl: `https://open.spotify.com/playlist/${id}`,
        tracks: [0, 1, 2].map(() => ({ id: trackId, uri: `spotify:track:${trackId}`, title: 'Public song', subtitle: 'Artist', durationMs: 123000 as number | null,
            sourceUrl: `https://open.spotify.com/track/${trackId}` })), total: null, complete: false, partial: true, fetchedAt: 0 };
    const publicMetadata = { get: vi.fn(async () => snapshot), clear: vi.fn() };
    const fetcher = vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === '/v1/me') return response({ id: profile, display_name: 'Same display name' });
        if (path === '/v1/me/playlists') return response({ items: [rawPlaylist], total: 1, next: null });
        if (path === '/v1/me/tracks') return response({ items: [{ track }], total: 1, next: null });
        if (path.endsWith('/items')) return response({ items: [{ item: track }], total: 2, next: 'next' }, itemsStatus);
        return response(rawPlaylist, detailStatus);
    });
    const vault = { token: vi.fn(async (): Promise<string | null> => 'test-token') };
    const publicArtwork = { enrich: vi.fn(async (rows: unknown[]) => rows), clear: vi.fn() };
    const api = createSpotifyCatalog({ vault, fetcher, publicMetadata, publicArtwork, now: () => time });
    return { api, fetcher, publicMetadata, publicArtwork, snapshot, rawPlaylist, vault,
        seed: async () => { await api.request('status'); await api.request('playlists'); },
        time: (value: number) => { time = value; }, itemsStatus: (value: number) => { itemsStatus = value; },
        detailStatus: (value: number) => { detailStatus = value; }, profile: (value: string) => { profile = value; } };
}

describe('Spotify main-process playlist metadata routing', () => {
    it('keeps successful official APIs and pagination primary, including own playlists and Likes', async () => {
        const f = fixture({ owner: { id: 'my-account' } }); await f.seed(); f.itemsStatus(200);
        const detail = await f.api.request('playlist', { id });
        expect(detail).toMatchObject({ isOwned: true, metadataSource: 'spotify-api' });
        await f.api.request('playlistTracks', { id, limit: 1, offset: 0 });
        await f.api.request('playlistTracks', { id, limit: 1, offset: 1 });
        await f.api.request('savedTracks', { limit: 50, offset: 0 });
        expect(f.fetcher.mock.calls.map(([url]) => url)).toContain(`https://api.spotify.com/v1/playlists/${id}/items?limit=1&offset=1`);
        expect(f.fetcher.mock.calls.map(([url]) => url)).toContain('https://api.spotify.com/v1/me/tracks?limit=50&offset=0');
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('uses trusted library facts through detail 403, without losing duplicate rows or inventing a total', async () => {
        const f = fixture(); await f.seed(); f.detailStatus(403);
        const detail = normalizeSpotifyCollection(await f.api.request('playlist', { id }));
        expect(detail).toMatchObject({ name: 'Public title', metadataSource: 'spotify-public-embed', metadataCompleteness: 'partial', loadedCount: 3, isOwned: false, sourceUrl: `https://open.spotify.com/playlist/${id}` });
        expect(detail.trackCount).toBeUndefined();
        const first = normalizeSpotifyPage(await f.api.request('playlistTracks', { id, limit: 2, offset: 0 }), 0, normalizeSpotifySong, true);
        const calls = f.fetcher.mock.calls.length;
        const last = normalizeSpotifyPage(await f.api.request('playlistTracks', { id, limit: 2, offset: 2 }), 2, normalizeSpotifySong, true);
        expect(f.fetcher).toHaveBeenCalledTimes(calls);
        expect(first.items.map(song => song.id)).toEqual([trackId, trackId]);
        expect(first).toMatchObject({ hasMore: true, nextOffset: 2, preserveDuplicates: true, metadataCompleteness: 'partial' });
        expect(last).toMatchObject({ hasMore: false, nextOffset: 3, metadataCompleteness: 'partial' });
        expect(first.total).toBeUndefined();
        expect(first.items[0].sourceRef).toMatchObject({ providerId: 'spotify', mediaId: trackId,
            providerData: { uri: `spotify:track:${trackId}`, metadataSource: 'spotify-public-embed', playbackVerified: false,
                originUrl: `https://open.spotify.com/playlist/${id}`, metadataUrl: `https://open.spotify.com/embed/playlist/${id}` } });
        expect(first.items[0].sourceRef?.kind === 'online' && first.items[0].sourceRef.providerData?.playable).toBeUndefined();
    });

    it('keeps absent public duration unknown through the full provider normalization boundary', async () => {
        const f = fixture(); await f.seed(); f.snapshot.tracks[0].durationMs = null;
        const page = normalizeSpotifyPage(await f.api.request('playlistTracks', { id }), 0, normalizeSpotifySong, true);
        expect(page.items[0].sourceRef).toMatchObject({ providerData: { durationKnown: false } });
        expect(page.items[1].sourceRef).toMatchObject({ providerData: { durationKnown: true } });
        expect(page.items[1].durationMs).toBe(123000);
    });

    it.each([
        { owner: { id: 'my-account', display_name: 'Different name' } }, { owner: { display_name: 'Someone else' } },
        { owner: null }, { public: false }, { public: null }, { public: undefined },
        { collaborative: true }, { collaborative: undefined },
    ])('fails closed for owned/private/collaborative/unknown rights: %j', async override => {
        const f = fixture(override); await f.seed();
        await expect(f.api.request('playlistTracks', { id })).rejects.toMatchObject({ code: 'unsupported', httpStatus: 403 });
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('requires authenticated observed membership, never renderer-supplied ownership hints', async () => {
        const f = fixture();
        await f.api.request('status'); await f.api.request('playlist', { id });
        await expect(f.api.request('playlistTracks', { id, public: true, isOwned: false, owner: { id: 'other-account' } })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('reads the authenticated API profile when only the library was loaded', async () => {
        const f = fixture(); await f.api.request('playlists');
        await f.api.request('playlistTracks', { id });
        expect(f.fetcher.mock.calls.map(([url]) => url)).toContain('https://api.spotify.com/v1/me');
        expect(f.publicMetadata.get).toHaveBeenCalledWith(id);
    });

    it.each([401, 404, 429, 500])('never falls back on HTTP %s', async status => {
        const f = fixture(); await f.seed(); f.itemsStatus(status);
        await expect(f.api.request('playlistTracks', { id })).rejects.toBeInstanceOf(Error);
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('does not treat a network error with a 403-looking string as a typed denial', async () => {
        const f = fixture(); await f.seed();
        f.fetcher.mockRejectedValueOnce(new Error('Spotify: catalog-http-403'));
        await expect(f.api.request('playlistTracks', { id })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('does not splice embed rows after an official first page', async () => {
        const f = fixture(); await f.seed(); f.itemsStatus(200);
        expect(await f.api.request('playlistTracks', { id, offset: 0, limit: 1 })).toMatchObject({ metadataSource: 'spotify-api' });
        f.itemsStatus(403);
        await expect(f.api.request('playlistTracks', { id, offset: 1, limit: 1 })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('requires a restart if the same public snapshot expires mid-pagination', async () => {
        const f = fixture(); await f.seed(); await f.api.request('playlistTracks', { id, limit: 1 });
        f.time(60001);
        await expect(f.api.request('playlistTracks', { id, limit: 1, offset: 1 })).rejects.toThrow('public-playlist-restart-required');
        expect(f.publicMetadata.get).toHaveBeenCalledTimes(1);
    });

    it('invalidates eligibility when later API metadata contradicts the library record', async () => {
        const f = fixture(); await f.seed(); await f.api.request('playlistTracks', { id, limit: 1 });
        f.rawPlaylist.public = false;
        await f.api.request('playlist', { id });
        await expect(f.api.request('playlistTracks', { id, limit: 1, offset: 1 })).rejects.toThrow('public-playlist-restart-required');
        await expect(f.api.request('playlistTracks', { id, offset: 0 })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).toHaveBeenCalledTimes(1);
    });

    it('retains an in-progress public page when detail returns the same trusted rights', async () => {
        const f = fixture(); await f.seed(); await f.api.request('playlistTracks', { id, limit: 1 });
        await f.api.request('playlist', { id });
        expect(await f.api.request('playlistTracks', { id, limit: 1, offset: 1 })).toMatchObject({ metadataSource: 'spotify-public-embed' });
        expect(f.publicMetadata.get).toHaveBeenCalledTimes(1);
    });

    it('revokes an existing public snapshot after any catalog authentication loss', async () => {
        const f = fixture(); await f.seed(); await f.api.request('playlistTracks', { id, limit: 1 });
        f.fetcher.mockResolvedValueOnce(response({}, 401));
        await expect(f.api.request('song', { id: trackId })).rejects.toThrow('catalog-http-401');
        await expect(f.api.request('playlistTracks', { id, offset: 1 })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.clear).toHaveBeenCalledOnce();
        expect(f.publicArtwork.clear).toHaveBeenCalledOnce();
        expect(f.publicMetadata.get).toHaveBeenCalledTimes(1);
    });

    it('cannot continue public pages after the session token disappears or refresh fails', async () => {
        const f = fixture(); await f.seed(); await f.api.request('playlistTracks', { id, limit: 1 });
        f.vault.token.mockResolvedValueOnce(null);
        await expect(f.api.request('playlistTracks', { id, offset: 1 })).rejects.toMatchObject({ code: 'auth-required' });
        expect(f.publicMetadata.clear).toHaveBeenCalledOnce();
        expect(f.publicArtwork.clear).toHaveBeenCalledOnce();
        await f.seed(); await f.api.request('playlistTracks', { id, limit: 1 });
        f.vault.token.mockRejectedValueOnce(Object.assign(new Error('Spotify: refresh-failed'), { code: 'auth-required' }));
        await expect(f.api.request('playlistTracks', { id, offset: 1 })).rejects.toMatchObject({ code: 'auth-required' });
        expect(f.publicMetadata.clear).toHaveBeenCalledTimes(2);
    });

    it('retains early library membership when more than 200 playlists are paged', async () => {
        const f = fixture(); await f.seed();
        const later = Array.from({ length: 210 }, (_, index) => ({ ...playlist, id: String(index).padStart(22, '2') }));
        f.fetcher.mockResolvedValueOnce(response({ items: later, total: 211, next: null }));
        await f.api.request('playlists', { offset: 1, limit: 50 });
        expect(await f.api.request('playlistTracks', { id })).toMatchObject({ metadataSource: 'spotify-public-embed' });
    });

    it('revalidates expired known membership through official library pages before falling back', async () => {
        const f = fixture(); await f.seed(); f.time(300001);
        const other = { ...playlist, id: '2222222222222222222222' };
        f.fetcher.mockResolvedValueOnce(response({}, 403))
            .mockResolvedValueOnce(response({ items: [other], next: 'https://untrusted.invalid/do-not-follow' }))
            .mockResolvedValueOnce(response({ items: [playlist], next: null }));
        expect(await f.api.request('playlistTracks', { id })).toMatchObject({ metadataSource: 'spotify-public-embed' });
        expect(f.fetcher.mock.calls.slice(-3).map(([url]) => url)).toEqual([
            `https://api.spotify.com/v1/playlists/${id}/items?limit=20&offset=0`,
            'https://api.spotify.com/v1/me/playlists?limit=50&offset=0',
            'https://api.spotify.com/v1/me/playlists?limit=50&offset=50',
        ]);
    });

    it('does not reuse expired membership after unfollowing or losing visibility', async () => {
        const f = fixture(); await f.seed(); f.time(300001);
        f.fetcher.mockResolvedValueOnce(response({}, 403)).mockResolvedValueOnce(response({ items: [], next: null }));
        await expect(f.api.request('playlistTracks', { id })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it.each([401, 429, 500])('propagates HTTP%s during expired membership revalidation', async status => {
        const f = fixture(); await f.seed(); f.time(300001);
        f.fetcher.mockResolvedValueOnce(response({}, 403)).mockResolvedValueOnce(response({}, status));
        await expect(f.api.request('playlistTracks', { id })).rejects.toBeInstanceOf(Error);
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('retries the official API on a new offset-zero load', async () => {
        const f = fixture(); await f.seed(); await f.api.request('playlistTracks', { id });
        f.itemsStatus(200);
        expect(await f.api.request('playlistTracks', { id, offset: 0 })).toMatchObject({ metadataSource: 'spotify-api' });
        expect(f.publicMetadata.get).toHaveBeenCalledTimes(1);
    });

    it('never treats an old API total as proof that the embed snapshot is complete', async () => {
        const f = fixture({ items: { total: 3 } }); await f.seed();
        const raw = await f.api.request('playlistTracks', { id });
        expect(raw).toMatchObject({ metadataCompleteness: 'partial', loadedCount: 3 });
        expect(raw.total).toBeUndefined();
    });

    it('rejects delayed public responses after clear and clears both caches', async () => {
        const f = fixture(); await f.seed();
        let finish!: (value: typeof f.snapshot) => void, entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        f.publicMetadata.get.mockImplementationOnce(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
        const pending = f.api.request('playlistTracks', { id });
        const rejected = expect(pending).rejects.toThrow('session-changed');
        await started; f.api.clear(); finish(f.snapshot); await rejected;
        expect(f.publicMetadata.clear).toHaveBeenCalledOnce();
        expect(f.publicArtwork.clear).toHaveBeenCalledOnce();
        await expect(f.api.request('playlistTracks', { id })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).toHaveBeenCalledTimes(1);
    });

    it('fails closed after an invalid authenticated profile response', async () => {
        const f = fixture(); await f.seed();
        f.fetcher.mockResolvedValueOnce(response({ display_name: 'Same display name' }));
        await expect(f.api.request('status')).rejects.toThrow('invalid-profile');
        await expect(f.api.request('playlistTracks', { id })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });

    it('drops previous library membership if the authenticated profile changes', async () => {
        const f = fixture(); await f.seed(); f.profile('different-account'); await f.api.request('status');
        await expect(f.api.request('playlistTracks', { id })).rejects.toThrow('catalog-http-403');
        expect(f.publicMetadata.get).not.toHaveBeenCalled();
        expect(f.publicArtwork.enrich).not.toHaveBeenCalled();
    });
});
