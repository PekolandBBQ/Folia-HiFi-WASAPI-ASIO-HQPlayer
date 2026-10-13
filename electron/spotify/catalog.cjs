const { spotifyError } = require('./errors.cjs');
const { createCooldown } = require('./cooldown.cjs');
const { reportSpotifyHttp } = require('./requestDiagnostics.cjs');
const { createPlaylistCatalogDiagnostics } = require('./playlistCatalogDiagnostics.cjs');
const { previewPlaylistRef } = require('./playlistDiagnostics.cjs');
const { own } = require('../debug/privatePreviewDiagnosticSchema.cjs');
const { createSpotifyPlaylistRouting } = require('./playlistMetadataRouting.cjs');

// Only fixed Spotify catalog endpoints are reachable; pagination never follows an upstream URL.
function createSpotifyCatalog({ vault, fetcher = fetch, now = Date.now, directory, diagnostic = () => {}, cooldown: sharedCooldown, publicMetadata, publicArtwork, officialMetadata }) {
  let generation = 0, queue = Promise.resolve();
  const cooldown = sharedCooldown || createCooldown({ directory, now });
  const controllers = new Set();
  const playlistDiagnostics = createPlaylistCatalogDiagnostics();
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
  const id = value => { if (!validId(value)) throw spotifyError('invalid-response', 'invalid-id'); return value; };
  const page = input => ({ limit: Math.max(1, Math.min(50, Math.floor(Number(input.limit) || 20))), offset: Math.max(0, Math.min(100000, Math.floor(Number(input.offset) || 0))) });
  function get(endpoint, params = {}, diagnosticEndpoint, diagnosticContext) {
    const expected = generation;
    const task = queue.catch(() => {}).then(() => send(endpoint, params, expected, diagnosticEndpoint, diagnosticContext));
    queue = task;
    return task;
  }
  const playlists = createSpotifyPlaylistRouting({ get, now, onAccountChange: clear, diagnostics: playlistDiagnostics, authenticate: async () => { if (!await token()) throw spotifyError('auth-required'); },
    publicMetadata: publicMetadata || require('./publicPlaylistMetadata.cjs').createPublicPlaylistMetadata({ fetcher, now }),
    publicArtwork: publicArtwork || require('./publicTrackArtwork.cjs').createPublicTrackArtwork({ fetcher, now }) });
  async function send(endpoint, params, expected, diagnosticEndpoint, diagnosticContext) {
    if (expected !== generation) throw spotifyError('auth-required', 'session-changed');
    const retryAt = await cooldown.load();
    if (now() < retryAt) {
      diagnostic({ stage: 'catalog', state: 'cooldown', retryAt });
      throw Object.assign(spotifyError('unavailable', 'rate-limited'), { retryAt });
    }
    const accessToken = await token();
    if (expected !== generation) throw spotifyError('auth-required', 'session-changed');
    if (!accessToken) throw spotifyError('auth-required');
    const metadataReceipt = officialMetadata?.bind();
    // A browse/detail hit reuses only a complete official catalog object after
    // the ordinary queue, cooldown and current-account authorization checks.
    const trackId = /^tracks\/([A-Za-z0-9]{22})$/.exec(endpoint)?.[1];
    const cached = trackId && metadataReceipt && officialMetadata.get(trackId, metadataReceipt);
    if (cached?.metadata) return structuredClone(cached.metadata);
    const controller = new AbortController(); controllers.add(controller);
    try {
      const url = new URL(`https://api.spotify.com/v1/${endpoint}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const response = await fetcher(url.href, { headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), redirect: 'error' });
      if (expected !== generation) throw spotifyError('auth-required', 'session-changed');
      if (!response.ok) reportSpotifyHttp(diagnosticEndpoint, 'GET', response.status, params, undefined, diagnosticContext);
      if (response.status === 429) {
        const retryAt = await cooldown.defer(response.headers.get('retry-after'));
        let reason;
        try { const body = await response.json(); if (body?.error?.reason === 'QUOTA_EXCEEDED') reason = 'quota-exceeded'; }
        catch { /* Some rate limits return an empty or non-JSON body. Never persist the raw body. */ }
        diagnostic({ stage: 'catalog', state: 'response', status: 429, retryAt, ...(reason ? { reason } : {}),
          contentType: response.headers.get('content-type'), server: response.headers.get('server') });
        throw Object.assign(spotifyError('unavailable', reason || 'rate-limited'), { retryAt });
      }
      diagnostic({ stage: 'catalog', state: 'response', status: response.status });
      if (response.status === 401) clear();
      if (!response.ok) throw Object.assign(spotifyError(response.status === 401 ? 'auth-required' : response.status === 403 ? 'unsupported' : 'network', `catalog-http-${response.status}`), { httpStatus: response.status });
      let result;
      try { result = await response.json(); }
      catch (error) { reportSpotifyHttp(diagnosticEndpoint, 'GET', response.status, params, undefined, diagnosticContext); throw error; }
      if (expected !== generation) throw spotifyError('auth-required', 'session-changed');
      reportSpotifyHttp(diagnosticEndpoint, 'GET', response.status, params, result, diagnosticContext);
      if (metadataReceipt) {
        if (trackId) officialMetadata.remember(result, trackId, metadataReceipt);
        else officialMetadata.observeResponse(result, metadataReceipt);
      }
      return result;
    } finally { controllers.delete(controller); }
  }
  async function request(action, input = {}, diagnosticContext) {
    const expected = generation;
    const assertSession = () => { if (expected !== generation) throw spotifyError('auth-required', 'session-changed'); };
    const paging = page(input);
    if (action === 'status') {
      if (!await token()) return null;
      assertSession();
      const result = await get('me', {}, 'catalog-profile');
      assertSession(); playlists.profile(result); officialMetadata?.profile(result); return result;
    }
    if (action === 'search') {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 256) throw spotifyError('invalid-response', 'invalid-query');
      // New development applications have a ten-item search ceiling since February 2026.
      return (await get('search', { ...paging, limit: Math.min(10, paging.limit), q: input.query.trim(), type: 'track' }, 'catalog-search')).tracks;
    }
    if (action === 'playlists') {
      const context = playlistDiagnostics.context(paging.offset, diagnosticContext);
      const result = await get('me/playlists', paging, 'catalog-playlists', context);
      assertSession(); return playlists.library(result, paging.offset, context);
    }
    if (action === 'savedTracks') return get('me/tracks', paging, 'catalog-saved-tracks');
    if (action === 'song') return get(`tracks/${id(input.id)}`, {}, 'catalog-track');
    if (action === 'playlist' || action === 'playlistTracks') {
      const playlistId = id(input.id);
      const context = { operationRef: own(diagnosticContext, 'operationRef'), playlistRef: previewPlaylistRef(playlistId) };
      return playlists.request(action, playlistId, paging, context, assertSession);
    }
    if (action === 'album') return get(`albums/${id(input.id)}`, {}, 'catalog-album');
    if (action === 'albumTracks') return get(`albums/${id(input.id)}/tracks`, paging, 'catalog-album-tracks');
    throw spotifyError('unsupported');
  }
  async function token() {
    try { const value = await vault.token(); if (!value) clear(); return value; }
    catch (error) { if (error?.code === 'auth-required') clear(); throw error; }
  }
  function clear() { generation++; playlists.clear(); officialMetadata?.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  return { request, clear };
}
module.exports = { createSpotifyCatalog };
