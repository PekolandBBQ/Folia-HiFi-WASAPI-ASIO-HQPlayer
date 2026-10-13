import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { deferred, oldTrack, processIdentity, requestId, routeFixture, selection, tick, trackId } from './ownedRouteFixture';

// test/unit/onlineMusic/ownedRouteLifecycle.test.ts: ownership and exact nullable restoration under race/failure mocks.
const require = createRequire(import.meta.url);
const { qualified, rawPolicyValue } = require('../../../electron/spotify/ownedRouteProtocol.cjs');
const fixtures: ReturnType<typeof routeFixture>[] = [];
const create = () => { const value = routeFixture(); fixtures.push(value); return value; };
const binding = { expectedSpotifyProcessId: processIdentity.pid, expectedSpotifyStartTimeUtcTicks: processIdentity.startTimeUtcTicks,
  expectedSpotifyStartedAtUnixMs: processIdentity.startedAtUnixMs,
  expectedOriginalRoles: [{ role: 0, original: null }, { role: 1, original: null }] };
const input = { session: requestId, selection, binding, sourcePaused: true, sourceDeviceId: selection.deviceId,
  expectedSourceUri: `spotify:track:${oldTrack}`, selectedSourceUri: `spotify:track:${trackId}` };

// Establish the real prepared-selection and exact silent-render lease prerequisites before testing active proof.
async function armCapture(lease: any) {
  await lease.authorizePreparedSelection(); await lease.verifyPreparedTargetActive(); await lease.completePreparedSelection();
  lease.captureOpening(); lease.capturePrepared();
  await lease.armCaptureInterval({ captureSession: requestId, captureGeneration: 1,
    endpointId: selection.renderDeviceId, sessionInstanceId: 'fixture-owned-silent-render',
    groupingId: '87654321-1234-1234-1234-123456789abc', processId: 4321, startedAtUtcTicks: '638355968000000001' });
  lease.captureStarting();
}

