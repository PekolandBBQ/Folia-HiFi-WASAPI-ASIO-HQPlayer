'use strict';
const { own, projectEvent, sourceErrorCode } = require('../debug/privatePreviewDiagnosticSchema.cjs');
const { isPreviewDiagnosticsEnabled, publishPreviewDiagnostic } = require('../debug/privatePreviewDiagnosticBus.cjs');
const { previewPlaylistRef } = require('./playlistDiagnostics.cjs');

// electron/spotify/playlistCatalogDiagnostics.cjs — passive, capped observations; never metadata or request URLs.
const MAX_DIRECTORY_ITEMS = 100;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const tri = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100000) : undefined;
function rightsFields(raw, profileId) {
  const ownerId = own(own(raw, 'owner'), 'id');
  return { ownerSelf: tri(typeof ownerId === 'string' && ownerId && profileId ? ownerId === profileId : undefined),
    publicState: tri(own(raw, 'public')), collaborativeState: tri(own(raw, 'collaborative')) };
}
function reportPlaylist(context, phase, fields = {}) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try { publishPreviewDiagnostic('spotify.playlist', { ...fields, phase,
    ...(phase !== 'directory-page' && own(context, 'playlistRef') === undefined ? { capped: true } : {}),
    operationRef: own(context, 'operationRef'), playlistRef: own(context, 'playlistRef') }); } catch {}
}
// The renderer already owns collection IDs. Only this trusted local IPC projection may consume one;
// it never forwards that input to the journal, and the normal schema rejects it even if called directly.
function projectRendererLibrary(fields) {
  if (!isPreviewDiagnosticsEnabled()) return null;
  const projected = projectEvent('spotify.library', fields);
  if (!projected) return null;
  const id = own(fields, 'playlistId');
  const { playlistRef: ignored, ...safe } = projected.fields;
  const playlistRef = validId(id) ? previewPlaylistRef(id) : undefined;
  return { ...safe, ...(playlistRef !== undefined ? { playlistRef } : {}),
    ...(validId(id) && playlistRef === undefined ? { capped: true } : {}) };
}
function createPlaylistCatalogDiagnostics() {
  let inspected = 0, pages = 0;
  function context(offset, incoming) {
    if (!isPreviewDiagnosticsEnabled()) return incoming;
    if (offset === 0) { inspected = 0; pages = 0; }
    // Per-call operation references are exact even when two refreshes interleave.
    // The renderer supplies its own refreshRef; never infer a transaction from offsets.
    return { operationRef: own(incoming, 'operationRef') };
  }
  function directory(raw, offset, profileId, context) {
    if (!isPreviewDiagnosticsEnabled()) return;
    try {
      if (pages++ >= 100) return;
      const items = own(raw, 'items'), length = Array.isArray(items) ? items.length : 0;
      const take = Math.min(length, 50, MAX_DIRECTORY_ITEMS - inspected);
      reportPlaylist(context, 'directory-page', { source: 'api', pageOffset: offset,
        pageLimit: own(raw, 'limit'), ok: Array.isArray(items), rawCount: Array.isArray(items) ? count(length) : undefined, totalCount: count(own(raw, 'total')),
        inspectedCount: take, hasContinuation: Boolean(own(raw, 'next')), capped: take < length || pages === 100 });
      for (let index = 0; index < take; index++) {
        const item = own(items, String(index)), id = own(item, 'id');
        if (validId(id)) reportPlaylist({ ...context, playlistRef: previewPlaylistRef(id) }, 'directory-item',
          { source: 'api', listed: true, ...rightsFields(item, profileId) });
      }
      inspected += take;
    } catch { /* Observation cannot change catalog output. */ }
  }
  return { context, directory };
}
module.exports = { reportPlaylist, rightsFields, projectRendererLibrary, createPlaylistCatalogDiagnostics, count, sourceErrorCode };
