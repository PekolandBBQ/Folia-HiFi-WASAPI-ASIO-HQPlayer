'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
// Production source, setup, controller, owned-route host and C# core; Spotify,
// Windows discovery, capture and downstream audio are explicit fixture boundaries.
process.env.FOLIA_SOURCE_TEST_APP ||= path.resolve(__dirname, '../..');
process.env.FOLIA_NATIVE_FIXTURE_DIRECTORY ||= '/workspace/scratch/d96e392874a5/folia-rebuild-r34/source-lifecycle/final-test-snapshot/native';
const { fixture, TRACK, OTHER, delay } = require('./source-fixture.cjs');
const THIRD = '5n5Rram7vgaVa1iaRUc9Lp';
const unhandled = [];
process.on('unhandledRejection', error => unhandled.push({ code: error.code, message: error.message }));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const observe = task => task.then(value => ({ value }), error => ({ error }));
async function until(check) {
  const at = performance.now();
  while (!check()) { if (performance.now() - at > 6000) throw new Error('Fixture condition timed out'); await delay(5); }
}
const selects = f => f.requests.filter(r => r.operation === 'select').length;
const cached = (f, id) => f.officialMetadata.get(id, f.officialMetadata.bind());
const releaseResult = f => f.bridge.transcript.filter(e => e.type === 'native-result' && e.operation === 'release').at(-1);
function gateRestore(f) {
  const gate = deferred(), entered = deferred();
  let count = 0;
  f.hooks.native = async operation => { if (operation === 'release' && count++ === 0) { entered.resolve(); await gate.promise; } };
  return { gate, entered };
}
async function readyReads(f, at) {
  await until(() => ['metadata', 'devices'].every(operation => f.requests.slice(at).some(r => r.operation === operation && r.finishedMs)));
}
async function withFixture(name, task, options = {}) {
  const f = await fixture({ nativeBridge: true, realSetup: true, sharedMetadata: true, ...options });
  let failure;
  try { await task(f); }
  catch (error) { failure = error; throw error; }
  finally {
    fs.writeFileSync(path.join(__dirname, 'results', name + '.json'), JSON.stringify({ name, passed: !failure,
      error: failure && { code: failure.code, message: failure.message, stack: failure.stack }, requests: f.requests,
      events: f.events, native: f.bridge.transcript, jsArtifacts: f.bridge.jsArtifacts, nativeArtifacts: f.bridge.artifacts }, null, 2));
    await f.close();
  }
}

test('two GETs finish during slow old restore; selection, capture and new lease wait', () => withFixture('restore-barrier', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  const preparing = observe(f.prepare(OTHER));
  await barrier.entered.promise; await readyReads(f, at);
  assert.equal(selects(f), 1); assert.equal(f.captures.length, 1); assert.ok(f.captures.every(c => c.stopped));
  assert.equal(cached(f, OTHER), null, 'speculation cannot publish metadata before restore');
  const before = f.bridge.transcript.filter(e => e.type === 'native-send' && e.operation === 'acquire').length;
  assert.equal(before, 1); barrier.gate.resolve();
  const prepared = await preparing; assert.ifError(prepared.error);
  assert.equal(selects(f), 2); assert.equal(f.captures.length, 1, 'prepare cannot start audio');
  const nextSelect = f.requests.filter(r => r.operation === 'select')[1];
  assert.ok(releaseResult(f).value.exactOriginalRolesRestored); assert.ok(releaseResult(f).atMs < nextSelect.startedMs);
  assert.equal(cached(f, OTHER).facts.trackId, OTHER); await active.reader.return();
}));

test('real native restore failure discards speculative facts and blocks every next mutation', () => withFixture('restore-failure', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  const preparing = observe(f.prepare(OTHER));
  await barrier.entered.promise; await readyReads(f, at); f.hooks.failRestore = true; barrier.gate.resolve();
  const result = await preparing; assert.ok(result.error); assert.match(result.error.message, /restore-unconfirmed/);
  assert.equal(releaseResult(f).value.exactOriginalRolesRestored, false);
  assert.equal(selects(f), 1); assert.equal(f.captures.length, 1); assert.equal(cached(f, OTHER), null);
  const later = await observe(f.prepare(THIRD)); assert.ok(later.error); assert.equal(selects(f), 1);
  f.hooks.failRestore = false; await active.reader.return();
}));

test('cancel during restore revokes both finished snapshots without publishing a source', () => withFixture('cancel-restore', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length, request = randomUUID();
  const preparing = observe(f.audio.prepare(OTHER, request));
  await barrier.entered.promise; await readyReads(f, at); f.audio.cancel(request); barrier.gate.resolve();
  const result = await preparing; assert.ok(result.error); assert.equal(selects(f), 1); assert.equal(cached(f, OTHER), null);
  assert.equal(f.captures.length, 1); await active.reader.return();
}));