afterEach(async () => { vi.useRealTimers(); for (const f of fixtures.splice(0)) await f.route.close().catch(() => {}); });
it('accepts only the complete qualified service contract', () => {
  const valid = { protocolMajor: 1, componentVersion: '0.19.0-dev.26', platform: 'win32-x64', contract: 'folia-owned-route-v1', supported: true,
    productionQualified: true, heldPausedAcquire: true, completeSessionProof: true, notificationCoherent: true, retainedJournalRecovery: true,
    intervalIsolation: true, providerRouteLifetime: true, boundedSeekPark: true, boundedPausedProofTransfer: true, indefiniteHeldPause: true, freshResumeInterval: true,
    ownedSilentRenderLease: true, preparedSelection: true, preparedTargetActivity: true, boundedPreparationObservation: true, boundedRestoreObservation: true,
    blockers: [], operations: ['hello', 'inspect', 'validateHeld', 'acquire', 'rebindPreparedSelection', 'authorizePreparedSelection', 'verifyPreparedTargetActive', 'completePreparedSelection',
      'suspendPaused', 'resumePreparation', 'seekPark', 'seekResumePreparation', 'seekCancelToPaused', 'armCaptureInterval', 'authorizeResume', 'status', 'heartbeat', 'release', 'close'] };
  expect(qualified(valid)).toBe(true);
  for (const key of ['supported', 'productionQualified', 'heldPausedAcquire', 'completeSessionProof', 'notificationCoherent', 'retainedJournalRecovery', 'intervalIsolation',
    'providerRouteLifetime', 'boundedSeekPark', 'boundedPausedProofTransfer', 'indefiniteHeldPause', 'freshResumeInterval', 'ownedSilentRenderLease',
    'preparedSelection', 'preparedTargetActivity', 'boundedPreparationObservation', 'boundedRestoreObservation'])
    expect(qualified({ ...valid, [key]: false })).toBe(false);
  expect(qualified({ ...valid, componentVersion: '0.19.0-dev.17' })).toBe(false);
  for (const operation of valid.operations) expect(qualified({ ...valid, operations: valid.operations.filter(value => value !== operation) })).toBe(false);
  expect(qualified({ ...valid, contract: 'cli-roundtrip' })).toBe(false); expect(qualified({ ...valid, platform: 'linux-x64' })).toBe(false);
});
it('rejects wrong endpoints, unsafe originals and a falsely reported Default source before a lease', async () => {
  const f = create(); f.inspection.renderDeviceId = 'other-render';
  await expect(f.route.inspect(selection)).rejects.toMatchObject({ code: 'ROUTE_PROTOCOL_INVALID' });
  f.inspection.renderDeviceId = selection.renderDeviceId; f.inspection.sourceOutputDefault = false;
  await expect(f.route.inspect(selection)).rejects.toMatchObject({ code: 'ROUTE_PROTOCOL_INVALID' });
  f.inspection.sourceOutputDefault = true; f.inspection.originalPolicySafe = false;
  await expect(f.route.inspect(selection)).rejects.toMatchObject({ code: 'ORIGINAL_POLICY_UNSAFE' });
  expect(f.events).not.toContain('route:acquire');
});
it('retains a safe root-initialization failure before inspection without creating phantom route ownership', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementationOnce(async () => { throw Object.assign(new Error(), { code: 'NO_POLICY_WRITES', noPolicyWrites: true,
    failureCode: 'PRODUCT_JOURNAL_ROOT_CREATE_FAILED' }); });
  await expect(f.route.inspect(selection)).rejects.toMatchObject({ code: 'PRODUCT_JOURNAL_ROOT_CREATE_FAILED' });
  f.host.request.mockImplementation(native);
  await expect(f.route.inspect(selection)).resolves.toMatchObject({ held: false });
  expect(f.events).not.toContain('route:acquire');
});
it('restores both exact original role values including null, and rejects a normalized substitute', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    const result: any = await real(command, payload);
    if (result.lease) result.lease.originalRoles[1].original = 'saved-physical-endpoint';
    return result;
  });
  const explicitBinding = { ...binding, expectedOriginalRoles: [{ role: 0, original: null }, { role: 1, original: 'saved-physical-endpoint' }] };
  const lease = await f.route.acquire({ ...input, binding: explicitBinding }); await lease.release();
  expect(f.events).toEqual(['route:acquire', 'route:release']);
  const g = create(), original = g.host.request.getMockImplementation()!;
  g.host.request.mockImplementation(async (command: string, payload: any) => {
    const result: any = await original(command, payload);
    if (command === 'release') result.lease.originalRoles[0].original = 'resolved-default';
    return result;
  });
  const owned = await g.route.acquire(input);
  await expect(owned.release()).rejects.toMatchObject({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
  await expect(g.route.acquire(input)).rejects.toMatchObject({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
});
it('accepts positively verified safe mixed raw originals and binds a failed acquire restoration to that exact preflight', async () => {
  const raw = String.raw`\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{11111111-1111-1111-1111-111111111111}#{e6327cad-dcec-4949-ae8a-991e976a79d2}`;
  const f = create(); f.inspection.originalRoles[1].original = raw; f.inspection.sourceOutputDefault = false;
  const inspected = await f.route.inspect(selection), real = f.host.request.getMockImplementation()!;
  let failOnce = true;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    const value: any = await real(command, payload);
    if (command === 'acquire' && failOnce) {
      failOnce = false;
      throw Object.assign(new Error(), { restoreReceipt: { ...value, state: 'restored', lease: { ...value.lease, state: 'restored' },
        exactOriginalRolesRestored: true, globalDefaultsWritten: false, observedDefaultsChanged: true,
        failureCode: 'ORIGINAL_EXPLICIT_ENDPOINT_CHANGED' } });
    }
    return value;
  });
  await expect(f.route.acquire({ ...input, binding: inspected.binding })).rejects.toMatchObject({ code: 'ORIGINAL_EXPLICIT_ENDPOINT_CHANGED' });
  expect((await f.route.availability()).supported).toBe(true);
  const lease = await f.route.acquire({ ...input, binding: inspected.binding }); await lease.release();
  expect(f.lease().originalRoles).toEqual(f.inspection.originalRoles);
});
it('bounds raw nullable policy values without trimming or converting them into endpoint IDs', () => {
  expect(rawPolicyValue(null)).toBe(true); expect(rawPolicyValue('x'.repeat(32768))).toBe(true);
  for (const value of ['', undefined, 'x'.repeat(32769), 'raw\u0000policy', 'raw\npolicy']) expect(rawPolicyValue(value)).toBe(false);
});
it('waits for a cancelled acquire reply, restores that exact generation, and never authorizes resume', async () => {
  const f = create(), gate = deferred(), real = f.host.request.getMockImplementation()!, abort = new AbortController();
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'acquire') await gate.promise; return real(command, payload);
  });
  const acquisition = f.route.acquire({ ...input, signal: abort.signal }), failed = expect(acquisition).rejects.toMatchObject({ code: 'CANCELLED' });
  await tick(); abort.abort(); gate.resolve(null); await failed;
  expect(f.events).toEqual(['route:acquire', 'route:release']);
  const next = await f.route.acquire(input); expect(next.generation).toBe(2); await next.release();
});
it('requests bounded native proof after main pause is unconfirmed and blocks if native cannot restore safely', async () => {
  const f = create(), lease = await f.route.acquire(input); await armCapture(lease); await lease.authorizeResume();
  const native = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'release') throw Object.assign(new Error(), { code: 'ROUTE_SOURCE_PAUSE_UNCONFIRMED' });
    return native(command, payload);
  });
  await expect(lease.release()).rejects.toMatchObject({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
  expect(f.events).not.toContain('route:release'); expect((await f.route.availability()).supported).toBe(false);
  expect(f.host.request.mock.calls.filter(call => call[0] === 'release')).toHaveLength(1);
  await expect(lease.release()).rejects.toMatchObject({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
  expect(f.host.request.mock.calls.filter(call => call[0] === 'release')).toHaveLength(1);
});
it('a stale lease cannot restore or revoke a newer generation', async () => {
  const f = create(), first = await f.route.acquire(input); await first.release(); const second = await f.route.acquire(input);
  const calls = f.host.request.mock.calls.length; await first.release();
  expect(f.host.request.mock.calls).toHaveLength(calls); await expect(first.verifyActive()).rejects.toMatchObject({ code: 'CANCELLED' });
  await second.release();
});
it('a wrong process start tick or incomplete active result never proves readiness', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!;
  const lease = await f.route.acquire(input); await armCapture(lease); await lease.authorizeResume();
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    const result: any = await real(command, payload);
    if (command === 'status') result.lease.process.startTimeUtcTicks = '638355968000000001'; return result;
  });
  await expect(lease.verifyActive()).rejects.toMatchObject({ code: 'SPOTIFY_PROCESS_CHANGED' });
  lease.confirmPaused(); await lease.release();
});
it('reports ready only after active proof and restored only after exact readback', async () => {
  const events: any[] = [], f = routeFixture({ onDiagnostic: (value: any) => events.push(value) }); fixtures.push(f);
  const lease = await f.route.acquire(input); await armCapture(lease); await lease.authorizeResume(); await lease.verifyActive(); lease.confirmPaused(); await lease.release();
  expect(events.map(value => [value.phase, value.ready, value.exactOriginalRolesRestored])).toEqual([
    ['held-paused', false, false], ['resume-authorized', false, false], ['active', true, false], ['restored', false, true],
  ]);
});
it('rejects a reset interval despite matching process, session, lease and active snapshot', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!, lease = await f.route.acquire(input);
  await armCapture(lease); await lease.authorizeResume(); await lease.verifyActive();
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    const value: any = await real(command, payload); return command === 'status' ? { ...value, intervalId: 'different-interval' } : value;
  });
  await expect(lease.verifyActive()).rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
  lease.confirmPaused(); await lease.release();
});
it('accepts exact nullable app restoration when the OS changed its default, and never writes a global default', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    const value: any = await real(command, payload);
    return command === 'release' ? { ...value, defaultsUnchanged: false, observedDefaultsChanged: true, globalDefaultsWritten: false } : value;
  });
  const lease = await f.route.acquire(input); await lease.release();
  expect(f.lease().originalRoles).toEqual([{ role: 0, original: null }, { role: 1, original: null }]);
  expect(f.host.request.mock.calls.map(call => call[0])).toEqual(['acquire', 'release']);
  expect((await f.route.availability()).supported).toBe(true);
});
it('clears only a native-proven no-write acquire rejection and permits a later new attempt', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!; let denied = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'acquire' && !denied) { denied = true; throw Object.assign(new Error(), { code: 'NO_POLICY_WRITES', noPolicyWrites: true }); }
    return native(command, payload);
  });
  await expect(f.route.acquire(input)).rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
  expect((await f.route.availability()).supported).toBe(true);
  const lease = await f.route.acquire(input); expect(lease.generation).toBe(2); await lease.release();
});
it('clears a failed acquisition only after the native parent proves exact Default restoration and owned exit', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!; let failed = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    const value: any = await native(command, payload);
    if (command === 'acquire' && !failed) {
      failed = true;
      throw Object.assign(new Error(), { restoreReceipt: { ...value, state: 'restored', lease: { ...value.lease, state: 'restored' },
        exactOriginalRolesRestored: true, globalDefaultsWritten: false, observedDefaultsChanged: false } });
    }
    return value;
  });
  await expect(f.route.acquire(input)).rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
  expect((await f.route.availability()).supported).toBe(true);
  const lease = await f.route.acquire(input); expect(lease.generation).toBe(2); await lease.release();
});
it('reports PCM stopped from actual scoped capture state, including pending acquire before any capture request', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'acquire') expect(f.route.pcmStopped(payload.session, payload.generation)).toBe(true);
    return native(command, payload);
  });
  const lease = await f.route.acquire(input);
  expect(f.route.pcmStopped(requestId, lease.generation + 1)).toBe(false);
  lease.captureOpening(); expect(f.route.pcmStopped(requestId, lease.generation)).toBe(false);
  lease.capturePrepared(); expect(f.route.pcmStopped(requestId, lease.generation)).toBe(true);
  lease.captureStarting(); expect(f.route.pcmStopped(requestId, lease.generation)).toBe(false);
  lease.publicationStarted(); lease.captureStopped(); expect(f.route.pcmStopped(requestId, lease.generation)).toBe(false);
  lease.publicationStopped(); expect(f.route.pcmStopped(requestId, lease.generation)).toBe(true); await lease.release();
});

