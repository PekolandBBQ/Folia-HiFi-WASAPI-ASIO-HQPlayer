import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { normalizeSpotifyPage, normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';
import { mergeCollectionPage } from '@/library/core/services/onlineCollectionSync';

// Independent review exercises real catalog, rights router, parser, transport and renderer page merge together.
const require = createRequire(import.meta.url);
const { createSpotifyCatalog } = require('../../../electron/spotify/catalog.cjs');
const { createPublicPlaylistMetadata, parsePublicPlaylistMetadata } = require('../../../electron/spotify/publicPlaylistMetadata.cjs');
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/spotify/public-playlist-zutomayo.json', import.meta.url), 'utf8'));
const playlistId = '5ZAFjUGN7Wsip8May2qDuq';
const apiTrackId = 'A'.repeat(22);
const userId = 'review-account';
const entity = (data: any) => data.props.pageProps.state.data.entity;
const apiRow = { id: apiTrackId, uri: `spotify:track:${apiTrackId}`, name: 'Official API row', type: 'track', artists: [], album: {} };
const apiResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const embedResponse = (id = playlistId, transform?: (value: any) => void) => {
    const data = structuredClone(fixture.nextData);
    Object.assign(entity(data), { id, uri: `spotify:playlist:${id}` });
    transform?.(data);
    return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`, { headers: { 'content-type': 'text/html' } });
};

// All requests stay in memory; the authenticated and anonymous options are inspected separately.
function integratedHarness() {
    let time = 0, itemStatus = 403, detailStatus = 403, token: string | null = 'IN_MEMORY_TEST_TOKEN';
    let profile: unknown = { id: userId };
    let playlists: any[] = [{ id: playlistId, type: 'playlist', name: 'API collection', public: true, collaborative: false,
        owner: { id: 'different-account' }, items: { total: 999 } }];
    let embed: (id: string) => Promise<Response> = async id => embedResponse(id);
    const fetcher = vi.fn(async (input: string, options: RequestInit) => {
        const url = new URL(input);
        if (url.origin === 'https://open.spotify.com') return embed(url.pathname.split('/').at(-1)!);
        if (url.origin !== 'https://api.spotify.com') throw new Error('Unexpected host');
        if (url.pathname === '/v1/me') return apiResponse(profile);
        if (url.pathname === '/v1/me/playlists') {
            const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
            return apiResponse({ items: playlists.slice(offset, offset + limit), total: playlists.length, next: offset + limit < playlists.length ? 'https://evil.invalid/never-follow' : null });
        }
        if (url.pathname === '/v1/me/tracks') return apiResponse({ items: [{ track: apiRow }], total: 2, next: Number(url.searchParams.get('offset')) === 0 ? 'https://evil.invalid/never-follow' : null });
        if (url.pathname.endsWith('/items')) return apiResponse({ items: [{ item: apiRow }], total: 2, next: Number(url.searchParams.get('offset')) === 0 ? 'https://evil.invalid/never-follow' : null }, itemStatus);
        return apiResponse(playlists.find(row => row.id === url.pathname.split('/').at(-1)) ?? {}, detailStatus);
    });
    const catalog = createSpotifyCatalog({ vault: { token: async () => token }, fetcher, now: () => time,
        cooldown: { load: async () => 0, defer: async () => time + 1000 },
        // Artwork transport is covered independently; this suite isolates playlist eligibility and snapshots.
        publicArtwork: { enrich: async (rows: unknown[]) => rows, clear() {} } });
    return { catalog, fetcher,
        seed: async () => { await catalog.request('status'); await catalog.request('playlists', { limit: 50 }); },
        embed: (value: typeof embed) => { embed = value; }, time: (value: number) => { time = value; },
        itemStatus: (value: number) => { itemStatus = value; }, detailStatus: (value: number) => { detailStatus = value; },
        token: (value: string | null) => { token = value; }, profile: (value: unknown) => { profile = value; },
        playlists: (value: any[]) => { playlists = value; },
        publicCalls: () => fetcher.mock.calls.filter(([url]) => new URL(url).origin === 'https://open.spotify.com') };
}

afterEach(() => vi.useRealTimers());

describe('independent public-playlist end-to-end boundaries', () => {
    it('keeps actual fixture order, repeats and provenance through parsing, catalog paging, normalization and merge', async () => {
        const h = integratedHarness();
        h.embed(async id => embedResponse(id, data => entity(data).trackList.splice(2, 0, structuredClone(entity(data).trackList[0]))));
        await h.seed();
        const expected = entity(structuredClone(fixture.nextData)).trackList.map((row: any) => row.uri);
        expected.splice(2, 0, expected[0]);
        let offset = 0, rows: any[] = [], more = true;
        while (more) {
            const page = normalizeSpotifyPage(await h.catalog.request('playlistTracks', { id: playlistId, offset, limit: 2 }), offset, normalizeSpotifySong, true);
            expect(page.total).toBeUndefined();
            expect(page).toMatchObject({ metadataSource: 'spotify-public-embed', metadataCompleteness: 'partial', loadedCount: 24, preserveDuplicates: true });
            const merged = mergeCollectionPage(rows, offset, page, row => String(row.id));
            rows = merged.items; offset = merged.offset; more = merged.hasMore;
        }
        expect(rows.map(row => row.sourceRef.providerData.uri)).toEqual(expected);
        expect(rows.every(row => row.sourceRef.providerData.originUrl === `https://open.spotify.com/playlist/${playlistId}`)).toBe(true);
        expect(rows.every(row => row.sourceRef.providerData.playbackVerified === false && !('playable' in row.sourceRef.providerData))).toBe(true);
        expect(h.publicCalls()).toHaveLength(1);
        const [, options] = h.publicCalls()[0];
        expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', referrer: '', headers: { Accept: 'text/html' } });
        expect(JSON.stringify(options)).not.toContain('IN_MEMORY_TEST_TOKEN');
    });

    it('keeps owned playlist and Likes pagination on fixed official endpoints even when next is a foreign URL', async () => {
        const h = integratedHarness();
        h.playlists([{ id: playlistId, public: true, collaborative: false, owner: { id: userId }, name: 'Owned' }]);
        await h.seed(); h.itemStatus(200);
        for (const action of ['playlistTracks', 'savedTracks']) for (const offset of [0, 1]) await h.catalog.request(action, { id: playlistId, offset, limit: 1 });
        expect(h.publicCalls()).toHaveLength(0);
        expect(h.fetcher.mock.calls.every(([url]) => new URL(url).origin === 'https://api.spotify.com')).toBe(true);
        expect(h.fetcher.mock.calls.map(([url]) => url)).toContain('https://api.spotify.com/v1/me/tracks?limit=1&offset=1');
        expect(h.fetcher.mock.calls.map(([url]) => url)).toContain(`https://api.spotify.com/v1/playlists/${playlistId}/items?limit=1&offset=1`);
    });

    it.each([401, 429, 500])('never reads a public page after the real catalog handles HTTP %s', async status => {
        const h = integratedHarness(); await h.seed(); h.itemStatus(status);
        await expect(h.catalog.request('playlistTracks', { id: playlistId })).rejects.toBeInstanceOf(Error);
        expect(h.publicCalls()).toHaveLength(0);
    });

    it('does not turn actual inaccessible embed data into a successful empty collection or page', async () => {
        const h = integratedHarness(); await h.seed(); h.embed(async id => embedResponse(id, data => { entity(data).trackList = []; }));
        for (const action of ['playlist', 'playlistTracks']) await expect(h.catalog.request(action, { id: playlistId })).rejects.toMatchObject({ code: 'unavailable' });
        expect(h.publicCalls()).toHaveLength(2);
    });

    it('rejects an expired public continuation and restarts at offset zero through the official API', async () => {
        const h = integratedHarness(); await h.seed(); await h.catalog.request('playlistTracks', { id: playlistId, limit: 1 });
        h.time(60_001); h.itemStatus(200);
        await expect(h.catalog.request('playlistTracks', { id: playlistId, offset: 1, limit: 1 })).rejects.toThrow('public-playlist-restart-required');
        expect(await h.catalog.request('playlistTracks', { id: playlistId, offset: 0, limit: 1 })).toMatchObject({ metadataSource: 'spotify-api' });
        expect(h.publicCalls()).toHaveLength(1);
    });

    it('immediately cancels real delayed embed loading on clear and cannot revive old membership', async () => {
        const h = integratedHarness(); await h.seed();
        let started!: () => void, finish!: (value: Response) => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        h.embed(() => { started(); return new Promise(resolve => { finish = resolve; }); });
        const pending = h.catalog.request('playlistTracks', { id: playlistId });
        const rejected = expect(pending).rejects.toThrow('session-changed');
        await entered; h.catalog.clear(); await rejected; finish(embedResponse());
        await expect(h.catalog.request('playlistTracks', { id: playlistId })).rejects.toThrow('catalog-http-403');
        expect(h.publicCalls()).toHaveLength(1);
    });

    it('fails closed after a later malformed authenticated profile instead of retaining old identity', async () => {
        const h = integratedHarness(); await h.seed(); h.profile({});
        await expect(h.catalog.request('status')).rejects.toMatchObject({ code: 'invalid-response' });
        await expect(h.catalog.request('playlistTracks', { id: playlistId })).rejects.toBeInstanceOf(Error);
        expect(h.publicCalls()).toHaveLength(0);
    });

    it('cannot let a superseded public first page overwrite a newer official pagination session', async () => {
        const h = integratedHarness(); await h.seed();
        let started!: () => void, finish!: (value: Response) => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        h.embed(() => { started(); return new Promise(resolve => { finish = resolve; }); });
        const old = h.catalog.request('playlistTracks', { id: playlistId, limit: 1 });
        const oldResult = old.then((value: unknown) => value, (error: unknown) => error);
        await entered; h.itemStatus(200);
        expect(await h.catalog.request('playlistTracks', { id: playlistId, limit: 1 })).toMatchObject({ metadataSource: 'spotify-api' });
        finish(embedResponse()); await oldResult;
        const next = await h.catalog.request('playlistTracks', { id: playlistId, offset: 1, limit: 1 });
        expect(next).toMatchObject({ metadataSource: 'spotify-api', items: [{ item: { id: apiTrackId } }] });
    });



    it('rejects an old continuation while a newer offset-zero load has not established its source', async () => {
        const h = integratedHarness(); await h.seed(); await h.catalog.request('playlistTracks', { id: playlistId, limit: 1 });
        let started!: () => void, finish!: (value: Response) => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        h.fetcher.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
        const newer = h.catalog.request('playlistTracks', { id: playlistId, limit: 1 });
        await entered;
        await expect(h.catalog.request('playlistTracks', { id: playlistId, offset: 1, limit: 1 })).rejects.toThrow('public-playlist-restart-required');
        finish(apiResponse({ items: [{ item: apiRow }], total: 2, next: 'next' }));
        expect(await newer).toMatchObject({ metadataSource: 'spotify-api' });
    });

    it.each([
        ['removed membership', []],
        ['now private', [{ id: playlistId, name: 'Private', owner: { id: 'different-account' }, public: false, collaborative: false }]],
        ['now owned', [{ id: playlistId, name: 'Owned', owner: { id: userId }, public: true, collaborative: false }]],
        ['now collaborative', [{ id: playlistId, name: 'Collaborative', owner: { id: 'different-account' }, public: true, collaborative: true }]],
        ['unknown rights', [{ id: playlistId, name: 'Unknown', owner: { id: 'different-account' } }]],
    ])('revalidates expired membership and denies fallback for %s', async (_label, currentLibrary) => {
        const h = integratedHarness(); await h.seed(); h.time(300_001); h.playlists(currentLibrary as any[]);
        await expect(h.catalog.request('playlistTracks', { id: playlistId })).rejects.toThrow('catalog-http-403');
        expect(h.publicCalls()).toHaveLength(0);
        expect(h.fetcher.mock.calls.filter(([url]) => new URL(url).pathname === '/v1/me/playlists')).toHaveLength(2);
    });

    it('cancels pending public work when a later authenticated profile belongs to another account', async () => {
        const h = integratedHarness(); await h.seed();
        let started!: () => void, finish!: (value: Response) => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        h.embed(() => { started(); return new Promise(resolve => { finish = resolve; }); });
        const pending = h.catalog.request('playlistTracks', { id: playlistId });
        const rejected = expect(pending).rejects.toThrow('session-changed');
        await entered; h.profile({ id: 'new-account' }); await h.catalog.request('status');
        await rejected; finish(embedResponse());
        await expect(h.catalog.request('playlistTracks', { id: playlistId })).rejects.toThrow('catalog-http-403');
        expect(h.publicCalls()).toHaveLength(1);
    });

    it('cannot resume an evicted public snapshot from an unrelated official API offset', async () => {
        const h = integratedHarness();
        const ids = Array.from({ length: 201 }, (_, index) => String(index).padStart(22, '0'));
        h.playlists(ids.map(id => ({ id, name: 'Listed', owner: { id: 'other-account' }, public: true, collaborative: false })));
        await h.catalog.request('status');
        for (let offset = 0; offset < ids.length; offset += 50) await h.catalog.request('playlists', { offset, limit: 50 });
        for (const id of ids) await h.catalog.request('playlistTracks', { id, limit: 1 });
        h.itemStatus(200);
        await expect(h.catalog.request('playlistTracks', { id: ids[0], offset: 1, limit: 1 })).rejects.toThrow('public-playlist-restart-required');
        // Refreshing library rights must not erase the evicted snapshot's source-of-pages history.
        await h.catalog.request('playlists', { offset: 0, limit: 50 });
        await expect(h.catalog.request('playlistTracks', { id: ids[0], offset: 1, limit: 1 })).rejects.toThrow('public-playlist-restart-required');
    });
});