test('newer track intent wins while both preparations wait on the same old restore', () => withFixture('latest-intent', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  const stale = observe(f.prepare(OTHER)); await barrier.entered.promise; await readyReads(f, at);
  const latest = observe(f.prepare(THIRD)); await until(() => f.requests.some(r => r.operation === 'metadata' && r.url.endsWith(THIRD) && r.finishedMs));
  barrier.gate.resolve(); const [old, next] = await Promise.all([stale, latest]);
  assert.ok(old.error); assert.ifError(next.error); assert.equal(f.state.item.uri, `spotify:track:${THIRD}`);
  assert.equal(selects(f), 2); assert.equal(cached(f, OTHER), null); assert.equal(cached(f, THIRD).facts.trackId, THIRD);
  assert.equal(f.captures.length, 1); await active.reader.return();
}));

test('changed account during restore cannot authorize a new selection', () => withFixture('account-change', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  const preparing = observe(f.prepare(OTHER)); await barrier.entered.promise; await readyReads(f, at);
  f.changeGrant(); barrier.gate.resolve(); assert.ok((await preparing).error);
  assert.equal(selects(f), 1); assert.equal(cached(f, OTHER), null); await active.reader.return();
}));

test('changed market with the same vault stamp revokes metadata snapshot', () => withFixture('market-change', async f => {
  f.officialMetadata.profile({ id: 'fixture-account', country: 'US' });
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  const preparing = observe(f.prepare(OTHER)); await barrier.entered.promise; await readyReads(f, at);
  f.officialMetadata.profile({ id: 'fixture-account', country: 'JP' }); barrier.gate.resolve();
  assert.ok((await preparing).error); assert.equal(selects(f), 1); assert.equal(cached(f, OTHER), null); await active.reader.return();
}));

test('changed setup generation rejects the old selection receipt', () => withFixture('selection-change', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  const preparing = observe(f.prepare(OTHER)); await barrier.entered.promise; await readyReads(f, at);
  f.setup.clear(); barrier.gate.resolve(); assert.ok((await preparing).error);
  assert.equal(selects(f), 1); assert.equal(cached(f, OTHER), null); await active.reader.return();
}));

test('five-second devices expiry re-reads once after restoration before using a target', () => withFixture('expired-devices', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  const preparing = observe(f.prepare(OTHER)); await barrier.entered.promise; await readyReads(f, at);
  const snapshotReadyAt = Date.now();
  await delay(5100); barrier.gate.resolve(); const result = await preparing; assert.ifError(result.error);
  assert.equal(f.requests.slice(at).filter(r => r.operation === 'devices').length, 2);
  assert.equal(f.requests.slice(at).filter(r => r.operation === 'metadata').length, 1);
  const entry = cached(f, OTHER);
  assert.ok(entry.observedAt <= snapshotReadyAt + 50, 'delayed commit must preserve the GET completion timestamp');
  const shift = entry.observedAt + 60000 - Date.now();
  f.advance(shift); assert.equal(cached(f, OTHER), null, 'TTL is measured from response, not post-restore commit');
  f.advance(-shift);
  assert.equal(selects(f), 2); await active.reader.return();
}));

for (const operation of ['metadata', 'devices']) test(`early ${operation} error is retained while restore is pending`, () => withFixture('early-error-' + operation, async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length;
  f.hooks.http = input => input.operation === operation ? { status: 403, body: { error: { status: 403 } } } : undefined;
  const preparing = observe(f.prepare(OTHER)); await barrier.entered.promise; await readyReads(f, at); await delay(20);
  assert.equal(selects(f), 1); barrier.gate.resolve(); const result = await preparing;
  assert.ok(result.error); assert.match(result.error.message, /forbidden/); assert.equal(cached(f, OTHER), null);
  assert.equal(selects(f), 1); await active.reader.return();
}));

test('late read producer after cancellation cannot populate shared metadata or start audio', () => withFixture('late-read-cancel', async f => {
  const active = await f.start(), barrier = gateRestore(f), readGate = deferred(), at = f.requests.length, request = randomUUID();
  f.hooks.http = async ({ operation }) => { if (['metadata', 'devices'].includes(operation)) await readGate.promise; };
  const preparing = observe(f.audio.prepare(OTHER, request)); await barrier.entered.promise;
  await until(() => ['metadata', 'devices'].every(operation => f.requests.slice(at).some(r => r.operation === operation)));
  f.audio.cancel(request); barrier.gate.resolve(); assert.ok((await preparing).error);
  readGate.resolve(); await delay(30); assert.equal(cached(f, OTHER), null); assert.equal(selects(f), 1);
  assert.equal(f.captures.length, 1); await active.reader.return();
}));

