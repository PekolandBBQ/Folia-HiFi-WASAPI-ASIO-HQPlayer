'use strict';
// Explicit test boundary: local HTTP simulates Spotify; route/capture are native boundary doubles.
// The production API, control, source preparation, owned audio coordinator and PCM queue run unchanged.
const http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = process.env.FOLIA_SOURCE_TEST_APP ? path.join(process.env.FOLIA_SOURCE_TEST_APP, 'electron') : path.resolve(__dirname, '../application/electron');
const { createDesktopPlaybackControl } = require(path.join(root, 'spotify/desktopPlaybackControl.cjs'));
const { createCableAudioPreparation } = require(path.join(root, 'spotify/cableAudioPreparation.cjs'));
const { createCablePcmQueue } = require(path.join(root, 'spotify/cablePcmQueue.cjs'));
const TRACK = '3n3Ppam7vgaVa1iaRUc9Lp', OTHER = '4n4Qqam7vgaVa1iaRUc9Lp';
const binding = { expectedSpotifyProcessId: 1234, expectedSpotifyStartedAtUnixMs: 1700000000000,
  expectedSpotifyStartTimeUtcTicks: '638355968000000000', expectedOriginalRoles: [{ role: 0, original: null }, { role: 1, original: 'exact-original-role1' }] };
const error = code => Object.assign(new Error(code), { code });
const selection = { deviceId: 'local-fake-desktop', captureDeviceId: 'local-fake-capture', renderDeviceId: 'local-fake-render',
  temporaryFormatLease: true, automaticRouting: true };
