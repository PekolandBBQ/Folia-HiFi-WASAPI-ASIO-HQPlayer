import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSpotifyPage, normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';

// Independent end-to-end artwork review: actual catalog, router, parser, artwork service and normalizer.
// All HTTP responses are synthetic in-memory fixtures; no accounts, credentials, cookies or audio are used.
const require = createRequire(import.meta.url);
const { createSpotifyCatalog } = require('../../../electron/spotify/catalog.cjs');
const { parsePublicTrackArtwork, createPublicTrackArtwork, PUBLIC_ARTWORK_LIMITS } = require('../../../electron/spotify/publicTrackArtwork.cjs');
afterEach(() => vi.useRealTimers());
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/spotify/public-playlist-zutomayo.json', import.meta.url), 'utf8'));
const playlist = '5ZAFjUGN7Wsip8May2qDuq', user = 'test-owner';
const idFrom = (input: string) => new URL(new URL(input).searchParams.get('url')!).pathname.split('/').at(-1)!;
const artFor = (id: string) => 'https://i.scdn.co/image/' + createHash('sha256').update(id).digest('hex').slice(0, 40);
const publicArt = (id: string) => ({ provider_name: 'Spotify', provider_url: 'https://spotify.com', type: 'rich',
    iframe_url: `https://open.spotify.com/embed/track/${id}?utm_source=oembed`, thumbnail_url: artFor(id) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function harness(owned = false) {
    let thumbnail: (id: string) => Promise<Response> = async id => json(publicArt(id));
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        if (url.origin === 'https://open.spotify.com' && url.pathname === '/oembed') return thumbnail(idFrom(input));
        if (url.origin === 'https://open.spotify.com' && url.pathname === `/embed/playlist/${playlist}`)
            return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(fixture.nextData)}</script>`, { headers: { 'content-type': 'text/html' } });
        if (url.origin !== 'https://api.spotify.com') throw new Error('Unexpected request origin');
        if (url.pathname === '/v1/me') return json({ id: user });
        if (url.pathname === '/v1/me/playlists') return json({ items: [{ id: playlist, type: 'playlist', public: true, collaborative: false, owner: { id: owned ? user : 'someone-else' }, name: 'Saved collection' }], next: null });
        if (url.pathname === '/v1/me/tracks' || owned) return json({ items: [{ track: { id: 'x'.repeat(22), type: 'track', name: 'API song', duration_ms: 1, artists: [], album: { images: [{ url: 'https://api-artwork.example.test/original.jpg' }] } } }], next: null });
        return json({}, 403);
    });
    const catalog = createSpotifyCatalog({ vault: { token: async () => 'IN_MEMORY_TEST_AUTH' }, fetcher, cooldown: { load: async () => 0, defer: async () => 0 } });
    return { catalog, fetcher, thumbnail: (next: typeof thumbnail) => { thumbnail = next; }, seed: async () => { await catalog.request('status'); await catalog.request('playlists', { limit: 50 }); } };
}

describe('independent artwork security and regression boundaries', () => {
    it('round-trips per-track identity, ordering and official artwork provenance through all four production layers', async () => {
        const h = harness(); await h.seed();
        const raw = await h.catalog.request('playlistTracks', { id: playlist, limit: 50, offset: 0 });
        const normalized = normalizeSpotifyPage(raw, 0, normalizeSpotifySong, true);
        const expected = fixture.nextData.props.pageProps.state.data.entity.trackList.map((track: any) => track.uri.split(':').at(-1));
        expect(normalized.items.map(track => track.id)).toEqual(expected);
        for (const track of normalized.items) {
            expect(track.album.coverUrl).toBe(artFor(String(track.id)));
            expect(track.sourceRef).toMatchObject({ kind: 'online', providerId: 'spotify', providerData: { artworkStatus: 'available', artworkSource: 'spotify-oembed', playbackVerified: false } });
            expect(track.sourceRef?.kind === 'online' && 'playable' in (track.sourceRef.providerData || {})).toBe(false);
        }
        const artCalls = h.fetcher.mock.calls.filter(([url]) => url.includes('/oembed?'));
        expect(artCalls).toHaveLength(new Set(expected).size);
        for (const [url, options] of artCalls) {
            expect(url).toBe(`https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/track/' + idFrom(url))}`);
            expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', referrer: '', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
            expect(JSON.stringify(options)).not.toMatch(/IN_MEMORY_TEST_AUTH|authorization|cookie/i);
        }
    });
    it('keeps owned playlist and Likes artwork on unchanged authenticated API path', async () => {
        const h = harness(true); await h.seed();
        for (const action of ['playlistTracks', 'savedTracks']) {
            const page = normalizeSpotifyPage(await h.catalog.request(action, { id: playlist, limit: 50, offset: 0 }), 0, normalizeSpotifySong, true);
            expect(page.items[0].album.coverUrl).toBe('https://api-artwork.example.test/original.jpg');
        }
        expect(h.fetcher.mock.calls.every(([url]) => new URL(url).origin === 'https://api.spotify.com')).toBe(true);
    });
    it('rejects swapped track identity yet retains list rows with explicit unavailable state', async () => {
        const h = harness(); h.thumbnail(async () => json(publicArt('0'.repeat(22)))); await h.seed();
        const page = normalizeSpotifyPage(await h.catalog.request('playlistTracks', { id: playlist, limit: 50, offset: 0 }), 0, normalizeSpotifySong, true);
        expect(page.items).toHaveLength(23);
        expect(page.items.every(track => !track.album.coverUrl && track.sourceRef?.kind === 'online' && track.sourceRef.providerData?.artworkStatus === 'unavailable')).toBe(true);
    });
    it('never delivers delayed public art after clearing its authenticated catalog session', async () => {
        const h = harness(); let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        h.thumbnail(async () => { started(); return new Promise<Response>(() => {}); }); await h.seed();
        const pending = h.catalog.request('playlistTracks', { id: playlist, limit: 50, offset: 0 });
        const result = expect(pending).rejects.toThrow('session-changed');
        await entered; h.catalog.clear(); await result;
    });
    it('rejects URL normalization tricks and foreign-host thumbnail exfiltration candidates', () => {
        const id = 'a'.repeat(22), valid = publicArt(id);
        const malicious = [artFor(id).replace('i.scdn.co', 'i.scdn.co.evil.test'), artFor(id).replace('https:', 'http:'),
            artFor(id).replace('https://', 'https://user:secret@'), artFor(id) + '?token=secret', artFor(id) + '#x',
            artFor(id).replace('/image/', '/image/../image/'), artFor(id).replace('i.scdn.co', 'i.scdn.co:443'),
            'data:image/svg+xml,<svg onload="alert(1)">', '//i.scdn.co/image/' + 'a'.repeat(40)];
        for (const thumbnail_url of malicious) expect(parsePublicTrackArtwork({ ...valid, thumbnail_url }, id)).toEqual({ status: 'unavailable' });
    });
});


