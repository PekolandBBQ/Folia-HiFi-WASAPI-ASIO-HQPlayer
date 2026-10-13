'use strict';
const { snapshotOfficialTrack } = require('./officialTrackSnapshot.cjs');

// Official API catalog facts only, never source playback state or authorization.
// Main-process memory only. Complete eligible track objects are retained intact;
// minimal facts remain compatible with older responses. No token/profile fields.
function createOfficialTrackMetadata({ getStamp, now = Date.now } = {}) {
  if (typeof getStamp !== 'function') throw new TypeError('getStamp required');
  const entries = new Map(), receipts = new WeakMap();
  let context, generation = 0, accountKey, country, lastNow;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
  const stampKey = value => Number.isSafeInteger(value?.epoch) && Number.isSafeInteger(value?.revision)
    && value.epoch >= 0 && value.revision >= 0 ? `${value.epoch}:${value.revision}` : null;
  function clear() { entries.clear(); generation++; }
  function sync() {
    const at = now();
    if (!Number.isFinite(at) || lastNow != null && at < lastNow) clear();
    lastNow = at;
    const key = stampKey(getStamp());
    if (key !== context) { clear(); context = key; accountKey = undefined; country = undefined; }
    return key;
  }
  function bind() {
    const key = sync();
    const receipt = Object.freeze({});
    receipts.set(receipt, { key, generation, at: now() });
    return receipt;
  }
  function current(receipt) {
    const key = sync(), value = receipts.get(receipt);
    return key !== null && value?.key === key && value.generation === generation
      && now() >= value.at && now() - value.at < 60000 ? value : null;
  }
  function fresh(entry) { const age = now() - entry.observedAt; return age >= 0 && age < 60000; }
  function get(id, receipt) {
    if (!validId(id) || !current(receipt)) return null;
    const entry = entries.get(id);
    if (entry && !fresh(entry)) { entries.delete(id); return null; }
    return entry || null;
  }
  function remove(id, expectedEntry) {
    if (validId(id) && (!expectedEntry || entries.get(id) === expectedEntry)) entries.delete(id);
  }
  function remember(value, requestedId, receipt, { observedAt = now() } = {}) {
    const owner = current(receipt);
    // Speculative reads may publish only after restoration. Preserve the actual
    // HTTP completion time; delayed publication cannot renew the original TTL.
    if (!owner || !validId(requestedId) || !Number.isFinite(observedAt) || observedAt < owner.at
      || observedAt > now() || now() - observedAt >= 60000) return null;
    // Partial/embed/local/restricted/unplayable objects cannot seed playback facts.
    if (!value || value.type !== 'track' || !validId(value.id) || value.uri !== `spotify:track:${value.id}`
      || value.is_local !== false || value.is_playable !== true || !validId(value.album?.id)
      || value.metadataSource != null && value.metadataSource !== 'spotify-api' || value.sourceRef != null
      || value.linked_from != null && (!validId(value.linked_from.id) || value.linked_from.id === value.id
        || value.linked_from.uri !== `spotify:track:${value.linked_from.id}` || value.linked_from.type !== 'track')
      || value.restrictions && (typeof value.restrictions !== 'object' || Object.keys(value.restrictions).length)
      || !Number.isSafeInteger(value.duration_ms) || value.duration_ms <= 0 || value.duration_ms > 3600000
      || value.id !== requestedId && (value.linked_from?.id !== requestedId
        || value.linked_from?.uri !== `spotify:track:${requestedId}` || value.linked_from?.type !== 'track')) {
      remove(requestedId); return null;
    }
    const metadata = snapshotOfficialTrack(value);
    const entry = Object.freeze({ facts: Object.freeze({ trackId: value.id, durationMs: value.duration_ms }),
      ...(metadata ? { metadata } : {}),
      observedAt });
    entries.delete(requestedId);
    while (entries.size >= 128) entries.delete(entries.keys().next().value);
    entries.set(requestedId, entry);
    return entry;
  }
  function observeResponse(value, receipt) {
    if (!current(receipt)) return;
    const candidates = value?.type === 'track' ? [value]
      : Array.isArray(value?.tracks?.items) ? value.tracks.items
      : Array.isArray(value?.items) ? value.items : [];
    for (const candidate of candidates.slice(0, 50)) {
      const track = candidate?.item ?? candidate?.track ?? candidate;
      if (track?.type !== 'track') continue;
      const requested = validId(track?.linked_from?.id) ? track.linked_from.id : track?.id;
      remember(track, requested, receipt);
    }
  }
  function profile(value) {
    sync();
    const nextAccount = typeof value?.id === 'string' && value.id.length <= 256 ? value.id : null;
    const nextCountry = typeof value?.country === 'string' && /^[A-Z]{2}$/.test(value.country) ? value.country : null;
    if (accountKey !== nextAccount || country !== nextCountry) clear();
    accountKey = nextAccount; country = nextCountry;
  }
  return { bind, isCurrent: receipt => Boolean(current(receipt)), get, remember, observeResponse, remove, profile, clear, dispose: clear };
}
module.exports = { createOfficialTrackMetadata };