test('indefinite paused hold has no reads/capture; paused seek and same-track resume preserve heard origin', () => withFixture('pause-seek-handoff', async f => {
  const active = await f.start(); await active.source.pause({ positionMs: 17000 }); await active.reader.return();
  const at = f.requests.length, captures = f.captures.length, native = f.bridge.transcript.length;
  f.advance(24 * 3600000); await delay(20);
  assert.equal(f.requests.length, at); assert.equal(f.captures.length, captures); assert.equal(f.bridge.transcript.length, native);
  f.advance(-24 * 3600000); // Native proof uses wall time; return to the shared clock before resuming.
  const checkpoint = await active.source.seek(29000); assert.equal(checkpoint.positionMs, 29000); assert.equal(f.state.is_playing, false);
  assert.ok(f.captures.every(c => c.stopped)); assert.equal(releaseResult(f), undefined);
  const resumed = await f.startPrepared(active.prepared, 29000); assert.equal(resumed.opened.positionMs, 29000);
  assert.equal(resumed.block.value[0], 2); assert.equal(selects(f), 1);
  await resumed.source.stop(); await resumed.reader.return(); assert.equal(releaseResult(f).value.exactOriginalRolesRestored, true);
}));


test('device receipt is exact-owner, opaque, single-use and bypasses unrelated ambient handoffs', () => withFixture('receipt-ownership', async f => {
  const session = randomUUID(), signal = new AbortController().signal;
  const receipt = await f.control.prefetchDevices({ session, signal });
  assert.deepEqual(Object.keys(receipt), []);
  assert.throws(() => f.control.readPrefetchedDevices(receipt, { session: randomUUID(), signal }), { code: 'CANCELLED' });
  assert.throws(() => f.control.readPrefetchedDevices(receipt, { session, signal: new AbortController().signal }), { code: 'CANCELLED' });
  await f.control.listDevices({ forPreparation: true });
  const at = f.requests.length;
  const args = { session, deviceId: f.state.device.id, trackId: TRACK, durationMs: 120000, preparationDevices: receipt };
  const prepared = await f.control.prepare(args); assert.equal(prepared.isPlaying, false);
  assert.equal(f.requests.slice(at).filter(r => r.operation === 'devices').length, 0);
  const after = f.requests.length;
  await assert.rejects(f.control.prepare(args), { code: 'CANCELLED' });
  assert.equal(f.requests.length, after);
}));

test('clock rollback permanently invalidates a devices receipt and falls back to a fresh GET', () => withFixture('receipt-clock-rollback', async f => {
  const session = randomUUID(), signal = new AbortController().signal;
  const receipt = await f.control.prefetchDevices({ session, signal });
  f.advance(-1000); assert.equal(f.control.readPrefetchedDevices(receipt, { session, signal }), null);
  f.advance(1000); assert.equal(f.control.readPrefetchedDevices(receipt, { session, signal }), null);
  const at = f.requests.length;
  await f.control.prepare({ session, deviceId: f.state.device.id, trackId: TRACK, durationMs: 120000, preparationDevices: receipt });
  assert.equal(f.requests.slice(at).filter(r => r.operation === 'devices').length, 1);
}));

test('cancel after the restore barrier returns promptly even when metadata transport ignores AbortSignal', () => withFixture('ignored-abort-cancel', async f => {
  const readGate = deferred(), request = randomUUID(); f.hooks.ignoreMetadataAbort = true;
  f.hooks.http = async ({ operation }) => { if (operation === 'metadata') await readGate.promise; };
  const preparing = observe(f.audio.prepare(TRACK, request));
  await until(() => f.requests.some(r => r.operation === 'metadata'));
  f.audio.cancel(request);
  const result = await Promise.race([preparing, delay(500).then(() => { throw new Error('Cancelled source still waits for ignored metadata abort'); })]);
  assert.ok(result.error); assert.equal(selects(f), 0); assert.equal(f.captures.length, 0);
  readGate.resolve(); await delay(30); assert.equal(cached(f, TRACK), null);
}));

test('one real GET failure returns promptly and retires a still-pending sibling read', () => withFixture('early-error-blocked-sibling', async f => {
  const readGate = deferred(); f.hooks.ignoreMetadataAbort = true;
  f.hooks.http = async ({ operation }) => {
    if (operation === 'metadata') await readGate.promise;
    if (operation === 'devices') return { status: 403, body: { error: { status: 403 } } };
  };
  const preparing = observe(f.prepare(TRACK));
  const result = await Promise.race([preparing, delay(500).then(() => { throw new Error('Known device failure hidden by blocked metadata'); })]);
  assert.ok(result.error); assert.match(result.error.message, /forbidden/); assert.equal(selects(f), 0);
  readGate.resolve(); await delay(30); assert.equal(cached(f, TRACK), null);
}));


test('actual unexpired vault keeps both preparation GETs overlapping old restoration without a refresh', () => withFixture('real-vault-overlap', async f => {
  const active = await f.start(), barrier = gateRestore(f), at = f.requests.length, stamp = f.vault.stamp();
  const preparing = observe(f.prepare(OTHER)); await barrier.entered.promise; await readyReads(f, at);
  assert.equal(f.refreshes.length, 0); assert.deepEqual(f.vault.stamp(), stamp);
  assert.equal(cached(f, OTHER), null); assert.equal(selects(f), 1);
  barrier.gate.resolve(); assert.ifError((await preparing).error);
  assert.equal(f.refreshes.length, 0); assert.equal(selects(f), 2); await active.reader.return();
}, { realVault: true }));

test('no unhandled rejection escaped speculative operations', async () => { await delay(30); assert.deepEqual(unhandled, []); });
