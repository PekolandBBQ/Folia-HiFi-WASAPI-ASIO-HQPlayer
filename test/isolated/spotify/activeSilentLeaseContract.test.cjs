'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCableCaptureHost } = require('../../../electron/spotify/cableCaptureHost.cjs');
const { requireOwnedSilentRenderLease, QUEUE_BYTES } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
const { createOwnedRouteAudio } = require('../../../electron/spotify/ownedRouteAudio.cjs');
const { qualified } = require('../../../electron/spotify/ownedRouteProtocol.cjs');
const { createOwnedRouteLifecycle } = require('../../../electron/spotify/ownedRouteLifecycle.cjs');
// New failure-path coverage only. Native process, pipe and policy boundaries are mocked.
const session = '12345678-1234-1234-1234-123456789abc';
const selection = { captureDeviceId: 'base-capture', renderDeviceId: 'base-render', temporaryFormatLease: true };
const proof = (changes = {}) => ({ captureSession: session, captureGeneration: 1, endpointId: 'base-render',
  sessionInstanceId: 'exact-silent-instance', groupingId: '11111111-2222-3333-4444-555555555555',
  processId: 4321, startedAtUtcTicks: '638355968000000000', ...changes });
const expected = { session, generation: 1, renderDeviceId: 'base-render', processId: 4321 };
test('exact own-child silent identity is copied and frozen without accepting extra authority', () => {
  const raw = proof(), value = requireOwnedSilentRenderLease(raw, expected);
  assert.notEqual(value, raw); assert.ok(Object.isFrozen(value));
  raw.processId = 5555; assert.equal(value.processId, 4321);
});
for (const [name, changes] of Object.entries({
  'foreign PID': { processId: 1234 }, 'wrong endpoint': { endpointId: 'other-render' },
  'old generation': { captureGeneration: 2 }, 'wrong session': { captureSession: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  'empty grouping': { groupingId: '00000000-0000-0000-0000-000000000000' },
  'unbounded instance': { sessionInstanceId: 'x'.repeat(4097) }, 'invalid ticks': { startedAtUtcTicks: '031' },
  'unsupported field': { ignoreAllHelperSessions: true },
})) test(`rejects ${name}`, () => assert.throws(() => requireOwnedSilentRenderLease(proof(changes), expected), /CAPTURE_PROTOCOL_INVALID/));
function fixture(options = {}) {
  const child = new EventEmitter(); child.pid = 4321; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
  const calls = [], diagnostics = []; let active;
  const format = { sampleRate: 44100, channels: 2, containerBits: 32 };
  const config = { ready: true, issues: [], sampleRateConversion: false, selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le',
    capture: { id: 'base-capture', flow: 'capture', supportedBaseCable: true, mixFormat: format },
    render: { id: 'base-render', flow: 'render', supportedBaseCable: true, mixFormat: format },
    route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true },
    formatLease: { state: 'held', verified: true, persistentSettingsChanged: false } };
  child.stdin = new Writable({ write(bytes, encoding, callback) {
    const input = JSON.parse(bytes.toString()); calls.push(input); callback();
    queueMicrotask(() => {
      let result;
      if (input.action === 'hello') result = { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100, channels: 2, bitDepth: 32,
        sampleFormat: 's32le', queueCapacityBytes: QUEUE_BYTES,
        capabilities: ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', 'post-start-route-proof-v1', 'temporary-format-lease-v1',
          ...(options.oldHelper ? [] : ['active-silent-format-lease-v1'])] };
      else if (input.action === 'capture-open') {
        active = input;
        result = { ...input, state: 'prepared', sampleRate: 44100, channels: 2, bitDepth: 32, sampleFormat: 's32le',
          sampleRateConversion: false, queueCapacityBytes: QUEUE_BYTES, actualMixFormat: format, configuration: config,
          capturedFrames: 0, deliveredFrames: 0, queuedBytes: 0,
          ownedSilentRenderLease: proof({ captureGeneration: input.generation, ...options.proofChanges }) };
      } else result = { session: input.session, generation: input.generation, state: 'closed' };
      child.stdout.write(JSON.stringify({ id: input.id, ok: true, result }) + '\n');
    });
  } });
  const host = createCableCaptureHost({ helperPath: 'C:\\Folia\\folia-capture.exe', platform: 'win32', spawnImpl: () => child,
    connectImpl: () => { const socket = new EventEmitter(); socket.destroy = () => socket.emit('close');
      queueMicrotask(() => socket.emit('connect')); return socket; }, onDiagnostic: value => diagnostics.push(value), exitTimeoutMs: 100 });
  return { host, calls, diagnostics };
}
test('capture host binds proof to actual spawned PID and invalidates getter after stop', async () => {
  const f = fixture(); try {
    const capture = await f.host.open({ session, ...selection });
    assert.equal(capture.ownedSilentRenderLease().processId, 4321);
    assert.ok(!JSON.stringify(f.diagnostics).includes('exact-silent-instance'));
    await capture.stopVerified(); assert.throws(() => capture.ownedSilentRenderLease(), /CANCELLED/);
  } finally { await f.host.close(); }
});
test('wrong-child identity stops the opened generation and cannot escape to routing', async () => {
  const f = fixture({ proofChanges: { processId: 9999 } }); try {
    await assert.rejects(f.host.open({ session, ...selection }), /CAPTURE_PROTOCOL_INVALID/);
    assert.ok(f.calls.some(value => value.action === 'capture-stop'));
  } finally { await f.host.close(); }
});
test('old capture helper fails before opening a stream', async () => {
  const f = fixture({ oldHelper: true }); try {
    await assert.rejects(f.host.open({ session, ...selection }), /PROTOCOL_INCOMPATIBLE/);
    assert.ok(!f.calls.some(value => value.action === 'capture-open'));
  } finally { await f.host.close(); }
});
test('owned audio sends the exact proof when arming, before capture Start and source authorization', async () => {
  const events = [], exact = Object.freeze(proof());
  const route = { captureOpening() {}, capturePrepared() {}, captureStarting() {}, captureStopped() {}, publicationStopped() {},
    async authorizePreparedSelection() { events.push('authorize-selection'); },
    async verifyPreparedTargetActive() { events.push('target-active'); },
    async completePreparedSelection() { events.push('paused-complete'); },
    async armCaptureInterval(value) { assert.equal(value, exact); events.push('arm-exact'); },
    async authorizeResume() { events.push('authorize'); }, async release() { events.push('restore'); } };
  const routeLifecycle = { async acquire() { events.push('acquire'); return route; } };
  const captureHost = { async open() { events.push('open'); return {
    ownedSilentRenderLease: () => exact, async start() { events.push('capture-start'); }, async stopVerified() { events.push('capture-stop'); },
    async promote() {}, stream: { async *[Symbol.asyncIterator]() {} } }; } };
  const audio = createOwnedRouteAudio({ routeLifecycle, captureHost }).create({ session, selection, binding: {},
    pausedTrackId: null, selectedTrackId: '3n3Ppam7vgaVa1iaRUc9Lp', signal: new AbortController().signal, onFailure() {} });
  await audio.prepareSelection(); await audio.verifyPreparedTargetActive(); await audio.completePreparation();
  await audio.start(); assert.deepEqual(events, ['acquire', 'authorize-selection', 'target-active', 'paused-complete', 'open', 'arm-exact', 'capture-start', 'authorize']);
  await audio.close(); assert.deepEqual(events.slice(-2), ['capture-stop', 'restore']);
});
test('old route service cannot satisfy the new exact silent-lease contract', () => {
  const value = { protocolMajor: 1, componentVersion: '0.19.0-dev.19', platform: 'win32-x64', contract: 'folia-owned-route-v1', supported: true, productionQualified: true,
    heldPausedAcquire: true, completeSessionProof: true, notificationCoherent: true, retainedJournalRecovery: true, intervalIsolation: true,
    providerRouteLifetime: true, boundedSeekPark: true, boundedPausedProofTransfer: true, indefiniteHeldPause: true, freshResumeInterval: true,
    preparedSelection: true, preparedTargetActivity: true, boundedPreparationObservation: true, boundedRestoreObservation: true,
    blockers: [], operations: ['hello', 'inspect', 'validateHeld', 'acquire', 'rebindPreparedSelection', 'authorizePreparedSelection', 'verifyPreparedTargetActive',
      'completePreparedSelection', 'suspendPaused', 'resumePreparation', 'seekPark', 'seekResumePreparation', 'seekCancelToPaused',
      'armCaptureInterval', 'authorizeResume', 'status', 'heartbeat', 'release', 'close'] };
  assert.equal(qualified(value), false); assert.equal(qualified({ ...value, ownedSilentRenderLease: true }), true);
});
function lifecycleFixture() {
  const calls = [], originals = [{ role: 0, original: null }, { role: 1, original: 'saved-physical' }]; let current;
  const selected = { ...selection, deviceId: 'desktop' };
  const process = { pid: 1234, startTimeUtcTicks: '638355968000000000', startedAtUnixMs: 1700000000000 };
  const host = { async close() {}, async capabilities() { return { supported: true }; }, confirmReleased() {}, async request(command, payload) {
    calls.push({ command, payload });
    if (command === 'acquire') {
      current = { ...payload, leaseId: 'exact-route-lease', state: 'heldPaused', process, originalRoles: originals };
      return { state: 'heldPaused', ready: false, lease: current, intervalArmed: false };
    }
    if (['authorizePreparedSelection', 'verifyPreparedTargetActive', 'completePreparedSelection'].includes(command)) {
      current = { ...current, state: command === 'completePreparedSelection' ? 'heldPaused' : 'preparedSelection' };
      return { state: current.state, ready: false, lease: current, intervalArmed: false, intervalId: null, intervalEpoch: 1,
        ...(command === 'authorizePreparedSelection' ? { preparedSelectionAuthorized: true, code: 'PREPARED_SELECTION_AUTHORIZED' }
          : command === 'verifyPreparedTargetActive' ? { preparedTargetActive: true, code: 'PREPARED_TARGET_ACTIVE' }
            : { preparedSelectionCompleted: true, code: 'PREPARED_SELECTION_COMPLETED' }) };
    }
    if (command === 'armCaptureInterval') return { state: 'heldPaused', ready: false, lease: current,
      intervalArmed: true, intervalIsolated: true, intervalGeneration: current.generation, intervalEpoch: 1, intervalId: 'exact-interval' };
    if (command === 'release') { current = { ...current, state: 'restored' }; return { state: 'restored', lease: current,
      exactOriginalRolesRestored: true, globalDefaultsWritten: false, observedDefaultsChanged: false }; }
    throw Error(command);
  } };
  const route = createOwnedRouteLifecycle({ host });
  const acquire = () => route.acquire({ session, selection: selected,
    binding: { expectedSpotifyProcessId: 1234, expectedSpotifyStartTimeUtcTicks: process.startTimeUtcTicks, expectedOriginalRoles: originals },
    sourcePaused: true, sourceDeviceId: 'desktop', expectedSourceUri: null, selectedSourceUri: 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp' });
  return { calls, route, acquire };
}
test('real route lifecycle forwards capture identity independently of route generation then restores', async () => {
  const f = lifecycleFixture(); try {
    const lease = await f.acquire();
    await lease.authorizePreparedSelection(); await lease.verifyPreparedTargetActive(); await lease.completePreparedSelection();
    await lease.armCaptureInterval(proof({ captureGeneration: 7 }));
    const sent = f.calls.find(value => value.command === 'armCaptureInterval').payload;
    assert.equal(sent.generation, 1); assert.equal(sent.ownedSilentRenderLease.captureGeneration, 7);
    assert.equal(sent.ownedSilentRenderLease.captureSession, session);
    await lease.release();
    await assert.rejects(lease.armCaptureInterval(proof({ captureGeneration: 7 })), /CANCELLED/);
  } finally { await f.route.close(); }
});
test('wrong-session proof never reaches independent route helper', async () => {
  const f = lifecycleFixture(); try {
    const lease = await f.acquire();
    await lease.authorizePreparedSelection(); await lease.verifyPreparedTargetActive(); await lease.completePreparedSelection();
    await assert.rejects(lease.armCaptureInterval(proof({ captureSession: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })), /ROUTE_PROTOCOL_INVALID/);
    assert.ok(!f.calls.some(value => value.command === 'armCaptureInterval'));
    await lease.release();
  } finally { await f.route.close(); }
});
