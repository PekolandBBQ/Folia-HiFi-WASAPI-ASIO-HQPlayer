'use strict';
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const path = require('node:path');
// Inherited r16 integration coverage, with r17 unified acknowledgment expectations: real API/control/audio preparation with synthetic external boundaries.
const root = process.env.FOLIA_REVIEW_ROOT || path.resolve(__dirname, '../..');
const { createDesktopPlaybackControl } = require(path.join(root, 'electron/spotify/desktopPlaybackControl.cjs'));
const { createCableAudioPreparation } = require(path.join(root, 'electron/spotify/cableAudioPreparation.cjs'));
const { createCablePcmQueue } = require(path.join(root, 'electron/spotify/cablePcmQueue.cjs'));
const { QUEUE_BYTES, FRAME_BYTES } = require(path.join(root, 'electron/spotify/cableCaptureProtocol.cjs'));
const { installPreviewDiagnosticSink } = require(path.join(root, 'electron/debug/privatePreviewDiagnosticBus.cjs'));
const track = '3n3Ppam7vgaVa1iaRUc9Lp', other = '4n4Qqam7vgaVa1iaRUc9Lp';
const requestId = '12345678-1234-1234-1234-123456789abc', nextRequestId = '12345678-1234-1234-1234-123456789abd';
const selection = { deviceId: 'review-desktop', captureDeviceId: 'review-capture', renderDeviceId: 'review-render', outputDeviceId: 'review-output', temporaryFormatLease: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanups = [];
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });
function config(ready = true) {
  const mixFormat = { sampleRate: 44100, channels: 2 };
  return { ready, issues: ready ? [] : ['RENDER_RATE_MISMATCH'], temporaryFormatLeaseEligible: true,
    selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le', sampleRateConversion: false,
    capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat },
    render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat },
    sessions: [{ processId: 1234, startedAtUnixMs: 1700000000000, state: 'inactive', identityReadable: true, processName: 'Spotify', executablePath: 'C:\\Synthetic\\Spotify.exe' }],
    route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } };
}
function fixture({ body = 'synthetic acknowledgement pending verification', status = 200, realTime = false, timeoutMs = 60, settleTimeoutMs = 400 } = {}) {
  let clock = 10000, grant = 0, audio, lastMutation = '', pauseReads = 0, hook;
  let activeStateGets = 0, maxStateGets = 0;
  const events = [], captures = [], published = [], waits = [], revocations = [], diagnostics = [], failures = [];
  const now = () => realTime ? Date.now() : clock;
  const uninstall = installPreviewDiagnosticSink({ enabled: () => true, record(type, fields) { diagnostics.push({ type, fields }); return true; } });
  const state = { device: { id: selection.deviceId, name: 'review target', type: 'Computer', is_active: true, is_restricted: false },
    item: { type: 'track', uri: `spotify:track:${other}`, duration_ms: 120000 }, currently_playing_type: 'track', progress_ms: 0, is_playing: false, actions: { disallows: {} } };
  const vault = { stamp: () => ({ epoch: 0, revision: grant }), token: async () => 'synthetic-token-do-not-log',
    grantedScopes: async () => ({ epoch: 0, revision: grant, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const cooldown = { load: async () => 0, defer: async () => now() + 60000 };
  const fetcher = async (address, init) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.spotify.com'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    const op = url.pathname.startsWith('/v1/tracks/') ? 'metadata' : init.method === 'GET' ? url.pathname.endsWith('/devices') ? 'devices' : 'state'
      : url.pathname.endsWith('/pause') ? 'pause' : url.pathname.endsWith('/seek') ? 'seek' : url.pathname.endsWith('/play') ? init.body ? 'select' : 'play' : 'transfer';
    const event = { op, method: init.method, at: now(), url, init }; events.push(event);
    if (op === 'state') { activeStateGets++; maxStateGets = Math.max(maxStateGets, activeStateGets); if (lastMutation === 'pause') pauseReads++; }
    try {
      const override = await hook?.({ op, state, init, url, event, pauseReads });
      if (override) return override;
      if (op === 'metadata') { const id = url.pathname.split('/').at(-1); return Response.json({ id, type: 'track', uri: `spotify:track:${id}`, duration_ms: 120000 }); }
      if (op === 'devices') return Response.json({ devices: [state.device] });
      if (op === 'state') return Response.json(state);
      assert.equal(url.searchParams.get('device_id'), selection.deviceId);
      lastMutation = op;
      if (op === 'select') { const payload = JSON.parse(init.body); state.item.uri = payload.uris[0]; state.progress_ms = payload.position_ms; state.is_playing = true; }
      else if (op === 'pause') state.is_playing = false;
      else if (op === 'play') state.is_playing = true;
      else if (op === 'seek') state.progress_ms = Number(url.searchParams.get('position_ms'));
      else assert.fail('Unexpected transfer');
      return new Response(op === 'pause' ? body : null, { status: op === 'pause' ? status : 204 });
    } finally { if (op === 'state') activeStateGets--; }
  };
  const control = createDesktopPlaybackControl({ vault, cooldown, fetcher, now, timeoutMs, settleTimeoutMs, settleIntervalMs: 100,
    wait: async (ms, signal) => { waits.push(ms); if (realTime) await sleep(ms); else clock += ms; signal?.throwIfAborted(); },
    onRevoke: value => { revocations.push(value); return audio?.revokeSession(value.session, value.code); } });
  const captureHost = {
    inspectRoute: async () => { events.push({ op: 'inspectRoute' }); return config(false); },
    formatProbe: async () => { events.push({ op: 'formatProbe' }); return { state: 'released', verified: true, configuration: config() }; },
    open: async input => {
      events.push({ op: 'captureOpen' });
      const queue = createCablePcmQueue({ onFailure: error => { if (error.code !== 'CANCELLED') input.onFailure(error); } });
      const capture = { session: input.session, queue, stream: queue.stream, generation: captures.length + 1, receivedFrames: () => queue.receivedFrames,
        start: async () => { events.push({ op: 'captureStart' }); return { state: 'running' }; },
        status: async () => ({ state: 'running' }), stop: async () => queue.cancel() };
      input.signal.addEventListener('abort', () => queue.cancel(), { once: true }); captures.push(capture); return capture;
    }
  };
  const media = { add: async input => { events.push({ op: 'publish' }); const entry = { input, revoked: false, url: `http://127.0.0.1:1234/review-${published.length}`, revoke: async () => { entry.revoked = true; } }; published.push(entry); return entry; }, close: async () => {} };
  audio = createCableAudioPreparation({ captureHost, control, vault, cooldown, fetcher, media, now, getSelection: async () => ({ ...selection }), onDiagnostic: value => failures.push(value), cleanupTimeoutMs: 100 });
  cleanups.push(async () => { await audio.close(); await control.dispose(); uninstall(); });
  return { audio, control, captureHost, state, events, captures, published, waits, revocations, diagnostics, failures,
    hook: value => { hook = value; }, changeGrant: () => grant++, advance: ms => clock += ms, pauseReads: () => pauseReads,
    maxStateGets: () => maxStateGets, now, prepare: (id = track, rid = requestId) => audio.prepare(id, rid) };
}
function noCapture(f) { assert.equal(f.published.length, 0); assert.equal(f.captures.length, 0); assert.deepEqual(f.failures, []); }
function rejectedWith(f, code) { assert(f.revocations.some(x => x.code === code), `Expected revoke ${code}: ${JSON.stringify(f.revocations)}`); noCapture(f); }

 test('ambiguous pause is followed by two serial target reads before publication; no capture during pause settlement', async () => {
  const f = fixture(), result = await f.prepare();
  assert.equal(result.playbackTransport, 'cable-pcm'); assert.equal(f.pauseReads(), 2); assert.equal(f.maxStateGets(), 1);
  assert.deepEqual(f.events.slice(f.events.findIndex(x => x.op === 'pause') + 1).map(x => x.op), ['state', 'state', 'publish']);
  assert.deepEqual(f.waits, [100]); assert.equal(f.captures.length, 0);
  assert(!JSON.stringify(result).includes('review-desktop'));
 });
 test('one paused read cannot publish while the second GET is held', async () => {
  const f = fixture(), held = deferred(); f.hook(({ op, pauseReads }) => op === 'state' && pauseReads === 2 ? held.promise : undefined);
  let done = false; const preparing = f.prepare().then(value => { done = true; return value; }); await tick();
  assert.equal(f.pauseReads(), 2); assert.equal(done, false); noCapture(f); held.resolve(Response.json(f.state)); await preparing;
 });
 for (const [label, alter, code] of [
  ['wrong device on second GET', state => { state.device.id = 'wrong'; }, 'DEVICE_ID_MISMATCH'],
  ['new track on second GET', state => { state.item.uri = `spotify:track:${other}`; }, 'TRACK_NOT_CURRENT'],
  ['inactive device', state => { state.device.is_active = false; }, 'DEVICE_INACTIVE'],
  ['restricted device', state => { state.device.is_restricted = true; }, 'DEVICE_RESTRICTED'],
  ['invalid progress', state => { state.progress_ms = -1; }, 'PROTOCOL_INVALID'],
  ['invalid playing flag', state => { state.is_playing = 'false'; }, 'PROTOCOL_INVALID'],
 ]) test(`ambiguous pause rejects ${label}`, async () => {
   const f = fixture(); f.hook(({ op, pauseReads, state }) => { if (op === 'state' && pauseReads >= 2) alter(state); });
   await assert.rejects(f.prepare()); rejectedWith(f, code);
 });
 test('perpetually moving paused position never permits capture or seek', async () => {
  const f = fixture(); f.hook(({ op, pauseReads, state }) => { if (op === 'state' && pauseReads) state.progress_ms += 1; });
  await assert.rejects(f.prepare()); rejectedWith(f, 'PLAYBACK_STATE_UNCONFIRMED'); assert(!f.events.some(x => x.op === 'seek'));
 });
 test('perpetually playing state is rejected within the settlement budget', async () => {
  const f = fixture(); f.hook(({ op, pauseReads, state }) => { if (op === 'state' && pauseReads) state.is_playing = true; });
  await assert.rejects(f.prepare()); rejectedWith(f, 'PLAYBACK_STATE_UNCONFIRMED'); assert(f.pauseReads() <= 5);
 });
 for (const delta of [-1000, 1000]) test(`post-seek target within existing tolerance (${delta}) is accepted`, async () => {
  const f = fixture(); f.hook(({ op, state, url }) => {
   if (op === 'pause') state.progress_ms = 25000;
   if (op === 'seek') { state.progress_ms = Math.max(0, Number(url.searchParams.get('position_ms')) + delta); return new Response(null, { status: 204 }); }
  });
  const result = await f.prepare(); assert.equal(result.pcmOriginMs, Math.max(0, delta)); assert.equal(f.pauseReads(), 4); assert.equal(f.captures.length, 0);
 });
 test('post-seek target outside existing tolerance cannot publish', async () => {
  const f = fixture(); f.hook(({ op, state }) => { if (op === 'pause') state.progress_ms = 25000; if (op === 'seek') return new Response(null, { status: 204 }); });
  await assert.rejects(f.prepare()); rejectedWith(f, 'SEEK_UNCONFIRMED'); assert(f.events.some(x => x.op === 'seek'));
 });
 for (const [label, body, status, code] of [
  ['error JSON', '{"error":{"status":403,"message":"private-sentinel"}}', 200, 'PROTOCOL_INVALID'],
  ['nonempty JSON', '{"status":"ok"}', 200, 'PROTOCOL_INVALID'],
  ['JSON scalar', 'true', 200, 'PROTOCOL_INVALID'],
  ['oversize text', 'x'.repeat(4097), 200, 'PROTOCOL_INVALID'],
  ['malformed UTF-8', new Uint8Array([0xc3, 0x28]), 200, 'PROTOCOL_INVALID'],
  ['401', null, 401, 'AUTH_REQUIRED'], ['403', null, 403, 'API_FORBIDDEN'], ['429', null, 429, 'RATE_LIMITED'], ['500', null, 500, 'API_UNAVAILABLE'],
 ]) test(`rejects ${label} without treating it as an ambiguous acknowledgement`, async () => {
  const f = fixture({ body, status }); await assert.rejects(f.prepare()); rejectedWith(f, code); assert.equal(f.pauseReads(), 0);
  assert(!JSON.stringify(f.diagnostics).includes('private-sentinel')); assert(!JSON.stringify(f.diagnostics).includes('synthetic-token-do-not-log'));
 });
 for (const body of [null, '{}', 'null']) test(`known inert acknowledgement ${body} requires two paused observations`, async () => {
  const f = fixture({ body }); await f.prepare(); assert.equal(f.pauseReads(), 2); assert.deepEqual(f.waits, [100]);
 });
 test('grant revision change during second GET blocks late successful state', async () => {
  const f = fixture(), held = deferred(); f.hook(({ op, pauseReads }) => op === 'state' && pauseReads === 2 ? held.promise : undefined);
  const preparing = f.prepare(); void preparing.catch(() => {}); await tick(); assert.equal(f.pauseReads(), 2); f.changeGrant(); held.resolve(Response.json(f.state));
  await assert.rejects(preparing); rejectedWith(f, 'SESSION_CHANGED');
 });
 test('cancellation during second GET blocks late state and all later mutations', async () => {
  const f = fixture(), held = deferred(); f.hook(({ op, pauseReads }) => op === 'state' && pauseReads === 2 ? held.promise : undefined);
  const preparing = f.prepare(); void preparing.catch(() => {}); await tick(); const count = f.events.length; f.audio.cancel(requestId); held.resolve(Response.json(f.state));
  await assert.rejects(preparing); noCapture(f); assert.equal(f.events.length, count);
 });
 test('a newer preparation supersedes a pending old GET and publishes only the new track', async () => {
  const f = fixture(), held = deferred(); let used = false; f.hook(({ op, pauseReads }) => { if (!used && op === 'state' && pauseReads === 2) { used = true; return held.promise; } });
  const first = f.prepare(); void first.catch(() => {}); await tick();
  const second = f.prepare(other, nextRequestId); void second.catch(() => {}); await tick(); held.resolve(Response.json(f.state));
  await assert.rejects(first); const result = await second; assert.equal(f.published.length, 1); assert.equal(f.audio.lookup(result.url).trackId, other); assert.equal(f.captures.length, 0);
  const selects = f.events.filter(x => x.op === 'select').map(x => JSON.parse(x.init.body).uris[0]); assert.deepEqual(selects, [`spotify:track:${track}`, `spotify:track:${other}`]);
 });
 test('a successful GET arriving after the overall settlement deadline is rejected', async () => {
  const f = fixture(); f.hook(({ op, pauseReads }) => { if (op === 'state' && pauseReads === 2) f.advance(401); });
  await assert.rejects(f.prepare()); noCapture(f);
 });
 test('stalled GET response body times out without opening capture', async () => {
  const f = fixture({ realTime: true }); let stream;
  f.hook(({ op, pauseReads }) => { if (op === 'state' && pauseReads === 1) return new Response(new ReadableStream({ start(value) { stream = value; }, cancel() {} })); });
  const start = Date.now(); const preparing = f.prepare(); void preparing.catch(() => {});
  const observed = await Promise.race([preparing.then(() => 'success', () => 'rejected'), sleep(800).then(() => 'hung')]);
  if (observed === 'hung') { stream?.close(); await preparing.catch(() => {}); }
  assert.equal(observed, 'rejected'); assert(Date.now() - start < 750); noCapture(f);
 });
 test('stalled ambiguous pause response body is rejected without state fallback', async () => {
  const f = fixture({ realTime: true }); f.hook(({ op }) => op === 'pause' ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('unfinished')); }, cancel() {} })) : undefined);
  await assert.rejects(f.prepare()); noCapture(f); assert.equal(f.pauseReads(), 0);
 });
 test('PCM remains gated until playing GET; resume adds no extra confirmation wait', async () => {
  const f = fixture(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url), held = deferred(); let playSeen = false;
  f.hook(({ op }) => { if (op === 'play') playSeen = true; if (op === 'state' && playSeen) return held.promise; });
  const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator](); let delivered = false;
  const first = reader.next().then(value => { delivered = true; return value; }); void first.catch(() => {}); await tick();
  assert.equal(f.captures.length, 1); f.captures[0].queue.push(Buffer.alloc(FRAME_BYTES, 7)); await tick(); assert.equal(delivered, false);
  const waitCount = f.waits.length; held.resolve(Response.json(f.state)); assert.deepEqual((await first).value, Buffer.alloc(FRAME_BYTES, 7)); assert.equal(f.waits.length, waitCount);
  f.hook(undefined); await source.pause(); await reader.return();
 });
 test('exactly two seconds fit while playing confirmation is pending; one extra frame fails closed', async () => {
  const f = fixture(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url), held = deferred(); let playSeen = false;
  f.hook(({ op }) => { if (op === 'play') playSeen = true; if (op === 'state' && playSeen) return held.promise; });
  const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator](); let delivered = false;
  const first = reader.next().then(value => { delivered = true; return value; }); void first.catch(() => {}); await tick();
  const queue = f.captures[0].queue; assert.equal(QUEUE_BYTES, 44100 * 2 * 8); queue.push(Buffer.alloc(QUEUE_BYTES)); await tick(); assert.equal(queue.queuedBytes, QUEUE_BYTES); assert.equal(delivered, false);
  queue.push(Buffer.alloc(FRAME_BYTES)); held.resolve(Response.json(f.state)); await assert.rejects(first); assert.equal(delivered, false); assert.equal(queue.queuedBytes, 0);
  assert(f.failures.some(x => x.errorCode === 'CAPTURE_OVERFLOW')); f.hook(undefined); await reader.return().catch(() => {});
 });
 for (const kind of ['process', 'route', 'format']) test(`${kind} preflight guard still precedes all playback mutations`, async () => {
  const f = fixture(); f.captureHost.formatProbe = async () => { const value = config();
   if (kind === 'process') value.sessions[0].startedAtUnixMs++;
   if (kind === 'route') value.route.spotifyOnlyObserved = false;
   if (kind === 'format') { value.ready = false; value.issues = ['RENDER_RATE_MISMATCH']; }
   return { state: 'released', verified: true, configuration: value };
  };
  await assert.rejects(f.prepare()); noCapture(f); assert(!f.events.some(x => x.method === 'PUT'));
 });
 test('each operation diagnostic follows its own state gate and excludes identity or body', async () => {
  const f = fixture(), held = deferred(); let afterSeek = false, seekReads = 0;
  f.hook(({ op, state, url }) => {
    if (op === 'pause') state.progress_ms = 25000;
    if (op === 'seek') { afterSeek = true; state.progress_ms = Number(url.searchParams.get('position_ms')); return new Response(null, { status: 200 }); }
    if (op === 'state' && afterSeek && ++seekReads === 2) return held.promise;
  });
  const preparing = f.prepare(); void preparing.catch(() => {}); await tick();
  assert.equal(seekReads, 2); noCapture(f);
  assert(!f.diagnostics.some(x => x.fields.endpoint === 'playback-seek' && x.fields.phase === 'state-confirmed'));
  assert(f.diagnostics.some(x => x.fields.endpoint === 'playback-pause' && x.fields.phase === 'state-confirmed'));
  held.resolve(Response.json(f.state)); await preparing;
  const done = f.diagnostics.filter(x => x.fields.phase === 'state-confirmed'); assert.equal(done.length, 2);
  assert.deepEqual(done.map(x => x.fields.endpoint), ['playback-pause', 'playback-seek']);
  assert.equal(done[0].fields.observationCount, 2);
  assert.deepEqual(done[1].fields, { endpoint: 'playback-seek', method: 'PUT', httpStatus: 200, phase: 'state-confirmed', observationCount: 2,
    deviceMatched: true, trackMatched: true, paused: true, playing: false, stablePosition: true, positionWithinTolerance: true });
  assert(!JSON.stringify(f.diagnostics).includes('synthetic acknowledgement')); assert(!JSON.stringify(f.diagnostics).includes(selection.deviceId));
 });
 test('a slow successful pause plus corrective seek can exceed one stage but fit two bounded stages', async () => {
  const f = fixture(); let afterSeek = false, firstReads = 0;
  f.hook(({ op, state, pauseReads }) => {
    if (op === 'pause') state.progress_ms = 25000;
    if (op === 'seek') { afterSeek = true; f.advance(120); }
    if (op === 'state' && pauseReads) {
      if (!afterSeek) f.advance(++firstReads === 1 ? 150 : 100);
      else f.advance(50);
    }
  });
  await f.prepare(); assert.equal(f.pauseReads(), 2); assert.equal(f.captures.length, 0);
  const elapsed = f.now() - f.events.find(x => x.op === 'pause').at;
  assert(elapsed > 400 && elapsed < 800);
 });
 test('the corrective seek stage includes PUT latency and never renews its deadline for retries', async () => {
  const f = fixture(); let afterSeek = false;
  f.hook(({ op, state }) => {
    if (op === 'pause') state.progress_ms = 25000;
    if (op === 'seek') { afterSeek = true; f.advance(300); }
    if (op === 'state' && afterSeek) f.advance(101);
  });
  await assert.rejects(f.prepare()); noCapture(f); assert(!f.diagnostics.some(x => x.fields.endpoint === 'playback-seek' && x.fields.phase === 'state-confirmed'));
 });
 test('a GET transport ignoring AbortSignal is bounded and its late response cannot publish', async () => {
  const f = fixture(), held = deferred(); f.hook(({ op, pauseReads }) => op === 'state' && pauseReads === 1 ? held.promise : undefined);
  const preparing = f.prepare(); void preparing.catch(() => {}); const start = Date.now();
  const observed = await Promise.race([preparing.then(() => 'success', () => 'rejected'), sleep(800).then(() => 'hung')]);
  held.resolve(Response.json(f.state)); await preparing.catch(() => {}); await tick();
  assert.equal(observed, 'rejected'); assert(Date.now() - start < 750); noCapture(f); assert(!f.diagnostics.some(x => x.fields.phase === 'state-confirmed'));
 });
 for (const op of ['play', 'seek']) test(`unknown HTTP 200 on ${op} without its postcondition remains rejected`, async () => {
  const f = fixture(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  f.hook(({ op: actual }) => actual === op ? new Response('synthetic acknowledgement pending verification', { status: 200 }) : undefined);
  if (op === 'seek') await assert.rejects(source.seek(10000));
  else { const open = await source.openReadable(); const reader = open.stream[Symbol.asyncIterator](); await assert.rejects(reader.next()); await reader.return().catch(() => {}); }
  assert(f.revocations.some(x => x.code === (op === 'seek' ? 'SEEK_UNCONFIRMED' : 'PLAYBACK_STATE_UNCONFIRMED')));
 });
 test('a changed track on playing confirmation never emits already buffered PCM', async () => {
  const f = fixture(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url), held = deferred(); let playSeen = false;
  f.hook(({ op }) => { if (op === 'play') playSeen = true; if (op === 'state' && playSeen) return held.promise; });
  const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator]();
  const first = reader.next(); void first.catch(() => {}); await tick(); f.captures[0].queue.push(Buffer.alloc(FRAME_BYTES));
  f.state.item.uri = `spotify:track:${other}`; held.resolve(Response.json(f.state)); await assert.rejects(first);
  assert(f.revocations.some(x => x.code === 'TRACK_NOT_CURRENT')); assert.equal(f.captures[0].queue.queuedBytes, 0);
  f.hook(undefined); await reader.return().catch(() => {});
 });
 for (const [label, body, headers] of [
  ['numeric prefix, text header', '2 synthetic control reply', { 'content-type': 'text/plain' }],
  ['opaque text, binary header', 'synthetic control reply', { 'content-type': 'application/octet-stream' }],
  ['numeric prefix, missing header', '2 synthetic control reply', {}],
  ['opaque text, JSON header', 'synthetic control reply', { 'content-type': 'application/json' }],
 ]) test(`complete UTF-8 ambiguity uses state evidence despite ${label}`, async () => {
  const f = fixture(); f.hook(({ op, state }) => {
    if (op === 'pause') { state.is_playing = false; return new Response(new TextEncoder().encode(body), { status: 200, headers }); }
  });
  await f.prepare(); const after = f.events.slice(f.events.findIndex(x => x.op === 'pause') + 1).map(x => x.op);
  assert.deepEqual(after, ['state', 'state', 'publish']); assert.equal(f.captures.length, 0); assert.deepEqual(f.waits, [100]);
 });
 test('same target is rechecked after preparation before capture can open', async () => {
  const f = fixture(), result = await f.prepare(), source = f.audio.lookup(result.url);
  f.state.device.id = 'new-target-after-preparation'; await assert.rejects(source.openReadable()); assert.equal(f.captures.length, 0);
  assert(f.revocations.some(x => x.code === 'DEVICE_ID_MISMATCH'));
 });
 for (const method of ['readState', 'play', 'pause', 'seek']) test(`changed grant directly revokes the real lease before ${method}`, async () => {
  const f = fixture(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator](), first = reader.next(); await tick();
  f.captures[0].queue.push(Buffer.alloc(FRAME_BYTES)); await first; await source.pause(); await reader.return();
  const session = f.captures[0].session, count = f.events.length; f.changeGrant();
  await assert.rejects(f.control[method](session, 10000), { code: 'SESSION_CHANGED' });
  assert(f.revocations.some(value => value.session === session && value.code === 'SESSION_CHANGED'));
  assert.equal(f.events.length, count); assert.equal(f.audio.lookup(prepared.url), null);
  await assert.rejects(f.control.readState(session), { code: 'STALE_SESSION' });
 });
 test('new diagnostic facts reject out-of-range counts, string booleans, raw IDs and accessors', async () => {
  const f = fixture();
  const { reportSpotifyPlaybackControl } = require(path.join(root, 'electron/spotify/requestDiagnostics.cjs'));
  const bools = ['deviceMatched', 'trackMatched', 'paused', 'playing', 'stablePosition', 'positionWithinTolerance', 'progressPlausible', 'emptyState'];
  for (const observationCount of [-1, 10002, Infinity, NaN, 2.5, '2', 'raw-device-id']) {
    reportSpotifyPlaybackControl('playback-pause', 'PUT', 200, { phase: 'state-confirmed', observationCount,
      ...Object.fromEntries(bools.map(key => [key, 'raw-device-id'])), deviceId: 'raw-device-id', body: 'private-body' });
    assert.deepEqual(f.diagnostics.at(-1).fields, { endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'state-confirmed' });
  }
  const observation = { phase: 'state-confirmed' }; let invoked = 0;
  for (const key of ['observationCount', ...bools]) Object.defineProperty(observation, key, { get() { invoked++; return 'private-body'; } });
  reportSpotifyPlaybackControl('playback-pause', 'PUT', 200, observation); assert.equal(invoked, 0);
  assert(!JSON.stringify(f.diagnostics).includes('raw-device-id')); assert(!JSON.stringify(f.diagnostics).includes('private-body'));
 });
 test('valid timestamps older than the pre-pause playing observation cannot confirm pause', async () => {
  const f = fixture(); f.hook(({ op, state }) => { if (op === 'select') state.timestamp = 2000; if (op === 'pause') state.timestamp = 1000; });
  await assert.rejects(f.prepare()); noCapture(f); assert(!f.diagnostics.some(x => x.fields.phase === 'state-confirmed'));
 });
 test('two fresh paused timestamps retain the same two-read completion contract', async () => {
  const f = fixture(); f.hook(({ op, state }) => { if (op === 'select') state.timestamp = 2000; if (op === 'pause') state.timestamp = 2001; });
  await f.prepare(); assert.equal(f.pauseReads(), 2); assert.deepEqual(f.waits, [100]); assert.equal(f.captures.length, 0);
 });
 test('regression after the first valid paused timestamp requires a fresh stable pair', async () => {
  const f = fixture(), timestamps = [2002, 2001, 2003, 2003];
  f.hook(({ op, state, pauseReads }) => { if (op === 'select') state.timestamp = 2000; if (op === 'state' && pauseReads) state.timestamp = timestamps[pauseReads - 1] ?? 2003; });
  await f.prepare(); assert.equal(f.pauseReads(), 4); assert.deepEqual(f.waits, [100, 100, 100]); assert.equal(f.captures.length, 0);
 });
 for (const timestamp of [null, '2001', -1, 1.5]) test(`invalid optional timestamp ${JSON.stringify(timestamp)} does not replace required identity/state/position checks`, async () => {
  const f = fixture(); f.hook(({ op, state }) => { if (op === 'select') state.timestamp = 2000; if (op === 'pause') state.timestamp = timestamp; });
  await f.prepare(); assert.equal(f.pauseReads(), 2); assert.deepEqual(f.waits, [100]); assert.equal(f.captures.length, 0);
 });
 test('C1 control characters cannot become opaque pause acknowledgment', async () => {
  const f = fixture({ body: 'synthetic\u0080control reply' }); await assert.rejects(f.prepare()); rejectedWith(f, 'PROTOCOL_INVALID'); assert.equal(f.pauseReads(), 0);
 });
 test('real elapsed pause plus seek can exceed a single phase without inheriting its expired timer', async () => {
  const f = fixture({ realTime: true, timeoutMs: 1000 }); let afterSeek = false;
  f.hook(async ({ op, state, pauseReads }) => {
    if (op === 'pause') state.progress_ms = 25000;
    if (op === 'seek') { afterSeek = true; await sleep(120); }
    if (op === 'state' && pauseReads) await sleep(afterSeek ? 40 : 80);
  });
  const result = await f.prepare(); const elapsed = f.now() - f.events.find(x => x.op === 'pause').at;
  assert.equal(result.pcmOriginMs, 0); assert(elapsed > 400 && elapsed < 800, `Expected two bounded phases, elapsed ${elapsed}`);
  assert.equal(f.events.filter(x => x.op === 'seek').length, 1); assert.equal(f.captures.length, 0);
 });