describe('independent revised timing and exact-host boundaries', () => {
    it('admits all 23 observed official thumbnails, including exactly seven ak-host rows', () => {
        const observed = JSON.parse(readFileSync(new URL('../../fixtures/spotify/public-track-oembed-zutomayo-23.json', import.meta.url), 'utf8'));
        expect(observed.tracks).toHaveLength(23);
        expect(observed.tracks.filter((track: any) => new URL(track.publicFields.thumbnail_url).hostname === 'image-cdn-ak.spotifycdn.com')).toHaveLength(7);
        for (const track of observed.tracks) {
            const parsed = parsePublicTrackArtwork(track.publicFields, track.requestedTrackId);
            expect(parsed.status).toBe('available');
            const normalized = normalizeSpotifySong({ id: track.requestedTrackId, name: track.publicFields.title, metadataSource: 'spotify-public-embed',
                artworkSource: parsed.source, artworkStatus: parsed.status, album: { images: [{ url: parsed.url }] } });
            expect(normalized.album.coverUrl).toBe(track.publicFields.thumbnail_url);
        }
    });
    it('pins bounded 8s requests / 20s pages / six slots without expanding other limits', () => {
        expect(PUBLIC_ARTWORK_LIMITS).toEqual({ bodyBytes: 32768, chunks: 128, timeoutMs: 8000, pageBudgetMs: 20000,
            pageTracks: 50, parallel: 6, pending: 100, cacheEntries: 500 });
        expect(Object.isFrozen(PUBLIC_ARTWORK_LIMITS)).toBe(true);
    });
    it('returns partial after hard deadline and one warm refresh fills missing rows without stale result mutation', async () => {
        vi.useFakeTimers(); let active = 0, peak = 0;
        const fetcher = vi.fn((url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
            active++; peak = Math.max(peak, active);
            const abort = () => { clearTimeout(timer); active--; reject(new DOMException('Cancelled', 'AbortError')); };
            const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); active--; resolve(json(publicArt(idFrom(url)))); }, 7000);
            options.signal?.addEventListener('abort', abort, { once: true });
        }));
        const rows = Array.from({ length: 23 }, (_, i) => ({ id: String(i).padStart(22, 'a') }));
        const service = createPublicTrackArtwork({ fetcher });
        const first = service.enrich(rows); await vi.advanceTimersByTimeAsync(20001); const partial = await first;
        expect(partial.filter((row: any) => row.artwork.status === 'available')).toHaveLength(12);
        expect(partial).toHaveLength(23); expect(peak).toBe(6); expect(active).toBe(0); expect(fetcher).toHaveBeenCalledTimes(18);
        const next = service.enrich(rows); await vi.advanceTimersByTimeAsync(14001); const recovered = await next;
        expect(recovered.every((row: any) => row.artwork.status === 'available')).toBe(true);
        expect(partial.filter((row: any) => row.artwork.status === 'available')).toHaveLength(12);
        expect(active).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });
});
