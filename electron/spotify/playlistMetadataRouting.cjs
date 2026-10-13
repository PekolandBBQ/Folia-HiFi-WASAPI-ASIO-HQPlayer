const { spotifyError } = require('./errors.cjs');
const { reportPlaylist, rightsFields, count, sourceErrorCode } = require('./playlistCatalogDiagnostics.cjs');

// Main-owned rights and snapshot state. Renderer collection hints can never grant public fallback.
const RIGHTS_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_TTL_MS = 60 * 1000;
const MAX_RIGHTS_ENTRIES = 1000 * 50;
const MAX_SNAPSHOTS = 200;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const validTotal = value => Number.isSafeInteger(value) && value >= 0;
const sourceUrl = id => `https://open.spotify.com/playlist/${id}`;
const sameRights = (left, right) => left?.owner?.id === right?.owner?.id && left?.public === right?.public
  && left?.collaborative === right?.collaborative;
const apiForbidden = error => error?.code === 'unsupported' && error?.httpStatus === 403
  && error?.message === 'Spotify: catalog-http-403';

function createSpotifyPlaylistRouting({ get, publicMetadata, publicArtwork, authenticate, onAccountChange, diagnostics, now = Date.now }) {
  const rights = new Map(), snapshots = new Map(), loads = new Map();
  let profileId = null, loadSequence = 0, requireKnownContinuation = false;
  function clear() { profileId = null; rights.clear(); snapshots.clear(); loads.clear(); requireKnownContinuation = false; publicMetadata.clear(); publicArtwork.clear(); }
  function profile(raw) {
    if (typeof raw?.id !== 'string' || !raw.id) {
      onAccountChange(); throw spotifyError('invalid-response', 'invalid-profile');
    }
    if (profileId && profileId !== raw.id) onAccountChange();
    profileId = raw.id;
  }
  function remember(raw, listed = false) {
    if (!validId(raw?.id)) return;
    const previous = rights.get(raw.id);
    const membership = listed || Boolean(previous?.listed);
    // Replace rights rather than merging fields: a later incomplete or contradictory API response fails closed.
    rights.delete(raw.id);
    const compact = { id: raw.id, name: raw.name, type: raw.type, public: raw.public, collaborative: raw.collaborative,
      owner: raw.owner && { id: raw.owner.id, display_name: raw.owner.display_name },
      images: Array.isArray(raw.images) ? raw.images.slice(0, 5) : [],
      description: typeof raw.description === 'string' ? raw.description.slice(0, 4096) : undefined };
    rights.set(raw.id, { raw: compact, listed: membership, expiresAt: now() + RIGHTS_TTL_MS });
    if (snapshots.has(raw.id) && (!sameRights(previous?.raw, compact) || classification(compact) !== 'followed-public')) snapshots.get(raw.id).expiresAt = 0;
    while (rights.size > MAX_RIGHTS_ENTRIES) {
      const oldest = rights.keys().next().value; rights.delete(oldest); if (snapshots.has(oldest)) snapshots.get(oldest).expiresAt = 0;
    }
  }
  function classification(raw) {
    if (!profileId || typeof raw?.owner?.id !== 'string' || !raw.owner.id) return 'unknown';
    if (raw.owner.id === profileId) return 'owned';
    if (raw.collaborative === true) return 'collaborative-playlist';
    if (raw.public === false) return 'private';
    return raw.public === true && raw.collaborative === false ? 'followed-public' : 'unknown';
  }
  function annotate(raw) {
    if (!validId(raw?.id)) return raw;
    const relationship = classification(raw);
    return { ...raw, metadataSource: 'spotify-api', sourceUrl: sourceUrl(raw.id),
      ...(relationship !== 'unknown' ? { isOwned: relationship === 'owned' } : {}),
      providerData: { playlistRelationship: relationship } };
  }
  function library(raw, offset, context) {
    diagnostics?.directory(raw, offset, profileId, context);
    if (!Array.isArray(raw?.items)) return raw;
    if (offset === 0) { rights.clear(); for (const snapshot of snapshots.values()) snapshot.expiresAt = 0; }
    raw.items.forEach(entry => remember(entry, true));
    return { ...raw, metadataSource: 'spotify-api', items: raw.items.map(annotate) };
  }
  function eligible(id) {
    const record = rights.get(id);
    return record?.listed && record.expiresAt > now() && classification(record.raw) === 'followed-public';
  }
  // Revalidate only a previously observed library member after an API denial; never follow returned URLs.
  async function refreshMembership(id, assertCurrent, context) {
    for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
      const raw = await get('me/playlists', { limit: 50, offset: pageIndex * 50 }, 'catalog-playlists', context);
      assertCurrent();
      diagnostics?.directory(raw, pageIndex * 50, profileId, context);
      if (!Array.isArray(raw?.items)) throw spotifyError('invalid-response', 'catalog-playlists-page');
      raw.items.forEach(entry => remember(entry, true));
      if (raw.items.some(entry => entry?.id === id)) return;
      if (!raw.next) {
        if (rights.has(id)) rights.get(id).listed = false;
        return;
      }
      if (!raw.items.length) throw spotifyError('invalid-response', 'catalog-playlists-page');
    }
    throw spotifyError('invalid-response', 'catalog-playlists-page-limit');
  }
  function publicFields(snapshot) {
    return { metadataSource: 'spotify-public-embed', sourceUrl: sourceUrl(snapshot.id),
      metadataCompleteness: snapshot.complete === true ? 'complete' : snapshot.partial === true ? 'partial' : 'unknown',
      loadedCount: snapshot.tracks.length };
  }
  function publicCollection(id, snapshot) {
    const raw = rights.get(id).raw;
    return { ...raw, id, type: 'playlist', name: snapshot.name,
      description: snapshot.description || raw.description, images: snapshot.images?.length ? snapshot.images : raw.images,
      // API totals and embed rows can be from different snapshots; never label this list with a stale API total.
      items: { total: validTotal(snapshot.total) ? snapshot.total : undefined }, tracks: undefined, total_tracks: undefined,
      isOwned: false, providerData: { playlistRelationship: 'followed-public', metadataUrl: `https://open.spotify.com/embed/playlist/${id}` }, ...publicFields(snapshot) };
  }
  async function publicPage(snapshot, paging, assertCurrent) {
    const original = snapshot.tracks.slice(paging.offset, paging.offset + paging.limit);
    let rows;
    try { rows = await publicArtwork.enrich(original); }
    catch { rows = original.map(track => ({ ...track, artwork: { status: 'unavailable' } })); }
    assertCurrent();
    if (!eligible(snapshot.id)) throw spotifyError('unavailable', 'public-playlist-restart-required');
    return { items: rows.map(track => ({ item: { id: track.id, uri: track.uri, name: track.title,
      type: 'track', duration_ms: track.durationMs, artists: track.artists || (track.subtitle ? [{ name: track.subtitle }] : []),
      album: track.artwork?.status === 'available' ? { images: [{ url: track.artwork.url }] } : {},
      artworkStatus: track.artwork?.status === 'available' ? 'available' : 'unavailable',
      ...(track.artwork?.status === 'available' ? { artworkSource: track.artwork.source, artworkSourceUrl: track.artwork.sourceUrl } : {}),
      metadataSource: 'spotify-public-embed', sourceUrl: track.sourceUrl,
      originUrl: sourceUrl(snapshot.id), metadataUrl: `https://open.spotify.com/embed/playlist/${snapshot.id}` } })),
      total: validTotal(snapshot.total) ? snapshot.total : undefined, consumed: rows.length,
      next: paging.offset + rows.length < snapshot.tracks.length, preserveDuplicates: true, ...publicFields(snapshot) };
  }
  // Fallback needs a specific API denial plus trusted library membership and explicit rights facts.
  async function request(action, id, paging, context, assertSession) {
    assertSession();
    reportPlaylist(context, 'open', { source: 'unknown', pageOffset: paging.offset, pageLimit: paging.limit,
      listed: rights.get(id)?.listed === true, ...rightsFields(rights.get(id)?.raw, profileId) });
    if (action === 'playlistTracks' && paging.offset === 0) {
      loads.delete(id);
      loads.set(id, { sequence: ++loadSequence, source: 'pending' });
      while (loads.size > MAX_RIGHTS_ENTRIES) {
        const oldest = loads.keys().next().value;
        if (loads.get(oldest).source !== 'api') requireKnownContinuation = true;
        loads.delete(oldest); snapshots.delete(oldest);
      }
    }
    const load = loads.get(id);
    const assertCurrent = () => {
      assertSession();
      if (action === 'playlistTracks' && load !== loads.get(id)) throw spotifyError('unavailable', 'public-playlist-restart-required');
    };
    if (action === 'playlistTracks' && paging.offset > 0 && (load?.source === 'pending' || (!load && requireKnownContinuation)))
      throw spotifyError('unavailable', 'public-playlist-restart-required');
    const active = snapshots.get(id);
    if (action === 'playlistTracks' && paging.offset > 0 && active) {
      await authenticate(); assertCurrent();
      if (!eligible(id) || active.expiresAt <= now()) {
        reportPlaylist(context, 'fallback-check', { source: 'cache', eligible: false, reason: active.expiresAt <= now() ? 'expired' : 'ineligible' });
        throw spotifyError('unavailable', 'public-playlist-restart-required');
      }
      try {
        const result = await publicPage(active.value, paging, assertCurrent);
        reportPlaylist(context, 'fallback-result', { source: 'cache', ok: true, complete: active.value.complete === true,
          partial: active.value.partial === true, cachedCount: count(active.value.tracks.length) });
        return result;
      } catch (error) { reportPlaylist(context, 'fallback-result', { source: 'cache', ok: false, reason: 'failed', errorCode: sourceErrorCode(error) }); throw error; }
    }
    if (action === 'playlistTracks' && paging.offset > 0 && load?.source === 'public') throw spotifyError('unavailable', 'public-playlist-restart-required');
    if (action === 'playlistTracks' && paging.offset === 0) snapshots.delete(id);
    let failure;
    try {
      const raw = await get(`playlists/${id}${action === 'playlistTracks' ? '/items' : ''}`,
        action === 'playlistTracks' ? paging : {}, action === 'playlistTracks' ? 'catalog-playlist-items' : 'catalog-playlist', context);
      assertCurrent();
      reportPlaylist(context, 'api-result', { source: 'api', ok: true, ...rightsFields(raw, profileId) });
      if (action === 'playlist') { remember(raw); return annotate(raw); }
      if (paging.offset === 0) load.source = 'api';
      return { ...raw, metadataSource: 'spotify-api', sourceUrl: sourceUrl(id), preserveDuplicates: true };
    } catch (error) {
      assertCurrent();
      reportPlaylist(context, 'api-result', { source: 'api', ok: false, httpStatus: error?.httpStatus, errorCode: sourceErrorCode(error) });
      if (!apiForbidden(error) || (action === 'playlistTracks' && paging.offset > 0)) {
        reportPlaylist(context, 'fallback-check', { eligible: false, reason: !apiForbidden(error) ? 'not-forbidden' : 'continuation' });
        throw error;
      }
      failure = error;
    }
    const record = rights.get(id);
    if (!record?.listed) { reportPlaylist(context, 'fallback-check', { eligible: false, reason: 'not-listed' }); throw failure; }
    if (!profileId) {
      const rawProfile = await get('me', {}, 'catalog-profile');
      assertCurrent(); profile(rawProfile);
    }
    if (classification(record.raw) !== 'followed-public') {
      reportPlaylist(context, 'fallback-check', { eligible: false, reason: classification(record.raw), ...rightsFields(record.raw, profileId) });
      throw failure;
    }
    if (record.expiresAt <= now()) await refreshMembership(id, assertCurrent, context);
    reportPlaylist(context, 'fallback-check', { eligible: Boolean(eligible(id)), reason: eligible(id) ? 'allowed' : 'ineligible', ...rightsFields(record.raw, profileId) });
    if (!eligible(id)) throw failure;
    let snapshot;
    try { snapshot = await publicMetadata.get(id); }
    catch (error) { assertCurrent(); reportPlaylist(context, 'fallback-result', { source: 'public', ok: false, reason: 'failed', errorCode: sourceErrorCode(error) }); throw error; }
    assertCurrent();
    if (!eligible(id)) { reportPlaylist(context, 'fallback-result', { source: 'public', ok: false, reason: 'stale' }); throw failure; }
    if (!snapshot || snapshot.id !== id || !Array.isArray(snapshot.tracks)) {
      reportPlaylist(context, 'fallback-result', { source: 'public', ok: false, reason: 'invalid-schema' });
      throw spotifyError('invalid-response', 'public-playlist-schema');
    }
    if (action === 'playlistTracks') {
      load.source = 'public';
      const fetchedAt = Number.isFinite(snapshot.fetchedAt) ? snapshot.fetchedAt : now();
      snapshots.set(id, { value: snapshot, expiresAt: Math.min(now(), fetchedAt) + SNAPSHOT_TTL_MS });
      while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
    }
    try {
      const result = action === 'playlist' ? publicCollection(id, snapshot) : await publicPage(snapshot, paging, assertCurrent);
      reportPlaylist(context, 'fallback-result', { source: 'public', ok: true, complete: snapshot.complete === true,
        partial: snapshot.partial === true, resultCount: count(snapshot.tracks.length) });
      return result;
    } catch (error) { reportPlaylist(context, 'fallback-result', { source: 'public', ok: false, reason: 'failed', errorCode: sourceErrorCode(error) }); throw error; }
  }
  return { clear, profile, library, request };
}
module.exports = { createSpotifyPlaylistRouting };