describe('independent inert-JSON and encoding validation', () => {
    it('does not treat id/type text inside another quoted attribute as a trusted JSON script', () => {
        const html = `<script data-note=' id="__NEXT_DATA__" type="application/json" '>${JSON.stringify(fixture.nextData)}</script>`;
        expect(() => parsePublicPlaylistMetadata(html, playlistId)).toThrow('public-playlist-schema');
    });

    it.each(['textarea', 'style', 'title', 'xmp', 'plaintext', 'template'])('does not treat script-shaped text inside %s as a trusted JSON script', tag => {
        const html = `<${tag}><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(fixture.nextData)}</script></${tag}>`;
        expect(() => parsePublicPlaylistMetadata(html, playlistId)).toThrow('public-playlist-schema');
    });

    it('fails closed on malformed UTF-8 instead of silently replacing user-visible metadata bytes', async () => {
        const bytes = new TextEncoder().encode(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(fixture.nextData)}</script>`);
        const target = new TextEncoder().encode('ZUTOMAYO');
        const position = Buffer.from(bytes).indexOf(Buffer.from(target));
        bytes[position] = 0xc3; bytes[position + 1] = 0x28;
        const api = createPublicPlaylistMetadata({ fetcher: async () => new Response(bytes, { headers: { 'content-type': 'text/html' } }) });
        await expect(api.get(playlistId)).rejects.toThrow('public-playlist-schema');
    });
});


describe('independent anonymous concurrency bound', () => {
    it('caps distinct in-flight requests while retaining same-ID sharing and prompt cancellation', async () => {
        const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
        const api = createPublicPlaylistMetadata({ fetcher });
        const ids = Array.from({ length: 21 }, (_, index) => String(index).padStart(22, '0'));
        const active = ids.slice(0, 20).map(id => api.get(id).then((value: unknown) => value, (error: unknown) => error));
        const shared = api.get(ids[0]).then((value: unknown) => value, (error: unknown) => error);
        try {
            await expect(api.get(ids[20])).rejects.toThrow('public-playlist-limit');
            expect(fetcher).toHaveBeenCalledTimes(20);
        } finally { api.clear(); }
        for (const value of await Promise.all([...active, shared])) expect(value).toMatchObject({ code: 'unavailable', message: 'Spotify: public-playlist-cancelled' });
    });
});
