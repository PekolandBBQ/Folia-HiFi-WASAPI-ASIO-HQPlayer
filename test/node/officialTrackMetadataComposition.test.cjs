'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpotifyCatalog } = require('../../electron/spotify/catalog.cjs');
const { createOfficialTrackMetadata } = require('../../electron/spotify/officialTrackMetadata.cjs');
const id = 'a'.repeat(22);
const track = { type: 'track', id, uri: `spotify:track:${id}`, duration_ms: 100000, is_local: false,
  is_playable: true, album: { id: 'b'.repeat(22) } };
function fixture() {
  let stamp = { epoch: 1, revision: 1 }, calls = 0, finish;
  const officialMetadata = createOfficialTrackMetadata({ getStamp: () => stamp });
  const catalog = createSpotifyCatalog({ officialMetadata, vault: { token: async () => 'synthetic-fixture' },
    cooldown: { load: async () => 0, defer: async () => 0 }, fetcher: async () => {
      calls++;
      if (finish) await finish;
      return { ok: true, status: 200, json: async () => track };
    } });
  return { catalog, officialMetadata, calls: () => calls, change: () => { stamp = { epoch: 2, revision: 0 }; },
    delay: promise => { finish = promise; } };
}
test('actual catalog song request seeds shared facts with exactly one API call', async () => {
  const f = fixture(); assert.deepEqual(await f.catalog.request('song', { id }), track);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.officialMetadata.get(id, f.officialMetadata.bind()).facts, { trackId: id, durationMs: 100000 });
  f.catalog.clear(); assert.equal(f.officialMetadata.get(id, f.officialMetadata.bind()), null);
});
test('actual queued API result cannot refill metadata after account context changes', async () => {
  const f = fixture(); let release; f.delay(new Promise(resolve => { release = resolve; }));
  const request = f.catalog.request('song', { id });
  while (!f.calls()) await new Promise(resolve => setImmediate(resolve));
  f.change(); release(); await request;
  assert.equal(f.officialMetadata.get(id, f.officialMetadata.bind()), null);
});
