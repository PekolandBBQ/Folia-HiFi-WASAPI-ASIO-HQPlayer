import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { normalizeSpotifyPage, normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';
const require = createRequire(import.meta.url);
const { createPublicTrackArtwork, parsePublicTrackArtwork, PUBLIC_ARTWORK_LIMITS, PUBLIC_ARTWORK_TTL_MS,
    PUBLIC_ARTWORK_MISSING_TTL_MS } = require('../../../electron/spotify/publicTrackArtwork.cjs');
const { createSpotifyCatalog } = require('../../../electron/spotify/catalog.cjs');

// test/unit/onlineMusic/spotifyPublicTrackArtwork.test.ts — official fixture, all requests mocked in memory.
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/spotify/public-track-oembed.json', import.meta.url), 'utf8'));
const allTrackFixture = JSON.parse(readFileSync(new URL('../../fixtures/spotify/public-track-oembed-zutomayo-23.json', import.meta.url), 'utf8'));
const playlistFixture = JSON.parse(readFileSync(new URL('../../fixtures/spotify/public-playlist-zutomayo.json', import.meta.url), 'utf8'));
const id = fixture.requestedTrackId, otherId = 'a'.repeat(22), playlistId = '5ZAFjUGN7Wsip8May2qDuq';
const payload = (trackId = id) => ({ ...fixture.publicFields, iframe_url: `https://open.spotify.com/embed/track/${trackId}?utm_source=oembed` });
const jsonResponse = (data: unknown = payload(), status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const trackIdInUrl = (input: string) => new URL(new URL(input).searchParams.get('url')!).pathname.split('/').at(-1)!;
const row = (trackId = id) => ({ id: trackId, title: trackId });
const unavailable = { artwork: { status: 'unavailable' } };
afterEach(() => vi.useRealTimers());

describe('official per-track oEmbed artwork validation', () => {
    it('accepts the actual observed thumbnail and exact iframe identity, ignoring HTML and unrelated fields', () => {
        const value = parsePublicTrackArtwork({ ...payload(), html: '<script>throw new Error("never execute")</script>', access_token: 'SECRET' }, id);
        expect(value).toEqual({ status: 'available', source: 'spotify-oembed', url: fixture.publicFields.thumbnail_url, sourceUrl: fixture.sourceUrl });
        expect(JSON.stringify(value)).not.toMatch(/SECRET|script|html/);
        expect(parsePublicTrackArtwork({ ...payload(), iframe_url: `https://open.spotify.com/embed/track/${id}` }, id).status).toBe('available');
        expect(parsePublicTrackArtwork({ ...payload(), thumbnail_url: 'https://i.scdn.co/image/' + 'a'.repeat(40) }, id).status).toBe('available');
    });
    it('accepts all 23 real sanitized oEmbed responses, including seven exact ak CDN thumbnails', () => {
        const parsed = allTrackFixture.tracks.map((entry: any) => parsePublicTrackArtwork(entry.publicFields, entry.requestedTrackId));
        expect(parsed).toHaveLength(23);
        expect(parsed.every((entry: any) => entry.status === 'available')).toBe(true);
        expect(parsed.filter((entry: any) => new URL(entry.url).hostname === 'image-cdn-ak.spotifycdn.com')).toHaveLength(7);
        for (const [index, artwork] of parsed.entries()) {
            const track = allTrackFixture.tracks[index];
            const song = normalizeSpotifySong({ id: track.requestedTrackId, name: track.publicFields.title, metadataSource: 'spotify-public-embed',
                artworkStatus: artwork.status, artworkSource: artwork.source, album: { images: [{ url: artwork.url }] } });
            expect(song.album?.coverUrl).toBe(track.publicFields.thumbnail_url);
        }
    });
    it.each([
        `https://open.spotify.com/embed/track/${otherId}?utm_source=oembed`,
        `https://open.spotify.com/embed/playlist/${id}?utm_source=oembed`,
        `http://open.spotify.com/embed/track/${id}`, `https://open.spotify.com.evil.test/embed/track/${id}`,
        `https://user@open.spotify.com/embed/track/${id}`, `https://open.spotify.com:443/embed/track/${id}`,
        `https://open.spotify.com/embed/track/${id}?utm_source=other`, `https://open.spotify.com/embed/track/${id}?utm_source=oembed&x=1`,
        `https://open.spotify.com/embed/track/${id}#x`, ` https://open.spotify.com/embed/track/${id}`,
        `https://open.spotify.com/embed/album/../track/${id}`, `https://open.spotify.com/embed/track/${id}/`,
    ])('rejects non-exact iframe identity: %s', iframe_url => {
        expect(parsePublicTrackArtwork({ ...payload(), iframe_url }, id)).toEqual({ status: 'unavailable' });
    });
    it.each([
        'https://evil.spotifycdn.com/image/' + 'a'.repeat(40), 'https://evil.image-cdn-ak.spotifycdn.com/image/' + 'a'.repeat(40), 'https://image-cdn-fa.spotifycdn.com.evil.test/image/' + 'a'.repeat(40),
        'http://i.scdn.co/image/' + 'a'.repeat(40), 'https://i.scdn.co/image/' + 'a'.repeat(40) + '?token=x',
        'https://i.scdn.co/image/' + 'a'.repeat(40) + '#x', 'https://i.scdn.co/image/../image/' + 'a'.repeat(40),
        'https://i.scdn.co:443/image/' + 'a'.repeat(40), 'https://user@i.scdn.co/image/' + 'a'.repeat(40),
        'https://mosaic.scdn.co/640/' + 'a'.repeat(40), 'data:image/png;base64,abc', 'https://i.scdn.co/image/abc',
    ])('rejects non-allowlisted thumbnail: %s', thumbnail_url => {
        expect(parsePublicTrackArtwork({ ...payload(), thumbnail_url }, id)).toEqual({ status: 'unavailable' });
    });
    it.each([{ iframe_url: undefined }, { thumbnail_url: undefined }, { type: 'photo' }, { provider_name: 'Other' }, { provider_url: 'http://spotify.com' }])
    ('rejects incomplete/mismatched provider metadata %j', change => expect(parsePublicTrackArtwork({ ...payload(), ...change }, id)).toEqual({ status: 'unavailable' }));
});

describe('bounded credential-free artwork service', () => {
    it('uses one fixed request for duplicate IDs and preserves occurrence order and original rows', async () => {
        const fetcher = vi.fn(async (url: string) => jsonResponse(payload(trackIdInUrl(url))));
        const input = [row(id), row(otherId), row(id)], service = createPublicTrackArtwork({ fetcher });
        const result = await service.enrich(input);
        expect(result.map((entry: any) => entry.id)).toEqual([id, otherId, id]);
        expect(result.every((entry: any) => entry.artwork.status === 'available')).toBe(true);
        expect(input.every(entry => !('artwork' in entry))).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[0]).toEqual([fixture.sourceUrl, expect.objectContaining({ method: 'GET', redirect: 'error',
            credentials: 'omit', referrer: '', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) })]);
        result[0].artwork.url = 'https://invalid.test';
        expect((await service.enrich([row()]))[0].artwork.url).toBe(fixture.publicFields.thumbnail_url);
    });
    it('never requests unvalidated track IDs or arbitrary URLs', async () => {
        const fetcher = vi.fn();
        const result = await createPublicTrackArtwork({ fetcher }).enrich(['', `${id}/x`, 'https://evil.test', 'spotify:track:' + id, id + '\n'].map(row));
        expect(fetcher).not.toHaveBeenCalled();
        expect(result.every((entry: any) => entry.artwork.status === 'unavailable')).toBe(true);
    });
    it.each(['redirected', 'url', 'http', 'network', 'wrong-json', 'wrong-type', 'invalid-utf8', 'declared-size', 'actual-size', 'too-many-chunks'])
    ('retains metadata when artwork fails: %s', async kind => {
        let cancelled = false;
        const fetcher = vi.fn(async () => {
            if (kind === 'network') throw new Error('SECRET access token');
            if (kind === 'http') return jsonResponse({}, 503);
            if (kind === 'wrong-json') return new Response('{"thumbnail_url":', { headers: { 'content-type': 'application/json' } });
            if (kind === 'wrong-type') return new Response('<html>no</html>', { headers: { 'content-type': 'text/html' } });
            if (kind === 'invalid-utf8') return new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } });
            if (kind === 'actual-size') return new Response('x'.repeat(PUBLIC_ARTWORK_LIMITS.bodyBytes + 1), { headers: { 'content-type': 'application/json' } });
            if (kind === 'declared-size' || kind === 'too-many-chunks') {
                const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([32])); }, cancel() { cancelled = true; } });
                return new Response(stream, { headers: { 'content-type': 'application/json', ...(kind === 'declared-size' ? { 'content-length': String(PUBLIC_ARTWORK_LIMITS.bodyBytes + 1) } : {}) } });
            }
            const result = jsonResponse();
            Object.defineProperty(result, kind, { value: kind === 'redirected' ? true : 'https://evil.test/changed' });
            return result;
        });
        const result = await createPublicTrackArtwork({ fetcher }).enrich([row()]);
        expect(result).toEqual([{ ...row(), ...unavailable }]);
        if (kind === 'declared-size' || kind === 'too-many-chunks') expect(cancelled).toBe(true);
    });
    it('bounds request and stalled-body timeouts even when a transport ignores abort', async () => {
        vi.useFakeTimers();
        for (const fetcher of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })]) {
            const result = createPublicTrackArtwork({ fetcher, timeoutMs: 10 }).enrich([row()]);
            await vi.advanceTimersByTimeAsync(11);
            expect(await result).toEqual([{ ...row(), ...unavailable }]);
        }
    });
    it('negatively caches request timeouts briefly, without caching page-deadline cancellations', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(() => new Promise(() => {}));
        const service = createPublicTrackArtwork({ fetcher, timeoutMs: 10 });
        const pending = service.enrich([row()]); await vi.advanceTimersByTimeAsync(11); await pending;
        await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(1);
        service.clear();
        const abandoned = createPublicTrackArtwork({ fetcher, timeoutMs: 100, pageBudgetMs: 5 });
        const first = abandoned.enrich([row()]); await vi.advanceTimersByTimeAsync(6); await first;
        const second = abandoned.enrich([row()]); await vi.advanceTimersByTimeAsync(6); await second;
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('releases only the expired page consumer while a shared later page still needs the same track', async () => {
        vi.useFakeTimers(); let finish!: (response: Response) => void;
        const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const service = createPublicTrackArtwork({ fetcher, timeoutMs: 100, pageBudgetMs: 10 });
        const first = service.enrich([row()]); await vi.advanceTimersByTimeAsync(5);
        const second = service.enrich([row()]); await vi.advanceTimersByTimeAsync(6);
        expect(await first).toEqual([{ ...row(), ...unavailable }]);
        finish(jsonResponse());
        expect((await second)[0].artwork.status).toBe('available');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('returns completed artwork at the page deadline, abandons queued work, and never changes returned rows later', async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [], late: Array<() => void> = [];
        const fetcher = vi.fn((url: string, options: RequestInit) => {
            signals.push(options.signal!);
            if (trackIdInUrl(url) === id) return Promise.resolve(jsonResponse());
            return new Promise(resolve => { late.push(() => resolve(jsonResponse(payload(trackIdInUrl(url))))); });
        });
        const rows = [row(), ...Array.from({ length: 22 }, (_, index) => row(String(index).padStart(22, 'a')))];
        const service = createPublicTrackArtwork({ fetcher, timeoutMs: 100, pageBudgetMs: 10 });
        const pending = service.enrich(rows);
        await vi.advanceTimersByTimeAsync(11);
        const result = await pending;
        expect(result).toHaveLength(23);
        expect(result[0].artwork.status).toBe('available');
        expect(result.slice(1).every((value: any) => value.artwork.status === 'unavailable')).toBe(true);
        expect(fetcher.mock.calls.length).toBe(PUBLIC_ARTWORK_LIMITS.parallel + 1);
        expect(signals.slice(1).every(signal => signal.aborted)).toBe(true);
        late.forEach(finish => finish()); await vi.advanceTimersByTimeAsync(1);
        expect(result.slice(1).every((value: any) => value.artwork.status === 'unavailable')).toBe(true);
        expect(fetcher.mock.calls.length).toBe(PUBLIC_ARTWORK_LIMITS.parallel + 1);
    });
    it('caps global parallelism, deduplicates across simultaneous pages and caps per-page total work', async () => {
        vi.useFakeTimers(); let active = 0, peak = 0;
        const fetcher = vi.fn(async (url: string) => { active++; peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 1)); active--; return jsonResponse(payload(trackIdInUrl(url))); });
        const service = createPublicTrackArtwork({ fetcher });
        const input = Array.from({ length: 60 }, (_, index) => row(String(index).padStart(22, 'b')));
        const first = service.enrich(input), duplicate = service.enrich(input);
        await vi.advanceTimersByTimeAsync(100);
        const result = await first; await duplicate;
        expect(peak).toBe(PUBLIC_ARTWORK_LIMITS.parallel);
        expect(fetcher).toHaveBeenCalledTimes(PUBLIC_ARTWORK_LIMITS.pageTracks);
        expect(result).toHaveLength(60);
        expect(result.slice(50).every((value: any) => value.artwork.status === 'unavailable')).toBe(true);
    });
    it('bounds total queued work across simultaneous pages', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(() => new Promise(() => {}));
        const service = createPublicTrackArtwork({ fetcher, timeoutMs: 100, pageBudgetMs: 10 });
        const pages = Array.from({ length: 5 }, (_, page) => service.enrich(Array.from({ length: 50 }, (_, index) => row(String(page * 50 + index).padStart(22, 'd')))));
        await vi.advanceTimersByTimeAsync(11);
        const results = await Promise.all(pages);
        expect(results.every(page => page.length === 50 && page.every((entry: any) => entry.artwork.status === 'unavailable'))).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(PUBLIC_ARTWORK_LIMITS.parallel);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('fits all 23 recorded cloud metadata durations within the bounded production budget', async () => {
        vi.useFakeTimers(); let active = 0, peak = 0;
        const signals: AbortSignal[] = [];
        const actual = new Map<string, any>(allTrackFixture.tracks.map((entry: any) => [entry.requestedTrackId, entry]));
        const fetcher = vi.fn(async (url: string, options: RequestInit) => {
            const entry = actual.get(trackIdInUrl(url)); active++; peak = Math.max(peak, active); signals.push(options.signal!);
            await new Promise(resolve => setTimeout(resolve, entry.observedCloudRequestElapsedMs)); active--;
            return jsonResponse(entry.publicFields);
        });
        const service = createPublicTrackArtwork({ fetcher });
        const rows = allTrackFixture.tracks.map((entry: any) => row(entry.requestedTrackId));
        const pending = service.enrich(rows);
        // Deterministic replay of recorded cloud delays, not a Windows timing guarantee.
        await vi.advanceTimersByTimeAsync(16746);
        const result = await pending;
        expect(PUBLIC_ARTWORK_LIMITS).toMatchObject({ parallel: 6, timeoutMs: 8000, pageBudgetMs: 20000 });
        expect(result.map((entry: any) => entry.id)).toEqual(rows.map((entry: any) => entry.id));
        expect(result.every((entry: any) => entry.artwork.status === 'available')).toBe(true);
        expect(peak).toBe(6); expect(fetcher).toHaveBeenCalledTimes(23);
        expect(signals.every(signal => !signal.aborted)).toBe(true);
        const cached = await service.enrich(rows);
        expect(cached.every((entry: any) => entry.artwork.status === 'available')).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(23);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('hard-stops a larger slow page at 20 seconds with useful partial results and no background continuation', async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        const fetcher = vi.fn((url: string, options: RequestInit) => {
            signals.push(options.signal!);
            return trackIdInUrl(url) === id ? Promise.resolve(jsonResponse()) : new Promise(() => {});
        });
        const rows = [row(), ...Array.from({ length: 49 }, (_, index) => row(String(index).padStart(22, 'e')))];
        const pending = createPublicTrackArtwork({ fetcher }).enrich(rows);
        await vi.advanceTimersByTimeAsync(20001);
        const result = await pending;
        expect(result).toHaveLength(50); expect(result[0].artwork.status).toBe('available');
        expect(result.slice(1).every((entry: any) => entry.artwork.status === 'unavailable')).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(19);
        expect(signals.slice(1).every(signal => signal.aborted)).toBe(true);
        await vi.advanceTimersByTimeAsync(80000);
        expect(fetcher).toHaveBeenCalledTimes(19); expect(vi.getTimerCount()).toBe(0);
    });
    it('uses short memory-only success and missing caches and clears them on account change', async () => {
        let time = 0;
        const fetcher = vi.fn(async () => jsonResponse());
        const service = createPublicTrackArtwork({ fetcher, now: () => time });
        await service.enrich([row()]); await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(1);
        time += PUBLIC_ARTWORK_TTL_MS + 1; await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(2);
        service.clear(); await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(3);
        fetcher.mockImplementation(async () => jsonResponse({}, 404)); service.clear();
        await service.enrich([row()]); await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(4);
        time += PUBLIC_ARTWORK_MISSING_TTL_MS + 1; await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(5);
    });
    it('does not reuse or cache late responses after account clear', async () => {
        let finish!: (value: Response) => void;
        const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(async () => jsonResponse());
        const service = createPublicTrackArtwork({ fetcher });
        const pending = service.enrich([row()]); service.clear();
        expect(await pending).toEqual([{ ...row(), ...unavailable }]);
        finish(jsonResponse());
        expect((await service.enrich([row()]))[0].artwork.status).toBe('available');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('honors 429 cooldown, stops queued requests and never retries or fails the list', async () => {
        let time = 0;
        const fetcher = vi.fn(async () => jsonResponse({}, 429, { 'retry-after': '60' }));
        const service = createPublicTrackArtwork({ fetcher, now: () => time });
        const result = await service.enrich(Array.from({ length: 23 }, (_, index) => row(String(index).padStart(22, 'c'))));
        expect(result).toHaveLength(23); expect(result.every((value: any) => value.artwork.status === 'unavailable')).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(PUBLIC_ARTWORK_LIMITS.parallel);
        await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(PUBLIC_ARTWORK_LIMITS.parallel);
        time = 60001; await service.enrich([row()]); expect(fetcher).toHaveBeenCalledTimes(PUBLIC_ARTWORK_LIMITS.parallel + 1);
    });
});

describe('public artwork through catalog and provider normalization', () => {
    function harness(publicArtwork?: unknown) {
        let itemStatus = 403;
        const collection = { id: playlistId, name: 'Public list', type: 'playlist', public: true, collaborative: false, owner: { id: 'another-account' }, images: [{ url: 'https://i.scdn.co/image/' + 'b'.repeat(40) }] };
        const data = structuredClone(playlistFixture.nextData);
        data.props.pageProps.state.data.entity.trackList.splice(1, 0, structuredClone(data.props.pageProps.state.data.entity.trackList[0]));
        const fetcher = vi.fn(async (input: string) => {
            const url = new URL(input);
            if (url.pathname === '/oembed') return jsonResponse(payload(trackIdInUrl(input)));
            if (url.pathname.startsWith('/embed/playlist/')) return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`, { headers: { 'content-type': 'text/html' } });
            if (url.pathname === '/v1/me') return jsonResponse({ id: 'my-account' });
            if (url.pathname === '/v1/me/playlists') return jsonResponse({ items: [collection], next: null });
            if (url.pathname.endsWith('/items') || url.pathname === '/v1/me/tracks') return jsonResponse({ items: [{ item: { id, name: 'API row', album: { images: [{ url: fixture.publicFields.thumbnail_url }] } } }], total: 1 }, url.pathname.endsWith('/items') ? itemStatus : 200);
            return jsonResponse(collection);
        });
        const api = createSpotifyCatalog({ fetcher, publicArtwork, vault: { token: async () => 'MOCK_TOKEN' }, cooldown: { load: async () => 0 } });
        return { api, fetcher, collection, data, status: (status: number) => { itemStatus = status; }, seed: async () => { await api.request('status'); await api.request('playlists'); } };
    }
    it('enriches all 23 actual public tracks, preserves duplicate rows, source, unknown totals and unverified playback', async () => {
        const h = harness(); await h.seed();
        const raw = await h.api.request('playlistTracks', { id: playlistId, limit: 50 });
        const page = normalizeSpotifyPage(raw, 0, normalizeSpotifySong, true);
        const expected = h.data.props.pageProps.state.data.entity.trackList.map((value: any) => value.uri.split(':')[2]);
        expect(page.items.map(song => song.id)).toEqual(expected); expect(page.items).toHaveLength(24);
        expect(page).toMatchObject({ preserveDuplicates: true, metadataSource: 'spotify-public-embed', loadedCount: 24, metadataCompleteness: 'partial' });
        expect(page.total).toBeUndefined();
        expect(page.items.every(song => song.album?.coverUrl === fixture.publicFields.thumbnail_url)).toBe(true);
        expect(page.items[0].sourceRef).toMatchObject({ providerData: { artworkStatus: 'available', artworkSource: 'spotify-oembed',
            artworkSourceUrl: fixture.sourceUrl, playbackVerified: false, metadataSource: 'spotify-public-embed',
            metadataUrl: `https://open.spotify.com/embed/playlist/${playlistId}`, originUrl: `https://open.spotify.com/playlist/${playlistId}` } });
        const calls = h.fetcher.mock.calls.filter(([url]) => new URL(url).pathname === '/oembed');
        expect(calls).toHaveLength(23);
    });
    it('does not enrich successful API playlists or Likes and retains their API artwork', async () => {
        const h = harness(); h.collection.owner.id = 'my-account'; h.status(200); await h.seed();
        for (const action of ['playlistTracks', 'savedTracks']) {
            const page = normalizeSpotifyPage(await h.api.request(action, { id: playlistId }), 0, normalizeSpotifySong, true);
            expect(page.items[0].album?.coverUrl).toBe(fixture.publicFields.thumbnail_url);
        }
        expect(h.fetcher.mock.calls.every(([url]) => new URL(url).hostname === 'api.spotify.com')).toBe(true);
    });
    it('retains all public rows when enrichment fails unexpectedly', async () => {
        const h = harness({ enrich: async () => { throw new Error('unavailable'); }, clear() {} }); await h.seed();
        const page = normalizeSpotifyPage(await h.api.request('playlistTracks', { id: playlistId, limit: 50 }), 0, normalizeSpotifySong, true);
        expect(page.items).toHaveLength(24);
        expect(page.items.every(song => song.album?.coverUrl === undefined)).toBe(true);
        expect(page.items[0].sourceRef).toMatchObject({ providerData: { artworkStatus: 'unavailable' } });
    });
    it.each(['clear', 'new-load', 'rights-change'])('rejects late artwork after %s without returning stale rows', async change => {
        let finish!: () => void, enter!: () => void;
        const started = new Promise<void>(resolve => { enter = resolve; });
        const publicArtwork = { clear: vi.fn(), enrich: vi.fn().mockImplementationOnce((rows: unknown[]) => {
            enter(); return new Promise(resolve => { finish = () => resolve(rows); });
        }).mockImplementation(async (rows: unknown[]) => rows) };
        const h = harness(publicArtwork); await h.seed();
        const first = h.api.request('playlistTracks', { id: playlistId });
        const rejected = expect(first).rejects.toThrow(change === 'clear' ? 'session-changed' : 'public-playlist-restart-required');
        await started;
        if (change === 'clear') h.api.clear();
        if (change === 'new-load') await h.api.request('playlistTracks', { id: playlistId });
        if (change === 'rights-change') { h.collection.public = false; await h.api.request('playlist', { id: playlistId }); }
        finish(); await rejected;
        if (change === 'clear') expect(publicArtwork.clear).toHaveBeenCalledOnce();
    });
    it('never substitutes a playlist image or marks unchecked public artwork available', () => {
        const raw = { id, name: 'Public song', metadataSource: 'spotify-public-embed', album: { images: [{ url: fixture.publicFields.thumbnail_url }] } };
        const song = normalizeSpotifySong(raw);
        expect(song.album?.coverUrl).toBeUndefined();
        expect(song.sourceRef).toMatchObject({ providerData: { artworkStatus: 'unavailable', playbackVerified: false } });
    });
});
