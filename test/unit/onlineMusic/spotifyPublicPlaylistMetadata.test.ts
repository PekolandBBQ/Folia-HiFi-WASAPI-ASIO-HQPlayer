import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { createPublicPlaylistMetadata, parsePublicPlaylistMetadata, publicPlaylistId, PUBLIC_PLAYLIST_CACHE_TTL_MS,
  PUBLIC_PLAYLIST_LIMITS } = createRequire(import.meta.url)('../../../electron/spotify/publicPlaylistMetadata.cjs');

// Official fixture contains whitelisted public metadata only; all network tests use local Response objects.
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/spotify/public-playlist-zutomayo.json', import.meta.url), 'utf8'));
const id = '5ZAFjUGN7Wsip8May2qDuq', secondId = 'A'.repeat(22);
const data = () => structuredClone(fixture.nextData);
const entity = (value: any) => value.props.pageProps.state.data.entity;
const html = (value = data()) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(value)}</script></html>`;
const response = (body = html(), status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
afterEach(() => vi.useRealTimers());

describe('strict public Spotify embed parser', () => {
  it('retains the actual 23 official rows and metadata without claiming an authoritative total', () => {
    const result = parsePublicPlaylistMetadata(html(), id, { fetchedAt: 123 });
    expect(result).toMatchObject({ id, name: entity(data()).name, total: null, complete: false, partial: true,
      source: 'public_embed', sourceUrl: fixture.sourceUrl, receivedCount: 23, omittedCount: 0, fetchedAt: 123,
      partialReasons: ['unknown-total'] });
    expect(result.tracks).toHaveLength(23);
    expect(result.tracks.map((track: any) => [track.uri, track.title, track.subtitle, track.durationMs]))
      .toEqual(entity(data()).trackList.map((track: any) => [track.uri, track.title, track.subtitle, track.duration]));
    expect(result.tracks[0]).toMatchObject({ id: '0m5ZpQtTjdoH4eXeygFRFZ', title: '形', subtitle: 'ZUTOMAYO', durationMs: 200100,
      sourceUrl: 'https://open.spotify.com/track/0m5ZpQtTjdoH4eXeygFRFZ' });
    expect(result.tracks[22].title).toBe('メディアノーチェ');
  });
  it('preserves duplicates and positions rather than deduplicating the playlist', () => {
    const input = data(), first = entity(input).trackList[0];
    entity(input).trackList.splice(1, 0, structuredClone(first));
    const result = parsePublicPlaylistMetadata(html(input), id);
    expect(result.tracks).toHaveLength(24);
    expect(result.tracks.slice(0, 2).map((track: any) => track.uri)).toEqual([first.uri, first.uri]);
    expect(result.tracks.map((track: any) => track.position)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });
  it('does not infer completeness from unknown total-like fields or length', () => {
    const input = data(); Object.assign(entity(input), { total: 23, totalTracks: 23, trackCount: 23, trackListTotal: 23 });
    expect(parsePublicPlaylistMetadata(html(input), id)).toMatchObject({ total: null, complete: false, partial: true });
  });
  it.each([
    ['missing entity', () => ({ props: { pageProps: { state: {} } } }), 'unavailable'],
    ['null entity', () => ({ props: { pageProps: { state: { data: { entity: null } } } } }), 'unavailable'],
    ['unknown root schema', () => ({ props: {} }), 'schema'],
    ['different ID', () => { const v = data(); entity(v).id = secondId; return v; }, 'schema'],
    ['different URI', () => { const v = data(); entity(v).uri = `spotify:playlist:${secondId}`; return v; }, 'schema'],
    ['different type', () => { const v = data(); entity(v).type = 'album'; return v; }, 'schema'],
    ['private', () => { const v = data(); entity(v).isPrivate = true; return v; }, 'unavailable'],
    ['non-public', () => { const v = data(); entity(v).isPublic = false; return v; }, 'unavailable'],
    ['unavailable', () => { const v = data(); entity(v).isUnavailable = true; return v; }, 'unavailable'],
    ['missing rows', () => { const v = data(); delete entity(v).trackList; return v; }, 'schema'],
    ['empty rows', () => { const v = data(); entity(v).trackList = []; return v; }, 'unavailable'],
    ['all invalid rows', () => { const v = data(); entity(v).trackList = [null, {}]; return v; }, 'schema'],
  ])('rejects %s rather than returning an empty/deleted playlist', (_label, make, reason) => {
    expect(() => parsePublicPlaylistMetadata(html(make()), id)).toThrow(`public-playlist-${reason}`);
  });
  it('marks null, local, episode, malformed and capped rows visibly incomplete', () => {
    const input = data(), first = entity(input).trackList[0];
    entity(input).trackList = [first, null, { ...first, uri: 'spotify:local:anything' },
      { ...first, entityType: 'episode' }, { ...first, uri: 'javascript:alert(1)' }, first];
    const result = parsePublicPlaylistMetadata(html(input), id);
    expect(result.tracks.map((track: any) => track.position)).toEqual([0, 5]);
    expect(result).toMatchObject({ omittedCount: 4, partial: true, partialReasons: ['unknown-total', 'invalid-items'] });
    entity(input).trackList = Array.from({ length: PUBLIC_PLAYLIST_LIMITS.tracks + 1 }, () => first);
    expect(parsePublicPlaylistMetadata(html(input), id)).toMatchObject({ omittedCount: 1, partial: true,
      partialReasons: ['unknown-total', 'truncated'] });
    expect(parsePublicPlaylistMetadata(html(input), id).tracks).toHaveLength(PUBLIC_PLAYLIST_LIMITS.tracks);
  });
  it('reports missing duration honestly and does not reinterpret embed preview playability', () => {
    const input = data(); delete entity(input).trackList[0].duration; entity(input).trackList[0].isPlayable = true;
    const result = parsePublicPlaylistMetadata(html(input), id);
    expect(result.tracks[0].durationMs).toBeNull();
    expect(result.tracks[0]).not.toHaveProperty('isPlayable');
    expect(result.partialReasons).toContain('incomplete-track-metadata');
  });
  it('reads inert JSON only, rejects duplicate/type-swapped scripts, and drops all unrelated fields', () => {
    const input = data(); input.props.pageProps.accessToken = 'SECRET_TOKEN';
    entity(input).trackList[0].audioPreview = { url: 'https://example.com/private-preview' };
    entity(input).coverArt.sources.push({ url: 'https://evil.example/image' }, { url: 'http://i.scdn.co/insecure' });
    const executable = '<script>globalThis.publicPlaylistExecuted = true; throw new Error("SECRET_SCRIPT")</script>';
    const result = parsePublicPlaylistMetadata(executable + html(input), id);
    expect((globalThis as any).publicPlaylistExecuted).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|audioPreview|private-preview|evil\.example|insecure/);
    expect(result.owner).toBeNull();
    expect(result.images).toHaveLength(1);
    expect(() => parsePublicPlaylistMetadata(html() + html(), id)).toThrow('public-playlist-schema');
    expect(() => parsePublicPlaylistMetadata(html().replace('application/json', 'text/javascript'), id)).toThrow('public-playlist-schema');
    expect(() => parsePublicPlaylistMetadata(html().replace('type=', 'src="https://example.com/" type='), id)).toThrow('public-playlist-schema');
    expect(() => parsePublicPlaylistMetadata('<script id="__NEXT_DATA__" type="application/json">not JSON SECRET</script>', id)).toThrow('public-playlist-schema');
    expect(() => parsePublicPlaylistMetadata(`<!--${html()}-->`, id)).toThrow('public-playlist-schema');
  });
  it('recognizes actual HTML attributes rather than matching attribute-like quoted text', () => {
    const json = JSON.stringify(data());
    const fake = `<script data-note=' id="__NEXT_DATA__" type="application/json" '>${json}</script>`;
    expect(() => parsePublicPlaylistMetadata(fake, id)).toThrow('public-playlist-schema');
    expect(() => parsePublicPlaylistMetadata(html().replace('id="__NEXT_DATA__"', 'id="__NEXT_DATA__" id="other"'), id))
      .toThrow('public-playlist-schema');
    // Attribute ordering, whitespace, quotes, character references, and a literal > remain valid HTML.
    const valid = `<script data-note=">" type='application/json' id='&#95;_NEXT_DATA__'>${json}</script>`;
    expect(parsePublicPlaylistMetadata(valid, id).tracks).toHaveLength(23);
  });
  it.each(['textarea', 'title', 'style', 'xmp', 'plaintext', 'noscript', 'iframe', 'noembed', 'noframes', 'template', 'svg', 'math'])
  ('ignores apparent JSON scripts inside %s contexts', context => {
    expect(() => parsePublicPlaylistMetadata(`<${context}>${html()}</${context}>`, id)).toThrow('public-playlist-schema');
  });
  it('bounds tree allocation and nesting while parsing HTML', () => {
    expect(() => parsePublicPlaylistMetadata('<i></i>'.repeat(PUBLIC_PLAYLIST_LIMITS.htmlNodes) + html(), id))
      .toThrow('public-playlist-limit');
    expect(() => parsePublicPlaylistMetadata('<div>'.repeat(PUBLIC_PLAYLIST_LIMITS.htmlDepth + 1) + html(), id))
      .toThrow('public-playlist-limit');
  });
  it('enforces body-byte bounds including UTF-8 multibyte content', () => {
    expect(() => parsePublicPlaylistMetadata('あ'.repeat(Math.ceil(PUBLIC_PLAYLIST_LIMITS.bodyBytes / 3)), id)).toThrow('public-playlist-limit');
  });
});

describe('anonymous bounded public embed transport', () => {
  it.each([id, `https://open.spotify.com/playlist/${id}?si=discard-me#fragment`, `https://open.spotify.com/embed/playlist/${id}/`])
  ('constructs the fixed endpoint without auth or caller-supplied URL parameters from %s', async input => {
    const fetcher = vi.fn().mockResolvedValue(response());
    await createPublicPlaylistMetadata({ fetcher }).get(input);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(fixture.sourceUrl);
    expect(options).toMatchObject({ method: 'GET', headers: { Accept: 'text/html' }, credentials: 'omit',
      redirect: 'error', referrer: '', referrerPolicy: 'no-referrer' });
    expect(Object.keys(options.headers)).toEqual(['Accept']);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['http://open.spotify.com/playlist/', 'https://open.spotify.com.evil.test/playlist/',
    'https://evil.test/playlist/', 'https://user:pass@open.spotify.com/playlist/', 'https://open.spotify.com:444/playlist/',
    'https://open.spotify.com/album/', 'https://open.spotify.com/other/../playlist/', 'https://open.spotify.com//playlist/'])
  ('rejects noncanonical input %s without fetching', async prefix => {
    const fetcher = vi.fn();
    await expect(createPublicPlaylistMetadata({ fetcher }).get(prefix + id)).rejects.toThrow('public-playlist-invalid-url');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['../me', 'short', 'spotify:playlist:' + id, 'https://open.spotify.com/playlist/%35ZAFjUGN7Wsip8May2qDuq',
    `https://open.spotify.com\\evil.test/playlist/${id}`, `https://open.spotify.com/playlist/${id}/tracks`, id + '\n'])
  ('rejects malformed reference %s', input => expect(() => publicPlaylistId(input)).toThrow('public-playlist-invalid-url'));
  it('rejects redirected responses and unexpected final URLs while discarding their bodies', async () => {
    for (const changes of [{ redirected: true }, { url: 'https://evil.example/result' }]) {
      const body = response(); Object.entries(changes).forEach(([key, value]) => Object.defineProperty(body, key, { value }));
      await expect(createPublicPlaylistMetadata({ fetcher: async () => body }).get(id)).rejects.toThrow('public-playlist-redirect');
      expect(body.bodyUsed).toBe(true);
    }
  });
  it.each([401, 403, 404, 429, 500])('sanitizes HTTP %d and never caches failure', async status => {
    const fetcher = vi.fn().mockImplementationOnce(() => response('SECRET upstream body', status)).mockImplementation(() => response());
    const api = createPublicPlaylistMetadata({ fetcher });
    await expect(api.get(id)).rejects.toMatchObject({ code: status < 429 ? 'unavailable' : 'network' });
    expect((await api.get(id)).tracks).toHaveLength(23);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sanitizes thrown network details and rejects schema instead of empty data', async () => {
    await expect(createPublicPlaylistMetadata({ fetcher: async () => { throw new Error('SECRET cookie token'); } }).get(id))
      .rejects.toMatchObject({ code: 'network', message: 'Spotify: public-playlist-network' });
    await expect(createPublicPlaylistMetadata({ fetcher: async () => response('SECRET non-JSON') }).get(id))
      .rejects.toMatchObject({ code: 'invalid-response', message: 'Spotify: public-playlist-schema' });
  });
  it('rejects oversized declared and streamed bodies, wrong content type, and non-streaming responses', async () => {
    const oversized = 'x'.repeat(PUBLIC_PLAYLIST_LIMITS.bodyBytes + 1);
    for (const body of [response('', 200, { 'content-length': String(oversized.length) }), response(oversized)]) {
      await expect(createPublicPlaylistMetadata({ fetcher: async () => body }).get(id)).rejects.toThrow('public-playlist-limit');
    }
    await expect(createPublicPlaylistMetadata({ fetcher: async () => response(html(), 200, { 'content-type': 'application/json' }) }).get(id))
      .rejects.toThrow('public-playlist-schema');
    await expect(createPublicPlaylistMetadata({ fetcher: async () => ({ ok: true, headers: new Headers(), text: () => html() }) }).get(id))
      .rejects.toThrow('public-playlist-schema');
  });
  it('cancels oversized declared bodies before reading and bounds zero-byte chunks', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(0)); }, cancel });
    await expect(createPublicPlaylistMetadata({ fetcher: async () => new Response(stream, { headers: { 'content-type': 'text/html' } }) }).get(id))
      .rejects.toThrow('public-playlist-limit');
    expect(cancel).toHaveBeenCalled();
    const declaredCancel = vi.fn();
    const declared = new ReadableStream({ cancel: declaredCancel });
    await expect(createPublicPlaylistMetadata({ fetcher: async () => new Response(declared, { headers: {
      'content-type': 'text/html', 'content-length': String(PUBLIC_PLAYLIST_LIMITS.bodyBytes + 1) } }) }).get(id))
      .rejects.toThrow('public-playlist-limit');
    expect(declaredCancel).toHaveBeenCalled();
  });
  it('bounds even a fetcher that ignores cancellation by a timeout', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<(url: string, options: any) => Promise<Response>>(() => new Promise(() => {}));
    const request = createPublicPlaylistMetadata({ fetcher, timeoutMs: 10 }).get(id);
    const rejected = expect(request).rejects.toMatchObject({ code: 'network', message: 'Spotify: public-playlist-timeout' });
    await vi.advanceTimersByTimeAsync(11); await rejected;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('bounds a stalled response body and cancels its stream', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<html>')); }, cancel });
    const request = createPublicPlaylistMetadata({ fetcher: async () => new Response(body, { headers: { 'content-type': 'text/html' } }), timeoutMs: 10 }).get(id);
    const rejected = expect(request).rejects.toThrow('public-playlist-timeout');
    await vi.advanceTimersByTimeAsync(11); await rejected; expect(cancel).toHaveBeenCalled();
  });
  it('shares requests, isolates mutable callers, expires successes and does not persist across instances', async () => {
    let now = 0; const fetcher = vi.fn().mockImplementation(() => response());
    const api = createPublicPlaylistMetadata({ fetcher, now: () => now });
    const [first, second] = await Promise.all([api.get(id), api.get(id)]);
    first.tracks.length = 0;
    expect(second.tracks).toHaveLength(23); expect((await api.get(id)).tracks).toHaveLength(23);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += PUBLIC_PLAYLIST_CACHE_TTL_MS + 1; await api.get(id); expect(fetcher).toHaveBeenCalledTimes(2);
    await createPublicPlaylistMetadata({ fetcher }).get(id); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('clear immediately rejects pending work and prevents late stale responses from repopulating cache', async () => {
    let finish!: (result: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(() => response());
    const api = createPublicPlaylistMetadata({ fetcher });
    const pending = api.get(id), rejected = expect(pending).rejects.toThrow('public-playlist-cancelled');
    api.clear(); await rejected;
    await api.get(id); finish(response()); await Promise.resolve();
    expect((await api.get(id)).tracks).toHaveLength(23); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    api.clear(); await api.get(id); expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
