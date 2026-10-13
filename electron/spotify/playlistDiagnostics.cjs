'use strict';
const { own } = require('../debug/privatePreviewDiagnosticSchema.cjs');
const { isPreviewDiagnosticsEnabled, previewPlaylistDiagnosticRef } = require('../debug/privatePreviewDiagnosticBus.cjs');

// electron/spotify/playlistDiagnostics.cjs — bounded, value-only observations of existing catalog responses.
const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function previewPlaylistRef(id) {
  if (!isPreviewDiagnosticsEnabled() || !validId(id)) return undefined;
  // The bus retains a capped, stable run-local mapping; only its ordinal is ever emitted.
  return previewPlaylistDiagnosticRef(id);
}
function playlistPage(body) {
  const current = own(body, 'items'), legacy = own(body, 'tracks');
  if (record(current)) return { page: current, pageShape: 'items' };
  if (record(legacy)) return { page: legacy, pageShape: 'tracks' };
  return { page: undefined, pageShape: 'missing' };
}
function playlistResponseFields(endpoint, body) {
  if (!isPreviewDiagnosticsEnabled() || body === undefined
    || !['catalog-playlist', 'catalog-playlist-items'].includes(endpoint)) return {};
  const detail = endpoint === 'catalog-playlist';
  const { page, pageShape } = detail ? playlistPage(body) : { page: body, pageShape: 'root' };
  const items = own(page, 'items'), next = own(page, 'next');
  const fields = { pageShape, totalCount: own(page, 'total'),
    responseOffset: own(page, 'offset'), responseLimit: own(page, 'limit'),
    hasContinuation: next === null ? false : typeof next === 'string' ? next.length > 0 : undefined,
    ...(detail ? { collaborative: own(body, 'collaborative') } : {}) };
  if (!Array.isArray(items)) return fields;
  Object.assign(fields, { rawCount: items.length, inspectedCount: Math.min(items.length, 50),
    itemEnvelopeCount: 0, trackEnvelopeCount: 0, directItemCount: 0, nullItemCount: 0,
    localItemCount: 0, episodeItemCount: 0, invalidItemCount: 0, trackItemCount: 0, restrictedItemCount: 0 });
  // Match the adapter's envelope preference, but never read metadata strings into an event.
  for (let index = 0; index < fields.inspectedCount; index++) {
    const row = own(items, String(index)), item = own(row, 'item'), track = own(row, 'track');
    if (item !== undefined) fields.itemEnvelopeCount++;
    else if (track !== undefined) fields.trackEnvelopeCount++;
    else fields.directItemCount++;
    const value = item ?? track ?? row;
    if (row == null || (item === null && track == null) || (track === null && item == null)) fields.nullItemCount++;
    else if (own(value, 'is_local') === true) fields.localItemCount++;
    else if (own(value, 'type') === 'episode') fields.episodeItemCount++;
    else if (!validId(own(value, 'id')) || typeof own(value, 'name') !== 'string') fields.invalidItemCount++;
    else {
      fields.trackItemCount++;
      if (own(value, 'is_playable') === false || own(own(value, 'restrictions'), 'reason')) fields.restrictedItemCount++;
    }
  }
  return fields;
}
module.exports = { previewPlaylistRef, playlistResponseFields };
