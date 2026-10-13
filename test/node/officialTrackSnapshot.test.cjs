'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotOfficialTrack } = require('../../electron/spotify/officialTrackSnapshot.cjs');
const { createOfficialTrackMetadata } = require('../../electron/spotify/officialTrackMetadata.cjs');
const { officialTrack, TRACK_ID, OTHER_ID } = require('../fixtures/spotifyOfficialTrack.cjs');

// Actual bounded full-object cache; synthetic API JSON, no service requests.
function fixture() {
  let time = 100000, stamp = { epoch: 1, revision: 1 };
  const cache = createOfficialTrackMetadata({ getStamp: () => stamp, now: () => time });
  return { cache, advance: n => { time += n; }, change: () => { stamp = { epoch: 2, revision: 0 }; } };
}
test('complete official object is preserved intact, deeply frozen and isolated from the API result', () => {
  const raw = officialTrack(), snapshot = snapshotOfficialTrack(raw);
  assert.deepEqual(snapshot, raw);
  assert.notEqual(snapshot, raw); assert.notEqual(snapshot.album, raw.album);
  raw.name = 'changed'; raw.album.images[0].url = 'https://example.com/changed'; raw.artists[0].name = 'changed';
  assert.equal(snapshot.name, 'Fixture track'); assert.equal(snapshot.artists[0].name, 'Fixture artist');
  assert.equal(Object.isFrozen(snapshot.album.images[0]), true);
  assert.throws(() => { snapshot.album.name = 'changed'; }, TypeError);
});
test('partial, normalized, restricted, private or unknown fields cannot create a full cache entry', () => {
  for (const alter of [v => { delete v.artists; }, v => { delete v.album.images; }, v => { delete v.album.artists; },
    v => { delete v.name; }, v => { v.is_local = true; }, v => { v.is_playable = false; },
    v => { v.restrictions = { reason: 'market' }; }, v => { v.metadataSource = 'spotify-public-embed'; },
    v => { v.access_token = 'never-retain-fixture'; }, v => { v.album.owner = { id: 'private-account' }; },
    v => { v.artists[0].token = 'never-retain-fixture'; }, v => { v.is_playing = false; },
    v => { v.progress_ms = 4000; }, v => { v.device = { id: 'private-device' }; },
    v => { v.linked_from = { id: OTHER_ID, type: 'episode', uri: `spotify:track:${OTHER_ID}` }; }]) {
    const raw = officialTrack(); alter(raw); assert.equal(snapshotOfficialTrack(raw), null);
  }
});
test('full cache rejects accessors, prototypes, cycles and oversized objects without reading getters', () => {
  let reads = 0; const accessor = officialTrack();
  Object.defineProperty(accessor.album, 'name', { get() { reads++; return 'bad'; }, enumerable: true });
  assert.equal(snapshotOfficialTrack(accessor), null); assert.equal(reads, 0);
  const prototype = officialTrack(); Object.setPrototypeOf(prototype.album, { injected: true });
  assert.equal(snapshotOfficialTrack(prototype), null);
  const cycle = officialTrack(); cycle.album.loop = cycle; assert.equal(snapshotOfficialTrack(cycle), null);
  const oversized = officialTrack(); oversized.artists = Array.from({ length: 64 }, () => ({ ...oversized.artists[0], name: 'x'.repeat(2048) }));
  assert.equal(snapshotOfficialTrack(oversized), null);
  const sparse = officialTrack(); sparse.album.images = new Array(1); assert.equal(snapshotOfficialTrack(sparse), null);
});
test('cache holds full response alongside facts; later caller mutation and conditional old eviction cannot replace it', () => {
  const { cache } = fixture(), receipt = cache.bind(), raw = officialTrack();
  const old = cache.remember(raw, TRACK_ID, receipt); raw.album.name = 'changed';
  assert.equal(cache.get(TRACK_ID, receipt).metadata.album.name, 'Fixture album');
  const next = cache.remember({ ...officialTrack(), name: 'new official title' }, TRACK_ID, receipt);
  cache.remove(TRACK_ID, old); assert.equal(cache.get(TRACK_ID, receipt), next);
  assert.deepEqual(next.facts, { trackId: TRACK_ID, durationMs: 180000 });
});
test('new item, legacy track and direct official rows seed the shared cache, public rows do not', () => {
  const { cache } = fixture(), receipt = cache.bind();
  for (const envelope of [v => ({ item: v }), v => ({ track: v }), v => v]) {
    cache.observeResponse({ items: [envelope(officialTrack())] }, receipt);
    assert.deepEqual(cache.get(TRACK_ID, receipt).metadata, officialTrack()); cache.remove(TRACK_ID);
  }
  cache.observeResponse({ items: [{ item: { ...officialTrack(), metadataSource: 'spotify-public-embed' } }] }, receipt);
  assert.equal(cache.get(TRACK_ID, receipt), null);
});
test('TTL, profile, explicit settings clear, vault changes and clock rollback revoke old request receipts', () => {
  for (const invalidate of [f => f.advance(60000), f => f.cache.profile({ id: 'other-account', country: 'GB' }),
    f => f.cache.clear(), f => f.change(), f => f.advance(-1)]) {
    const f = fixture(), receipt = f.cache.bind(); f.cache.remember(officialTrack(), TRACK_ID, receipt);
    assert.equal(f.cache.isCurrent(receipt), true); invalidate(f);
    assert.equal(f.cache.isCurrent(receipt), false); assert.equal(f.cache.get(TRACK_ID, receipt), null);
    assert.equal(f.cache.remember(officialTrack(), TRACK_ID, receipt), null);
  }
  const f = fixture(), old = f.cache.bind(); f.cache.remember(officialTrack(), TRACK_ID, old);
  f.advance(-1); assert.equal(f.cache.isCurrent(old), false); f.advance(1);
  assert.equal(f.cache.isCurrent(old), false); assert.equal(f.cache.get(TRACK_ID, f.cache.bind()), null);
});
test('relink cache is keyed only by verified requested identity and changing mapping replaces the full snapshot', () => {
  const { cache } = fixture(), receipt = cache.bind();
  const relinked = { ...officialTrack(OTHER_ID), linked_from: { id: TRACK_ID, type: 'track', uri: `spotify:track:${TRACK_ID}` } };
  const entry = cache.remember(relinked, TRACK_ID, receipt);
  assert.deepEqual(entry.metadata, relinked); assert.equal(cache.get(OTHER_ID, receipt), null);
  cache.remember(officialTrack(), TRACK_ID, receipt);
  assert.equal(cache.get(TRACK_ID, receipt).facts.trackId, TRACK_ID);
  assert.equal(cache.remember({ ...relinked, linked_from: { id: TRACK_ID, type: 'track', uri: `spotify:track:${OTHER_ID}` } }, TRACK_ID, receipt), null);
  assert.equal(cache.get(TRACK_ID, receipt), null);
});
test('delayed publication preserves actual response time and rejects invalid observation timestamps', () => {
  const f = fixture(), receipt = f.cache.bind(); f.advance(450);
  const completedAt = 100450; f.advance(3000);
  const entry = f.cache.remember(officialTrack(), TRACK_ID, receipt, { observedAt: completedAt });
  assert.equal(entry.observedAt, completedAt);
  f.advance(56999); assert.equal(f.cache.get(TRACK_ID, f.cache.bind()), entry);
  f.advance(1); assert.equal(f.cache.get(TRACK_ID, f.cache.bind()), null);
  const next = f.cache.bind();
  for (const observedAt of [NaN, Infinity, 99999, 160451])
    assert.equal(f.cache.remember(officialTrack(), TRACK_ID, next, { observedAt }), null);
});