async function suspendForTrackHandoff(lease: any) {
  await lease.authorizePreparedSelection(); await lease.verifyPreparedTargetActive(); await lease.completePreparedSelection();
  lease.confirmPaused(); lease.publicationStopped(); lease.captureStopped(); await lease.suspendPaused();
}
it('rebinds a retained owner only through a fresh authorized selection and the new URI reaches every proof command', async () => {
  const f = create(), lease = await f.route.acquire(input); await suspendForTrackHandoff(lease);
  const held = await f.route.inspect(selection); expect(held.held).toBe(true);
  expect(f.events.filter(value => value === 'route:validateHeld')).toHaveLength(1);
  await lease.rebindPreparedSelection({ selectedTrackId: oldTrack, pausedTrackId: trackId });
  expect(lease.intervalEpoch).toBe(2); expect(lease.suspended).toBe(false);
  await expect(lease.completePreparedSelection()).rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
  await lease.verifyPreparedTargetActive(); await lease.completePreparedSelection();
  const verifyCalls = f.host.request.mock.calls.filter(call => call[0] === 'verifyPreparedTargetActive');
  expect(verifyCalls.at(-1)?.[1]).toMatchObject({ session: requestId, generation: 1, selectedSourceUri: `spotify:track:${oldTrack}`, intervalEpoch: 2 });
  expect(f.events.filter(value => value === 'route:acquire')).toHaveLength(1);
  expect(f.events).not.toContain('route:release');
  lease.confirmPaused(); lease.captureStopped(); await f.route.releaseRetained();
  expect(f.events.filter(value => value === 'route:release')).toHaveLength(1);
});
it.each(['capture-not-stopped', 'wrong-previous-track'])('refuses track handoff before %s is proved', async fault => {
  const f = create(), lease = await f.route.acquire(input); await suspendForTrackHandoff(lease);
  if (fault === 'capture-not-stopped') lease.captureStarting();
  await expect(lease.rebindPreparedSelection({ selectedTrackId: oldTrack, pausedTrackId: fault === 'wrong-previous-track' ? oldTrack : trackId }))
    .rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
  expect(f.events).not.toContain('route:rebindPreparedSelection'); lease.captureStopped();
});
it('failed track handoff retains the exact owner, blocks further playback and allows one explicit exit restore', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!, lease = await f.route.acquire(input);
  await suspendForTrackHandoff(lease);
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'rebindPreparedSelection') throw Object.assign(new Error(), { code: 'SOURCE_NOT_PAUSED' });
    return native(command, payload);
  });
  await expect(lease.rebindPreparedSelection({ selectedTrackId: oldTrack, pausedTrackId: trackId })).rejects.toMatchObject({ code: 'SOURCE_NOT_PAUSED' });
  expect(lease.intervalEpoch).toBe(1); expect(lease.released).toBe(false);
  await expect(lease.resumePreparation({ selectedTrackId: trackId })).rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
  expect(await f.route.availability()).toMatchObject({ supported: false });
  expect(f.events).not.toContain('route:release');
  await expect(f.route.releaseRetained()).resolves.toEqual({ released: true });
  await expect(f.route.releaseRetained()).resolves.toEqual({ released: true });
  expect(f.events.filter(value => value === 'route:release')).toHaveLength(1);
});
it('cannot adopt a rebind ACK with another original role snapshot or stale source epoch', async () => {
  for (const fault of ['originals', 'source-epoch']) {
    const f = create(), native = f.host.request.getMockImplementation()!, lease = await f.route.acquire(input);
    await suspendForTrackHandoff(lease);
    f.host.request.mockImplementation(async (command: string, payload: any) => {
      const value = await native(command, payload);
      if (command === 'rebindPreparedSelection') {
        if (fault === 'originals') value.lease.originalRoles[0].original = selection.renderDeviceId;
        else value.lease.sourceEpoch = 1;
      }
      return value;
    });
    await expect(lease.rebindPreparedSelection({ selectedTrackId: oldTrack, pausedTrackId: trackId })).rejects.toBeDefined();
    expect(lease.intervalEpoch).toBe(1); expect(f.events).not.toContain('route:release');
    await expect(lease.verifyPreparedTargetActive()).rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
    await f.route.releaseRetained();
  }
});



