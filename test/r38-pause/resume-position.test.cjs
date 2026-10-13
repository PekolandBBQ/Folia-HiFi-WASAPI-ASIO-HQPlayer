'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, OTHER } = require('./source-fixture.cjs');

// Production Spotify control/source/owned-route coordinator; HTTP, native route and capture are explicit synthetic boundaries.
for (const offset of [-2, 37, 1000]) {
  test(`resume keeps an accepted ${offset}ms Spotify seek readback and the exact retained route`, async () => {
    const f = await fixture();
    try {
      const active = await f.start(); await active.source.pause({ positionMs: 6602 });
      const captureCount = f.captures.length;
      f.hooks.http = ({ operation, state, url }) => {
        if (operation !== 'seek') return;
        state.progress_ms = Number(url.searchParams.get('position_ms')) + offset;
        return { status: 200, raw: 'Command received' };
      };
      const opened = await active.source.openReadable({ positionMs: 6602 });
      assert.equal(opened.positionMs, 6602 + offset, 'the observed origin must not be fabricated as the requested millisecond');
      assert.equal(f.leases.length, 1); assert.equal(f.captures.length, captureCount);
      const result = await opened.stream[Symbol.asyncIterator]().next();
      assert.equal(result.done, false); assert.equal(f.captures.length, captureCount + 1);
      assert.equal(f.leases[0].restored, false); await active.source.stop(); assert.equal(f.leases[0].restored, true);
    } finally { await f.close(); }
  });
}
for (const offset of [-1001, 1001]) test(`resume rejects a source ${offset}ms from its heard checkpoint`, async () => {
  const f = await fixture();
  try {
    const active = await f.start(); await active.source.pause({ positionMs: 6602 });
    const captureCount = f.captures.length;
    f.hooks.http = ({ operation, state, url }) => {
      if (operation === 'seek') { state.progress_ms = Number(url.searchParams.get('position_ms')) + offset; return { status: 200, raw: 'Command received' }; }
    };
    await assert.rejects(active.source.openReadable({ positionMs: 6602 }));
    assert.equal(f.captures.length, captureCount);
  } finally { await f.close(); }
});
test('Stop restores the route and an explicit replay runs the required target-active callback before capture', async () => {
  const f = await fixture();
  try {
    const active = await f.start(); await active.source.stop();
    assert.equal(f.leases[0].restored, true);
    f.events.length = 0;
    const opened = await active.source.openReadable({ positionMs: 9000 });
    assert.equal(opened.positionMs, 9000);
    assert.equal(f.leases.length, 2);
    assert.ok(f.events.indexOf('route:target-active') > f.events.indexOf('http:select'));
    assert.ok(f.events.indexOf('route:target-active') < f.events.indexOf('route:complete'));
    assert.equal(f.events.includes('capture:open'), false);
    await active.source.stop();
  } finally { await f.close(); }
});
for (const mode of ['track', 'device', 'playing']) test(`retained resume rejects an external ${mode} change before seeking or opening capture`, async () => {
  const f = await fixture();
  try {
    const active = await f.start(); await active.source.pause({ positionMs: 6602 });
    if (mode === 'track') f.state.item.uri = `spotify:track:${OTHER}`;
    if (mode === 'device') f.state.device.id = 'different-desktop';
    if (mode === 'playing') f.state.is_playing = true;
    f.events.length = 0;
    await assert.rejects(active.source.openReadable({ positionMs: 6602 }));
    assert.equal(f.events.includes('http:seek'), false); assert.equal(f.events.includes('capture:open'), false);
  } finally { await f.close(); }
});
