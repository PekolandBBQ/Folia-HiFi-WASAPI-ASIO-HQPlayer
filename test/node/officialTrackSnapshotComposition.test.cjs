'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpotifyCatalog } = require('../../electron/spotify/catalog.cjs');
const { createOfficialTrackMetadata } = require('../../electron/spotify/officialTrackMetadata.cjs');
const { officialTrack, TRACK_ID, OTHER_ID } = require('../fixtures/spotifyOfficialTrack.cjs');

// Real catalog queue/cache composition with entirely synthetic transport boundaries.
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  let time = 100000, stamp = { epoch: 1, revision: 1 }, retryAt = 0, token = 'synthetic-fixture', tokenFailure, fetchHook;
  const calls = [], officialMetadata = createOfficialTrackMetadata({ getStamp: () => stamp, now: () => time });
  const catalog = createSpotifyCatalog({ officialMetadata, now: () => time,
    vault: { token: async () => { if (tokenFailure) throw tokenFailure; return token; } },
    cooldown: { load: async () => retryAt, defer: async () => { retryAt = time + 60000; return retryAt; } },
    fetcher: async address => {
      const url = new URL(address); calls.push(url.pathname);
      const override = await fetchHook?.(url);
      if (override) return override;
      if (url.pathname.endsWith('/me/tracks')) return Response.json({ items: [{ item: officialTrack() }] });
      if (url.pathname.endsWith('/search')) return Response.json({ tracks: { items: [officialTrack()] } });
      return Response.json(officialTrack(url.pathname.split('/').at(-1)));
    } });
  return { catalog, officialMetadata, calls, advance: n => { time += n; }, change: () => { stamp = { epoch: 2, revision: 0 }; },
    cooldown: () => { retryAt = time + 60000; }, loggedOut: () => { token = null; },
    tokenError: error => { tokenFailure = error; }, hook: fn => { fetchHook = fn; } };
}
test('browse item response feeds the exact full song response with no second GET and caller copies stay isolated', async () => {
  const f = fixture(); const page = await f.catalog.request('savedTracks');
  page.items[0].item.name = 'caller mutation';
  const first = await f.catalog.request('song', { id: TRACK_ID });
  assert.deepEqual(first, officialTrack()); first.album.name = 'another mutation';
  assert.deepEqual(await f.catalog.request('song', { id: TRACK_ID }), officialTrack());
  assert.deepEqual(f.calls, ['/v1/me/tracks']);
});
test('parallel detail requests coalesce through the existing catalog queue after the first validated response', async () => {
  const f = fixture(), gate = deferred(), started = deferred();
  f.hook(async () => { started.resolve(); await gate.promise; });
  const first = f.catalog.request('song', { id: TRACK_ID }), second = f.catalog.request('song', { id: TRACK_ID });
  await started.promise; gate.resolve();
  assert.deepEqual(await first, officialTrack()); assert.deepEqual(await second, officialTrack());
  assert.deepEqual(f.calls, [`/v1/tracks/${TRACK_ID}`]);
});
test('metadata TTL uses original observation time and hits do not renew it', async () => {
  const f = fixture(); await f.catalog.request('song', { id: TRACK_ID }); f.advance(59999);
  await f.catalog.request('song', { id: TRACK_ID }); assert.equal(f.calls.length, 1); f.advance(1);
  await f.catalog.request('song', { id: TRACK_ID }); assert.equal(f.calls.length, 2);
});
test('partial and unknown schema results preserve ordinary fetch behavior rather than synthesizing missing fields', async () => {
  for (const change of [value => { delete value.album.images; }, value => { value.future_field = true; }]) {
    const f = fixture(), value = officialTrack(); change(value); f.hook(() => Response.json(value));
    assert.deepEqual(await f.catalog.request('song', { id: TRACK_ID }), value);
    assert.deepEqual(await f.catalog.request('song', { id: TRACK_ID }), value);
    assert.equal(f.calls.length, 2);
  }
});
test('cooldown, missing login and current authorization failure are still checked before every cache hit', async () => {
  for (const [invalidate, expected] of [[f => f.cooldown(), 'rate-limited'], [f => f.loggedOut(), 'session-changed'],
    [f => f.tokenError(Object.assign(new Error('expired grant'), { code: 'auth-required' })), 'expired grant']]) {
    const f = fixture(); await f.catalog.request('song', { id: TRACK_ID }); invalidate(f);
    await assert.rejects(f.catalog.request('song', { id: TRACK_ID }), error => error.message.includes(expected));
    assert.equal(f.calls.length, 1);
  }
});
test('expired entry never hides an actual forbidden, auth, rate-limit or server error', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(); await f.catalog.request('song', { id: TRACK_ID }); f.advance(60000);
    f.hook(() => Response.json({ error: { status } }, { status }));
    await assert.rejects(f.catalog.request('song', { id: TRACK_ID })); assert.equal(f.calls.length, 2);
  }
});
test('clear aborts publication after transport cancellation is ignored; old result cannot refill full cache', async () => {
  const f = fixture(), started = deferred(), gate = deferred();
  f.hook(async () => { started.resolve(); await gate.promise; });
  const result = f.catalog.request('song', { id: TRACK_ID }); await started.promise;
  f.catalog.clear(); gate.resolve(); await assert.rejects(result, /session-changed/);
  assert.equal(f.officialMetadata.get(TRACK_ID, f.officialMetadata.bind()), null);
});
test('account or market changes during response parsing revoke its cache receipt even with an unchanged catalog queue', async () => {
  for (const change of [f => f.change(), f => f.officialMetadata.profile({ id: 'same-account', country: 'GB' })]) {
    const f = fixture(), started = deferred(), gate = deferred();
    f.officialMetadata.profile({ id: 'same-account', country: 'US' });
    f.hook(() => ({ ok: true, status: 200, json: async () => { started.resolve(); await gate.promise; return officialTrack(); } }));
    const result = f.catalog.request('song', { id: TRACK_ID }); await started.promise; change(f); gate.resolve(); await result;
    assert.equal(f.officialMetadata.get(TRACK_ID, f.officialMetadata.bind()), null);
  }
});
test('mismatched track response cannot seed an unrelated identity; relink response seeds only its original request', async () => {
  const f = fixture(); f.hook(() => Response.json(officialTrack(OTHER_ID)));
  await f.catalog.request('song', { id: TRACK_ID });
  assert.equal(f.officialMetadata.get(OTHER_ID, f.officialMetadata.bind()), null);
  assert.equal(f.officialMetadata.get(TRACK_ID, f.officialMetadata.bind()), null);
  const relinked = { ...officialTrack(OTHER_ID), linked_from: { id: TRACK_ID, type: 'track', uri: `spotify:track:${TRACK_ID}` } };
  f.hook(() => Response.json(relinked)); await f.catalog.request('song', { id: TRACK_ID });
  assert.deepEqual(await f.catalog.request('song', { id: TRACK_ID }), relinked); assert.equal(f.calls.length, 2);
  assert.equal(f.officialMetadata.get(OTHER_ID, f.officialMetadata.bind()), null);
});