async function fixture({ cold = false, getDelayMs = 1, putDelayMs = 1, pcmGateMs = 0, productionLifecycle = process.env.FOLIA_TEST_PRODUCTION_LIFECYCLE === '1', sharedMetadata = true, nativeBridge = false, realSetup = true, realVault = false } = {}) {
  const fs = require('node:fs/promises');
  const setupDirectory = await fs.mkdtemp(path.join(__dirname, 'state-'));
  let audio, control, nowOffset = 0, vaultOffset = 0, selected = !cold, activeLease, routeSerial = 0, revision = 0;
  const events = [], captures = [], leases = [], requests = [];
  const at = () => Date.now() + nowOffset;
  const state = { device: { id: selection.deviceId, type: 'computer', is_active: !cold, is_restricted: false },
    item: { type: 'track', uri: `spotify:track:${OTHER}`, duration_ms: 120000 },
    currently_playing_type: 'track', progress_ms: 0, is_playing: false, actions: { disallows: {} } };
  const hooks = { http: null, native: null, capture: null, reply: null };
  let lastAnchor = Date.now();
  function progress() { if (state.is_playing) { state.progress_ms += Date.now() - lastAnchor; lastAnchor = Date.now(); } }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), buffers = [];
      for await (const bytes of req) buffers.push(bytes);
      const bodyText = Buffer.concat(buffers).toString();
      const operation = url.pathname.startsWith('/v1/tracks/') ? 'metadata' : req.method === 'GET'
        ? url.pathname.endsWith('/devices') ? 'devices' : 'state'
        : url.pathname.endsWith('/pause') ? 'pause' : url.pathname.endsWith('/seek') ? 'seek'
        : url.pathname.endsWith('/play') ? bodyText ? 'select' : 'play' : 'transfer';
      events.push(`http:${operation}`); const observedRequest = { operation, method: req.method, url: url.pathname + url.search, at: at(), startedMs: performance.now() }; requests.push(observedRequest);
      res.once('finish', () => { observedRequest.finishedMs = performance.now(); observedRequest.elapsedMs = observedRequest.finishedMs - observedRequest.startedMs; });
      await delay(req.method === 'GET' ? getDelayMs : putDelayMs); observedRequest.delayActualMs = performance.now() - observedRequest.startedMs; progress();
      const overridden = await hooks.http?.({ operation, state, url, bodyText, req });
      if (overridden) { res.writeHead(overridden.status || 200, { 'content-type': 'application/json' }); res.end(overridden.raw ?? JSON.stringify(overridden.body)); return; }
      const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (operation === 'metadata') { const id = url.pathname.split('/').at(-1); return json({ id, type: 'track', uri: `spotify:track:${id}`, duration_ms: 120000, is_local:false, is_playable:true, name:'Fixture track', album:{id:'6n6Rram7vgaVa1iaRUc9Lp',name:'Fixture album'}, artists:[{id:'7n7Rram7vgaVa1iaRUc9Lp',name:'Fixture artist'}] }); }
      if (operation === 'devices') return json({ devices: [state.device] });
      if (operation === 'state') { if (!selected) { res.writeHead(204); res.end(); } else json(state); return; }
      if (operation !== 'transfer') assert.equal(url.searchParams.get('device_id'), selection.deviceId, 'every command must target exact device_id');
      if (operation === 'select') { const body = JSON.parse(bodyText); selected = true; state.device.is_active = true;
        state.item.uri = body.uris[0]; state.progress_ms = body.position_ms; state.is_playing = true; lastAnchor = Date.now(); }
      else if (operation === 'pause') state.is_playing = false;
      else if (operation === 'play') { state.is_playing = true; lastAnchor = Date.now(); }
      else if (operation === 'seek') { state.progress_ms = Number(url.searchParams.get('position_ms')); lastAnchor = Date.now(); }
      else if (operation === 'transfer') { assert.deepEqual(JSON.parse(bodyText), { device_ids: [selection.deviceId], play: false }); state.device.is_active = true; }
      else throw new Error('Unsupported source request');
      res.writeHead(204); res.end();
    } catch (caught) { res.writeHead(500); res.end(JSON.stringify({ error: caught.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const fetcher = (url, init) => { const parsed = new URL(url); assert.equal(parsed.origin, 'https://api.spotify.com');
    return fetch(`http://127.0.0.1:${address.port}${parsed.pathname}${parsed.search}`,
      hooks.ignoreMetadataAbort && parsed.pathname.startsWith('/v1/tracks/') ? { ...init, signal: undefined } : init); };
  let vault = { token: async () => 'local-fake-token-not-a-credential', stamp: () => ({ epoch: 0, revision }),
    grantedScopes: async () => ({ epoch: 0, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const refreshes = [];
  if (realVault) {
    vault = require(path.join(root, 'spotify/sessionVault.cjs')).createSessionVault({ directory: path.join(setupDirectory, 'fake-vault'),
      now: () => Date.now() + vaultOffset,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
      fetcher: async (url, init) => { assert.equal(url, 'https://accounts.spotify.com/api/token'); assert.equal(init.method, 'POST');
        refreshes.push({ atMs: performance.now(), method: init.method });
        return await hooks.refresh?.() || Response.json({ access_token: 'synthetic-refreshed-not-a-credential', expires_in: 3600 }); },
    });
    await vault.save({ access_token: 'synthetic-initial-not-a-credential', refresh_token: 'synthetic-refresh-not-a-credential',
      clientId: 'synthetic-client', expiresAt: Date.now() + 120000,
      scope: 'user-read-playback-state user-modify-playback-state' });
  }
  const cooldown = { load: async () => 0, defer: async () => at() + 60000 };
  let routeLifecycle = {
    availability: async () => ({ supported: true, productionQualified: true }),
    inspect: async () => { events.push('route:inspect'); if (!selected) throw error('EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN'); return { binding }; },
    async acquire(input) {
      events.push('route:acquire'); assert.equal(activeLease, undefined, 'no new owner before exact restore');
      assert.equal(state.is_playing, false); assert.equal(input.binding, binding);
      const lease = { session: input.session, generation: ++routeSerial, restored: false, selectedTrackId: input.selectedSourceUri.slice(14), captureStoppedFact: true,
        publicationClosed: true, phase: 'heldPaused', interval: 0,
        get released() { return this.restored; },
        async authorizePreparedSelection() { events.push('route:authorize-selection'); await hooks.native?.('authorize-selection', this); this.phase = 'prepared'; },
        async completePreparedSelection() { events.push('route:complete'); assert.equal(state.is_playing, false);
          assert.equal(state.item.uri, `spotify:track:${this.selectedTrackId}`); this.phase = 'prepared'; },
        captureOpening() { this.captureStoppedFact = false; }, capturePrepared() {}, captureStarting() {},
        captureStopped() { this.captureStoppedFact = true; }, publicationStarted() { this.publicationClosed = false; },
        publicationStopped() { this.publicationClosed = true; }, confirmPaused() {},
        async armCaptureInterval(proof) { events.push('route:arm'); assert.ok(proof.captureGeneration > this.interval); this.interval = proof.captureGeneration; },
        async authorizeResume() { events.push('route:authorize-resume'); assert.equal(state.is_playing, false); },
        async verifyActive() { events.push('route:verify'); await hooks.native?.('verify', this); assert.equal(state.is_playing, true); },
        async suspendPaused() { events.push('route:suspend'); await hooks.native?.('suspend', this);
          assert.equal(this.captureStoppedFact, true); assert.equal(this.publicationClosed, true); assert.equal(state.is_playing, false);
          assert.equal(captures.filter(c => !c.stopped).length, 0, 'no capture or format holder during held pause'); this.phase = 'suspended'; },
        async resumePreparation({ selectedTrackId }) { events.push('route:resume-preparation'); await hooks.native?.('resume', this);
          assert.equal(this.phase, 'suspended'); assert.equal(selectedTrackId, this.selectedTrackId); this.phase = 'prepared'; },
        async release() { events.push('route:release'); await hooks.native?.('release', this);
          assert.equal(this.captureStoppedFact, true); assert.equal(this.publicationClosed, true); assert.equal(state.is_playing, false);
          this.restored = true; activeLease = undefined; },
      };
      activeLease = lease; leases.push(lease); return lease;
    },
  };
  let bridge;
  if (nativeBridge) productionLifecycle = true;
  if (productionLifecycle) {
    const { createOwnedRouteLifecycle } = require(path.join(root, 'spotify/ownedRouteLifecycle.cjs'));
    const { nativeHostBoundary } = require('/workspace/scratch/d96e392874a5/folia-rebuild-r34/source-lifecycle/tests/native-host-boundary.cjs');
    const host = nativeBridge ? bridge = require('./native-service-bridge.cjs').createNativeServiceBridge({ getControl: () => control,
      getState: () => state, captures, events, hooks, cold }) : nativeHostBoundary({ selection, binding, events, leases, captures, hooks,
      getControl: () => control, selected: () => selected, fail: error });
    routeLifecycle = createOwnedRouteLifecycle({ host });
  }
  control = createDesktopPlaybackControl({ vault, cooldown, fetcher, now: at, settleTimeoutMs: 4000, settleIntervalMs: 50,
    readRoutePcmEvidence: (session, generation) => productionLifecycle ? routeLifecycle.pcmStopped(session, generation) : leases.some(lease => lease.session === session && lease.generation === generation && lease.captureStoppedFact && lease.publicationClosed),
    onRevoke: value => { events.push(`control:revoke:${value.code}`); void audio?.revokeSession(value.session, value.code).catch(() => {}); } });
  const captureHost = { devices: async () => ({ spotifyRunning: true, endpoints: [{id: selection.captureDeviceId,name:'Fixture capture',flow:'capture',supportedBaseCable:true},{id:selection.renderDeviceId,name:'Fixture render',flow:'render',supportedBaseCable:true}] }), inspectRoute: async () => { throw new Error('Automatic source must use owned native route proof'); },
    async close() { events.push('capture:close'); for (const c of captures) { c.stopped = true; c.queue.cancel(); } },
    async open(input) {
      events.push('capture:open'); assert.equal(state.is_playing, false); await hooks.capture?.('open');
      const generation = captures.length + 1, queue = createCablePcmQueue({ bufferedBootstrap: true });
      const capture = { queue, generation, stopped: false, receivedFrames: () => queue.receivedFrames, stream: queue.stream,
        ownedSilentRenderLease: () => ({ captureSession: input.session, captureGeneration: generation, endpointId: selection.renderDeviceId,
          sessionInstanceId: `local-fake-format-${generation}`, groupingId: randomUUID(), processId: 4321, startedAtUtcTicks: '638355968000000001' }),
        async start() { events.push('capture:start'); await delay(pcmGateMs); queue.push(Buffer.alloc(8, generation)); },
        async promote() { events.push('capture:promote'); await hooks.capture?.('promote'); return { capturedFrames: queue.receivedFrames }; },
        beginPublication() { events.push('capture:publish'); return queue.beginPublication(queue.receivedFrames); },
        async status() { events.push('capture:status'); },
        async stop() { events.push('capture:stop'); queue.cancel(); },
        async stopVerified() { events.push('capture:stop-verified'); await hooks.capture?.('stopVerified'); capture.stopped = true; queue.cancel(); },
      };
      captures.push(capture); input.signal.addEventListener('abort', () => queue.cancel(), { once: true }); return capture;
    },
  };
  let urls = 0;
  const media = { add: async () => ({ url: `http://127.0.0.1/local-fake-pcm/${++urls}`, revoke: async () => {} }), close: async () => {} };
  const officialMetadata = sharedMetadata ? require(path.join(root,'spotify/officialTrackMetadata.cjs')).createOfficialTrackMetadata({ getStamp: vault.stamp, now: at }) : undefined;
  // Production setup uses a real on-disk selection. Only endpoint/process inventory is a boundary fixture.
  await fs.writeFile(path.join(setupDirectory,'cable-setup.json'), JSON.stringify({schema:1,enabled:true,automaticRouteSchema:1,spotifyClientOutputConfirmed:true,
    selection:{connectDeviceId:selection.deviceId,captureDeviceId:selection.captureDeviceId,renderDeviceId:selection.renderDeviceId,
      internal44100Confirmed:true,spotifyOnlyConfirmed:false,defaultsConfirmed:true}}));
  const setup = realSetup ? require(path.join(root,'spotify/cableSetup.cjs')).createCableSetup({ directory:setupDirectory,captureHost,control,routeLifecycle,platform:'win32',now:at }) : null;
  audio = createCableAudioPreparation({ captureHost, control, vault, cooldown,
    getSelection: options => setup ? setup.getSelection(options) : Promise.resolve(selection),
    ...(typeof setup?.prefetchSelection==='function' ? {prefetchSelection:options=>setup.prefetchSelection(options)}:{}),
    routeLifecycle, fetcher, media, now: at, officialMetadata });
  return { audio, control, setup, vault, refreshes, state, requests, captures, leases, events, hooks, routeLifecycle, officialMetadata, bridge, captureHost, setupDirectory,
    advanceVault: ms => { vaultOffset += ms; },
    advance: ms => { nowOffset += ms; }, changeGrant: () => revision++,
    prepare: (trackId = TRACK) => audio.prepare(trackId, randomUUID()),
    async start(trackId = TRACK) { const prepared = await this.prepare(trackId); return this.startPrepared(prepared); },
    async startPrepared(prepared, positionMs = prepared.pcmOriginMs) { const source = audio.lookup(prepared.url);
      const opened = await source.openReadable({ positionMs }), reader = opened.stream[Symbol.asyncIterator]();
      const block = await reader.next(); return { prepared, source, opened, reader, block }; },
    async resume(active, positionMs) { return this.startPrepared(active.prepared, positionMs); },
    async close() { hooks.http = hooks.native = hooks.capture = hooks.reply = null; await audio.close().catch(() => {}); if (productionLifecycle) await routeLifecycle.close().catch(() => {}); await control.dispose(); await setup?.close(); await fs.rm(setupDirectory,{recursive:true,force:true}); await bridge?.terminateFixture();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { fixture, TRACK, OTHER, error, delay };
