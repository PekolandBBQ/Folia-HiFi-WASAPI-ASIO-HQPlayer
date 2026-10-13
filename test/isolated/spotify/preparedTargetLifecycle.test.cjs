'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOwnedRouteLifecycle } = require('../../../electron/spotify/ownedRouteLifecycle.cjs');
const { qualified } = require('../../../electron/spotify/ownedRouteProtocol.cjs');
const SESSION = '12345678-1234-1234-1234-123456789abc', TRACK = '3n3Ppam7vgaVa1iaRUc9Lp';
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(signal) {
  const commands = [], hooks = {}, selection = { deviceId: 'desktop', captureDeviceId: 'capture', renderDeviceId: 'render' };
  const process = { pid: 123, startTimeUtcTicks: '638355968000000000', startedAtUnixMs: 1700000000000 };
  const originalRoles = [{ role: 0, original: null }, { role: 1, original: null }];
  let lease;
  const host = { close: async () => {}, capabilities: async () => ({ supported: true }), request: async (command, payload) => {
    commands.push({ command, payload }); const override = await hooks[command]?.(payload); if (override) return override;
    if (command === 'acquire') lease = { ...payload, leaseId: 'lease-1', process, originalRoles, state: 'heldPaused' };
    const state = command === 'release' ? 'restored' : ['authorizePreparedSelection', 'verifyPreparedTargetActive'].includes(command)
      ? 'preparedSelection' : 'heldPaused';
    const value = { ok: true, lease: { ...lease, state }, state, ready: false, resumeAuthorized: false,
      intervalArmed: false, intervalId: null, intervalEpoch: 1 };
    if (command === 'authorizePreparedSelection') Object.assign(value, { code: 'PREPARED_SELECTION_AUTHORIZED', preparedSelectionAuthorized: true });
    if (command === 'verifyPreparedTargetActive') Object.assign(value, { code: 'PREPARED_TARGET_ACTIVE', preparedTargetActive: true });
    if (command === 'completePreparedSelection') Object.assign(value, { code: 'PREPARED_SELECTION_COMPLETED', preparedSelectionCompleted: true });
    if (command === 'release') Object.assign(value, { exactOriginalRolesRestored: true, globalDefaultsWritten: false, observedDefaultsChanged: false });
    return value;
  } };
  const route = createOwnedRouteLifecycle({ host });
  const acquire = () => route.acquire({ session: SESSION, selection, sourcePaused: true, sourceDeviceId: selection.deviceId,
    expectedSourceUri: `spotify:track:${TRACK}`, selectedSourceUri: `spotify:track:${TRACK}`, signal,
    binding: { expectedSpotifyProcessId: process.pid, expectedSpotifyStartTimeUtcTicks: process.startTimeUtcTicks,
      expectedOriginalRoles: originalRoles } });
  return { route, commands, hooks, acquire };
}
test('native witness is required before completing selection or opening the capture interval', async () => {
  const f = fixture(); try {
    const lease = await f.acquire(); await lease.authorizePreparedSelection();
    await assert.rejects(lease.completePreparedSelection(), { code: 'ROUTE_PROOF_UNCONFIRMED' });
    assert.equal(f.commands.some(x => x.command === 'completePreparedSelection'), false);
    await lease.verifyPreparedTargetActive(); await lease.completePreparedSelection();
    const witness = f.commands.find(x => x.command === 'verifyPreparedTargetActive').payload;
    assert.equal(witness.selectedSourceUri, `spotify:track:${TRACK}`); assert.equal(witness.intervalEpoch, 1);
    assert.equal(f.commands.find(x => x.command === 'completePreparedSelection').payload.intervalEpoch, 1);
    assert.equal(f.commands.some(x => ['armCaptureInterval', 'authorizeResume', 'status'].includes(x.command)), false);
  } finally { await f.route.close(); }
});
for (const fault of [{ preparedTargetActive: false }, { intervalEpoch: 2 }, { ready: true }, { intervalArmed: true }, { intervalId: 'old-interval' }])
test('malformed activity reply cannot advance preparation: ' + JSON.stringify(fault), async () => {
  const f = fixture(); try {
    const lease = await f.acquire(); await lease.authorizePreparedSelection();
    f.hooks.verifyPreparedTargetActive = () => ({ state: 'preparedSelection', code: 'PREPARED_TARGET_ACTIVE', preparedTargetActive: true,
      ready: false, intervalArmed: false, intervalId: null, intervalEpoch: 1, lease: {
        session: SESSION, generation: 1, leaseId: 'lease-1', state: 'preparedSelection', captureDeviceId: 'capture', renderDeviceId: 'render',
        process: { pid: 123, startTimeUtcTicks: '638355968000000000', startedAtUnixMs: 1700000000000 },
        originalRoles: [{ role: 0, original: null }, { role: 1, original: null }] }, ...fault });
    await assert.rejects(lease.verifyPreparedTargetActive(), { code: 'ROUTE_PROOF_UNCONFIRMED' });
    await assert.rejects(lease.completePreparedSelection(), { code: 'ROUTE_PROOF_UNCONFIRMED' });
    assert.equal(f.commands.some(x => x.command === 'completePreparedSelection'), false);
  } finally { await f.route.close(); }
});
test('late native activity reply after cancellation cannot complete a later preparation', async () => {
  const abort = new AbortController(), f = fixture(abort.signal); let release, entered = false;
  try {
    const lease = await f.acquire(); await lease.authorizePreparedSelection();
    f.hooks.verifyPreparedTargetActive = () => { entered = true; return new Promise(resolve => { release = resolve; }); };
    const pending = lease.verifyPreparedTargetActive().then(() => null, error => error);
    while (!entered) await turn(); abort.abort(); release();
    assert.equal((await pending).code, 'CANCELLED');
    await assert.rejects(lease.completePreparedSelection(), { code: 'CANCELLED' });
    assert.equal(f.commands.some(x => x.command === 'completePreparedSelection'), false);
  } finally { await f.route.close(); }
});
test('old route binaries without target activity capability cannot qualify', () => {
  const value = { protocolMajor: 1, componentVersion: '0.19.0-dev.19', platform: 'win32-x64', contract: 'folia-owned-route-v1',
    supported: true, productionQualified: true, heldPausedAcquire: true, completeSessionProof: true, notificationCoherent: true,
    retainedJournalRecovery: true, intervalIsolation: true, providerRouteLifetime: true, boundedSeekPark: true, boundedPausedProofTransfer: true, indefiniteHeldPause: true, freshResumeInterval: true,
    ownedSilentRenderLease: true, preparedSelection: true, boundedPreparationObservation: true, boundedRestoreObservation: true,
    preparedTargetActivity: true, blockers: [], operations: ['hello', 'inspect', 'validateHeld', 'acquire', 'rebindPreparedSelection', 'authorizePreparedSelection',
      'verifyPreparedTargetActive', 'completePreparedSelection', 'suspendPaused', 'resumePreparation', 'seekPark', 'seekResumePreparation', 'seekCancelToPaused', 'armCaptureInterval',
      'authorizeResume', 'status', 'heartbeat', 'release', 'close'] };
  assert.equal(qualified(value), true); assert.equal(qualified({ ...value, preparedTargetActivity: false }), false);
  assert.equal(qualified({ ...value, operations: value.operations.filter(x => x !== 'verifyPreparedTargetActive') }), false);
});
test('owned audio keeps capture unopened until witnessed selection completes, then binds exact silent lease before Start', async () => {
  const { createOwnedRouteAudio } = require('../../../electron/spotify/ownedRouteAudio.cjs');
  const events = [], exact = Object.freeze({ captureSession: SESSION, captureGeneration: 7 });
  const route = { captureOpening() {}, capturePrepared() {}, captureStarting() {}, captureStopped() {}, publicationStopped() {},
    async authorizePreparedSelection() { events.push('authorize-selection'); },
    async verifyPreparedTargetActive() { events.push('target-active'); },
    async completePreparedSelection() { events.push('paused-complete'); },
    async armCaptureInterval(value) { assert.equal(value, exact); events.push('arm-exact'); },
    async authorizeResume() { events.push('authorize-resume'); }, async release() { events.push('restore'); } };
  const captureHost = { async open() { events.push('capture-open'); return {
    ownedSilentRenderLease: () => exact, async start() { events.push('capture-start'); },
    async stopVerified() { events.push('capture-stop'); }, async promote() {} }; } };
  const audio = createOwnedRouteAudio({ routeLifecycle: { async acquire() { events.push('acquire'); return route; } }, captureHost })
    .create({ session: SESSION, selection: { deviceId: 'desktop', captureDeviceId: 'capture', renderDeviceId: 'render' },
      binding: {}, pausedTrackId: null, selectedTrackId: TRACK });
  try {
    await audio.prepareSelection(); await assert.rejects(audio.start(), { code: 'ROUTE_PROOF_UNCONFIRMED' });
    await audio.verifyPreparedTargetActive(); assert.equal(events.includes('capture-open'), false);
    await audio.completePreparation(); await audio.start();
    assert.deepEqual(events, ['acquire', 'authorize-selection', 'target-active', 'paused-complete',
      'capture-open', 'arm-exact', 'capture-start', 'authorize-resume']);
  } finally { await audio.close(); }
});
