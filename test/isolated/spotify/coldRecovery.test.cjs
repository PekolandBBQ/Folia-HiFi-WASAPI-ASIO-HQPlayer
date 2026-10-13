'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { fixture, receipt, application, createColdVolumeReceipt } = require('./coldRecoveryFixture.cjs');
const { createDesktopPlaybackApi } = require(join(application, 'electron/spotify/desktopPlaybackApi.cjs'));
const v2 = { ...receipt, version: 2, baselineEmpty: true, targetActive: false, volumeOnly: true, volumeRequestPending: false, playbackRequestPending: false };
async function using(options, action) { const f = await fixture(options); try { await action(f); } finally { await f.close(); } }
test('v1 compatibility: real paused/API9 clears without writes', async () => using({}, async f => {
  assert.equal((await f.check()).required, false); assert.equal(await f.retained(), null);
  assert.ok(f.events.every(x => x.startsWith('GET:')));
}));
test('v1 empty204 remains unknown despite exact target volume', async () => using({ initialPaused: false }, async f => {
  await assert.rejects(f.check()); assert.deepEqual(await f.retained(), receipt); assert.deepEqual(f.events, ['GET:player']);
}));
test('v2 volume-only empty204 and inactive target/API9 settles only marker', async () => using({ seed: v2, initialPaused: false }, async f => {
  assert.equal((await f.check()).required, false); assert.equal(await f.retained(), null);
  assert.deepEqual(f.events, ['GET:player', 'GET:devices', 'GET:player', 'GET:devices']);
  assert.equal(f.state, null); assert.equal(f.device.is_active, false); assert.equal(f.device.volume_percent, 9);
}));
test('v2 initially active empty target remains availability evidence, not paused', async () => using({ seed: { ...v2, targetActive: true }, initialPaused: false }, async f => {
  f.device.is_active = true; assert.equal((await f.check()).required, false); assert.equal(f.state, null);
}));
for (const change of ['zero', 'third-volume', 'unknown-volume', 'changed-target-activity', 'foreign-active', 'foreign-unknown-activity', 'duplicate-target', 'null200', 'playing', 'foreign-player']) {
  test(`v2 empty settlement rejects ${change} without writes`, async () => using({ seed: v2, initialPaused: false }, async f => {
    if (change === 'zero') f.device.volume_percent = 0;
    if (change === 'third-volume') f.device.volume_percent = 10;
    if (change === 'unknown-volume') f.device.volume_percent = null;
    if (change === 'changed-target-activity') f.device.is_active = true;
    f.override(op => {
      if (op === 'player' && change === 'null200') return Response.json(null);
      if (op === 'player' && ['playing', 'foreign-player'].includes(change)) return Response.json({
        device: { ...f.device, is_active: true, id: change === 'foreign-player' ? 'phone' : f.device.id },
        item: { uri: `spotify:track:${receipt.trackId}`, type: 'track', duration_ms: 120000 }, progress_ms: 1000, is_playing: true });
      if (op === 'devices' && change.startsWith('foreign-')) return Response.json({ devices: [f.device,
        { id: 'phone', type: 'Smartphone', is_active: change === 'foreign-active' ? true : null }] });
      if (op === 'devices' && change === 'duplicate-target') return Response.json({ devices: [f.device, f.device] });
    });
    await assert.rejects(f.check()); assert.deepEqual(await f.retained(), v2); assert.ok(f.events.every(x => x.startsWith('GET:')));
  }));
}
for (const change of ['player-materializes', 'activity', 'foreign-active', 'volume', 'grant', 'receipt']) {
  test(`v2 second empty pair rejects changed ${change}`, async () => using({ seed: v2, initialPaused: false }, async f => {
    let states = 0;
    f.override(async op => {
      if (op === 'player' && ++states === 2) {
        if (change === 'player-materializes') f.state = { device: { ...f.device, is_active: true },
          item: { uri: `spotify:track:${receipt.trackId}`, type: 'track', duration_ms: 120000 }, progress_ms: 1000, is_playing: false };
        if (change === 'activity') f.device.is_active = true;
        if (change === 'volume') f.device.volume_percent = 10;
        if (change === 'grant') f.changeGrant();
        if (change === 'receipt') { await fs.writeFile(f.filename + '.new', JSON.stringify(v2)); await fs.rename(f.filename + '.new', f.filename); }
      }
      if (op === 'devices' && states === 2 && change === 'foreign-active') return Response.json({ devices: [f.device, { id: 'phone', is_active: true }] });
    });
    await assert.rejects(f.check()); assert.ok(await f.retained());
  }));
}
for (const change of [{ volumeOnly: false }, { baselineEmpty: false }, { volumeRequestPending: true }, { playbackRequestPending: true }]) {
  test(`restart preserves v2 blocked provenance ${JSON.stringify(change)}`, async () => using({ seed: { ...v2, ...change }, initialPaused: false }, async f => {
    await assert.rejects(f.check()); assert.deepEqual(await f.retained(), { ...v2, ...change });
  }));
}
test('persistent pending blocks even fresh paused/original data after restart', async () => using({ seed: { ...v2, volumeRequestPending: true } }, async f => {
  await assert.rejects(f.check()); assert.deepEqual(f.events, []);
}));
test('persistent unconfirmed selection blocks paused/original recovery after restart', async () => using({ seed: { ...v2, volumeOnly: false, playbackRequestPending: true } }, async f => {
  await assert.rejects(f.check()); assert.deepEqual(f.events, []); assert.ok(await f.retained());
}));
test('confirmed activation then interruption before selection may use real paused fallback', async () => using({ seed: { ...v2, volumeOnly: false, playbackRequestPending: false } }, async f => {
  assert.equal((await f.check()).required, false); assert.ok(f.events.every(x => x.startsWith('GET:')));
}));
test('missing v2 false fields do not become safe defaults', async () => {
  const incomplete = { ...v2 }; delete incomplete.volumeOnly;
  await using({ seed: incomplete, initialPaused: false }, async f => { await assert.rejects(f.check()); assert.deepEqual(f.events, []); });
});
test('volume write-ahead and irreversible playback boundary survive fresh receipt reader', async () => using({ seed: false }, async f => {
  const store = createColdVolumeReceipt(f.directory);
  const record = { session: receipt.session, deviceId: receipt.deviceId, trackId: receipt.trackId, coldBaselineEmpty: true, coldInitialTargetActive: false };
  await store.retain(record, 9); await store.setVolumePending(record, true);
  assert.equal((await createColdVolumeReceipt(f.directory).snapshot()).value.volumeRequestPending, true);
  await store.setVolumePending(record, false); await store.crossPlaybackBoundary(record); await store.setPlaybackPending(record, true);
  assert.equal((await createColdVolumeReceipt(f.directory).snapshot()).value.playbackRequestPending, true);
  await store.setPlaybackPending(record, false);
  await store.setVolumePending(record, true); await store.setVolumePending(record, false);
  assert.equal((await createColdVolumeReceipt(f.directory).snapshot()).value.volumeOnly, false);
}));
test('receipt replacement rejects boundary update and preserves replacement', async () => using({ seed: false }, async f => {
  const store = createColdVolumeReceipt(f.directory);
  const record = { session: receipt.session, deviceId: receipt.deviceId, trackId: receipt.trackId, coldBaselineEmpty: true, coldInitialTargetActive: false };
  await store.retain(record, 9);
  const replacement = { ...v2, originalVolume: 10 };
  await fs.writeFile(f.filename + '.new', JSON.stringify(replacement)); await fs.rename(f.filename + '.new', f.filename);
  await assert.rejects(store.crossPlaybackBoundary(record)); assert.deepEqual(await f.retained(), replacement);
}));
test('replacement between activation and selection rejects repeated no-op boundary', async () => using({ seed: false }, async f => {
  const store = createColdVolumeReceipt(f.directory);
  const record = { session: receipt.session, deviceId: receipt.deviceId, trackId: receipt.trackId, coldBaselineEmpty: true, coldInitialTargetActive: false };
  await store.retain(record, 9); await store.crossPlaybackBoundary(record);
  const replacement = { ...v2, volumeOnly: false };
  await fs.writeFile(f.filename + '.new', JSON.stringify(replacement)); await fs.rename(f.filename + '.new', f.filename);
  await assert.rejects(store.crossPlaybackBoundary(record)); assert.deepEqual(await f.retained(), replacement);
}));
test('failed final clear preserves replacement and never resets playback history', async () => using({ seed: false }, async f => {
  const store = createColdVolumeReceipt(f.directory);
  const record = { session: receipt.session, deviceId: receipt.deviceId, trackId: receipt.trackId, coldBaselineEmpty: true, coldInitialTargetActive: false };
  await store.retain(record, 9); await store.crossPlaybackBoundary(record);
  await store.setPlaybackPending(record, true); await store.setPlaybackPending(record, false);
  const replacement = { ...v2, volumeOnly: false, playbackRequestPending: true };
  await fs.writeFile(f.filename + '.new', JSON.stringify(replacement)); await fs.rename(f.filename + '.new', f.filename);
  await assert.rejects(store.clear(record)); assert.deepEqual(await f.retained(), replacement);
}));
test('hung initial mute cannot clear before or after late producer completion', async () => using({ seed: false }, async f => {
  let release;
  f.override((op, init) => init.method === 'PUT' && op === 'volume' ? new Promise(resolve => {
    release = () => { f.device.volume_percent = 0; resolve(new Response(null, { status: 204 })); };
  }) : undefined);
  const keepAlive = setInterval(() => {}, 20);
  try { await assert.rejects(f.prepare()); } finally { clearInterval(keepAlive); }
  assert.equal((await f.retained()).volumeRequestPending, true);
  await assert.rejects(f.check()); const count = f.events.length;
  release(); await new Promise(resolve => setImmediate(resolve));
  f.device.volume_percent = 9;
  await assert.rejects(f.check()); assert.equal(f.events.length, count); assert.ok(await f.retained());
}));
test('cancelled empty read cannot complete recovery when late producer resolves', async () => using({ seed: v2, initialPaused: false }, async f => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), pending = new Promise(resolve => { release = resolve; });
  f.override(async op => { if (op === 'player') { enter(); await pending; } });
  const abort = new AbortController(), checked = f.check(abort.signal), rejected = assert.rejects(checked);
  await entered; abort.abort(); await rejected; release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await f.retained(), v2);
}));
function apiFixture(fetcher) {
  const stamp = { epoch: 1, revision: 1 };
  const api = createDesktopPlaybackApi({ timeoutMs: 20, fetcher,
    vault: { token: async () => 'synthetic', stamp: () => stamp, grantedScopes: async () => ({ ...stamp, scopes: [] }) },
    cooldown: { load: async () => 0, defer: async () => 999999 } });
  const record = { deviceId: receipt.deviceId, stamp, controller: new AbortController() };
  return { api, record, request: () => api.request('volume', record, () => {}, { volumePercent: 0 }) };
}
test('API producer guard tracks late transport separately from unconfirmed state', async () => {
  let release;
  const f = apiFixture(() => new Promise(resolve => { release = resolve; }));
  const keepAlive = setInterval(() => {}, 10);
  try { await assert.rejects(f.request()); } finally { clearInterval(keepAlive); }
  assert.equal(f.api.hasUnsettledWrites(), true);
  release(new Response(null, { status: 204 })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.hasUnsettledWrites(), false);
  assert.equal(f.record.mutationPending, true);
});
test('API response204 does not permanently block ordinary paused recovery', async () => {
  const f = apiFixture(async () => new Response(null, { status: 204 }));
  await f.request(); assert.equal(f.api.hasUnsettledWrites(), false); assert.equal(f.record.mutationPending, true);
});
test('API write transport rejection retains unknown sent status', async () => {
  const f = apiFixture(async () => { throw new Error('synthetic network drop'); });
  await assert.rejects(f.request()); assert.equal(f.api.hasUnsettledWrites(), true);
});
for (const hungOperation of ['player', 'play', 'pause', 'seek']) {
  test(`persistent playback pending covers hanging ${hungOperation} and cleanup`, async () => using({ seed: false, initialPaused: false }, async f => {
    let release, hung = false;
    f.override(async (op, init, url) => {
      if (init.method !== 'PUT') return;
      const disk = await f.retained();
      if (op === 'volume') {
        assert.equal(disk.volumeRequestPending, true);
        f.device.volume_percent = Number(url.searchParams.get('volume_percent'));
        return new Response(null, { status: 204 });
      }
      assert.equal(disk.volumeOnly, false); assert.equal(disk.playbackRequestPending, true);
      f.device.is_active = true;
      if (op === 'play' || op === 'player') f.state = { device: { ...f.device },
        item: { uri: `spotify:track:${receipt.trackId}`, type: 'track', duration_ms: 120000 },
        progress_ms: 50, is_playing: op === 'play', timestamp: 100, actions: { disallows: {} } };
      if (op === 'pause') f.state.is_playing = false;
      if (op === 'seek') f.state.progress_ms = Number(url.searchParams.get('position_ms'));
      if (op === hungOperation && !hung) {
        hung = true;
        // Cleanup sees a naturally paused state; it must not let this clean read
        // or its own safety pause erase the original unknown mutation.
        if (f.state) f.state.is_playing = false;
        return new Promise(resolve => { release = () => resolve(new Response(null, { status: 204 })); });
      }
      return new Response(null, { status: 204 });
    });
    const keepAlive = setInterval(() => {}, 20);
    try { await assert.rejects(f.prepare()); } finally { clearInterval(keepAlive); }
    assert.equal((await f.retained()).playbackRequestPending, true);
    f.device.volume_percent = 9;
    await assert.rejects(f.check()); release(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.check()); assert.equal((await f.retained()).playbackRequestPending, true);
  }));
}
