import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';

// test/unit/onlineMusic/ownedRouteHost.test.ts: native process and component bytes are injected; no policy setters run.
const require = createRequire(import.meta.url);
const { createOwnedRouteHost, resolveOwnedRouteComponent } = require('../../../electron/spotify/ownedRouteHost.cjs');
const { installPreviewDiagnosticSink } = require('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { physicalOwnerDiagnostic } = require('../../../electron/spotify/ownedRouteProtocol.cjs');
const capabilities = { protocolMajor: 1, componentVersion: '0.19.0-dev.25', platform: 'win32-x64', contract: 'folia-owned-route-v1', supported: true,
  productionQualified: true, heldPausedAcquire: true, completeSessionProof: true, notificationCoherent: true, retainedJournalRecovery: true,
  intervalIsolation: true, providerRouteLifetime: true, boundedSeekPark: true, boundedPausedProofTransfer: true, boundedPausedHoldObservation: true,
  indefiniteHeldPause: true, freshResumeInterval: true, ownedSilentRenderLease: true, preparedSelection: true, preparedTargetActivity: true,
  boundedPreparationObservation: true, boundedRestoreObservation: true,
  blockers: [], operations: ['hello', 'inspect', 'validateHeld', 'acquire', 'rebindPreparedSelection', 'authorizePreparedSelection', 'verifyPreparedTargetActive',
    'completePreparedSelection', 'suspendPaused', 'resumePreparation', 'seekPark', 'seekResumePreparation', 'seekCancelToPaused', 'armCaptureInterval',
    'authorizeResume', 'status', 'heartbeat', 'release', 'close'] };
function fixture(change: any = {}, exit: { code: number | null; signal?: string } = { code: 0 }, options: any = {}) {
  const calls: any[] = [], child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const input = JSON.parse(chunk.toString()); calls.push(input); done();
    queueMicrotask(() => {
      const reply = (value: any) => child.stdout.write(JSON.stringify({ id: input.id, ...value }) + '\n');
      if (options.handle?.(input, reply, child) === true || input.command === 'sourceControlResult') return;
      const result = input.command === 'hello' ? { ok: true, state: 'available', capabilities: { ...capabilities, ...change } }
        : input.command === 'close' ? { ok: true, state: 'closed', code: 'NO_POLICY_WRITES' } : { ok: true, state: 'eligible' };
      child.stdout.write(JSON.stringify({ id: input.id, ...result }) + '\n');
      if (input.command === 'close') queueMicrotask(() => child.emit('exit', exit.code, exit.signal));
    });
  }, final(done) { done(); queueMicrotask(() => child.emit('exit', exit.code, exit.signal)); } });
  const spawnImpl = vi.fn(() => child), resolveComponent = vi.fn(async () => '/verified/folia-route-service.exe');
  const host = createOwnedRouteHost({ componentDirectory: '/verified', platform: 'win32', spawnImpl, resolveComponent,
    onSourceControl: options.onSourceControl, onConfigurationRequired: options.onConfigurationRequired, timeoutMs: options.timeoutMs || 50, exitTimeoutMs: 50,
    ...(options.systemRelease ? { systemRelease: options.systemRelease } : {}) });
  return { host, child, calls, spawnImpl, resolveComponent };
}
it('opens configuration guidance for a changed default but still rejects the route request', async () => {
  const onConfigurationRequired = vi.fn();
  const f = fixture({}, { code: 0 }, { onConfigurationRequired,
    handle(input: any, reply: Function) {
      if (input.command !== 'inspect') return false;
      reply({ ok: false, code: 'BASE_OR_UNPROVEN_DEFAULT_FEEDBACK_GUARD' }); return true;
    } });
  await expect(f.host.request('inspect', {})).rejects.toMatchObject({ code: 'ROUTE_PROOF_UNCONFIRMED' });
  expect(onConfigurationRequired).toHaveBeenCalledExactlyOnceWith('NON_BASE_DEFAULT_OUTPUT_REQUIRED');
  expect(f.calls.map(call => call.command)).not.toContain('acquire');
  await f.host.close();
});
it('preserves the negotiated external-track handoff capability', async () => {
  const f=fixture({operations:[...capabilities.operations,'holdExternalSelection']});
  expect(await f.host.capabilities()).toMatchObject({externalTrackHold:true});
  await f.host.close();
});
it('uses one long-held child, string request IDs and serialized request/reply pairs', async () => {
  const f = fixture(); expect(f.spawnImpl).not.toHaveBeenCalled();
  expect(await f.host.capabilities()).toMatchObject({ supported: true, productionQualified: true, providerRouteLifetime: true });
  await Promise.all([f.host.request('inspect', { renderDeviceId: 'r' }), f.host.request('inspect', { renderDeviceId: 'r' })]);
  expect(f.spawnImpl).toHaveBeenCalledOnce(); expect(f.spawnImpl).toHaveBeenCalledWith('/verified/folia-route-service.exe', [],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  expect(f.calls.map(value => value.command)).toEqual(['hello', 'inspect', 'inspect']);
  expect(f.calls.every(value => typeof value.id === 'string')).toBe(true); await f.host.close();
});
it('answers a scoped native source read while acquire awaits proof without serializing behind acquire', async () => {
  const session = '12345678-1234-1234-1234-123456789abc', uri = 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp';
  const onSourceControl = vi.fn(async () => ({ sourceDeviceId: 'desktop', trackUri: uri, isPlaying: false,
    observedAtUtc: '2026-10-09T00:00:00.000Z', privateToken: 'NEVER_COPY' }));
  let acquireReply: Function | undefined;
  const f = fixture({}, { code: 0 }, { onSourceControl, timeoutMs: 1000,
    handle(input: any, reply: Function, child: any) {
      if (input.command === 'acquire') {
        acquireReply = reply; child.stdout.write(JSON.stringify({ event: 'sourceControl', requestId: 'source-12345678-1234-1234-1234-123456789abc',
          action: 'read', session, generation: 1, sourceEpoch: 1, sourceDeviceId: 'desktop', expectedSourceUri: uri, pausedPreviousUri: null,
          allowPreviousPaused: false }) + '\n'); return true;
      }
      if (input.command === 'sourceControlResult') { acquireReply!({ ok: true, state: 'heldPaused' }); return true; }
      return false;
    } });
  await expect(f.host.request('acquire', { session, generation: 1, sourceDeviceId: 'desktop', expectedSourceUri: uri })).resolves.toMatchObject({ state: 'heldPaused' });
  expect(onSourceControl).toHaveBeenCalledOnce();
  const response = f.calls.find(value => value.command === 'sourceControlResult');
  expect(response.payload).toEqual({ ok: true, sourceDeviceId: 'desktop', trackUri: uri, isPlaying: false, observedAtUtc: '2026-10-09T00:00:00.000Z', pcmStopped: false });
  expect(JSON.stringify(response)).not.toContain('NEVER_COPY'); await f.host.close().catch(() => {});
});
it.each(['generation', 'sourceDeviceId', 'expectedSourceUri'])('rejects an unsolicited source request outside the owned %s', async mismatch => {
  const session = '12345678-1234-1234-1234-123456789abc', uri = 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp', onSourceControl = vi.fn();
  const f = fixture({}, { code: 0 }, { onSourceControl,
    handle(input: any, _reply: Function, child: any) {
      if (input.command !== 'acquire') return false;
      const frame = { event: 'sourceControl', requestId: 'source-12345678-1234-1234-1234-123456789abc', action: 'pause',
        session, generation: 1, sourceEpoch: 1, sourceDeviceId: 'desktop', expectedSourceUri: uri, pausedPreviousUri: null, allowPreviousPaused: false,
        [mismatch]: mismatch === 'generation' ? 2 : mismatch === 'sourceDeviceId' ? 'another-device' : 'spotify:track:4n4Qqam7vgaVa1iaRUc9Lp' };
      child.stdout.write(JSON.stringify(frame) + '\n'); return true;
    } });
  await expect(f.host.request('acquire', { session, generation: 1, sourceDeviceId: 'desktop', expectedSourceUri: uri }))
    .rejects.toMatchObject({ code: 'ROUTE_PROTOCOL_INVALID' });
  expect(onSourceControl).not.toHaveBeenCalled(); await f.host.close().catch(() => {});
});
it('rejects an unqualified hello and sends no route command', async () => {
  const f = fixture({ notificationCoherent: false });
  expect(await f.host.capabilities()).toMatchObject({ supported: false, productionQualified: false, code: 'ROUTE_HELPER_UNQUALIFIED' });
  await expect(f.host.request('acquire', {})).rejects.toMatchObject({ code: 'ROUTE_HELPER_UNQUALIFIED' });
  expect(f.calls.map(value => value.command)).toEqual(['hello']); await f.host.close().catch(() => {});
});
it('will not claim clean shutdown from no-write evidence after an acquire was dispatched', async () => {
  const f = fixture(); await f.host.request('acquire', {});
  await expect(f.host.close()).rejects.toMatchObject({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
});
it.each(['ORIGINAL_ENDPOINT_UNSAFE', 'private-path-or-token'])('projects only a fixed terminal failureCode: %s', async failureCode => {
  const f = fixture({}, { code: 0 }, { handle(input: any, reply: Function) {
    if (input.command !== 'acquire') return false;
    reply({ ok: false, state: 'closed', code: 'NO_POLICY_WRITES', noPolicyWrites: true, failureCode,
      message: 'PRIVATE_PATH' }); return true;
  } });
  let error: any;
  try { await f.host.request('acquire', {}); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: 'NO_POLICY_WRITES', noPolicyWrites: true });
  expect(error.failureCode).toBe(failureCode === 'ORIGINAL_ENDPOINT_UNSAFE' ? failureCode : undefined);
  expect(error.message).not.toMatch(/PRIVATE|private-path/); await f.host.close().catch(() => {});
});
it.each([{ code: 3 }, { code: null, signal: 'SIGTERM' }])('rejects an abnormal child exit after a successful close receipt: %j', async exit => {
  const f = fixture({}, exit); await f.host.capabilities();
  await expect(f.host.close()).rejects.toMatchObject({ code: 'ROUTE_HELPER_ABNORMAL_EXIT' });
});
it.each(['inspect', 'acquire'])('records bounded physical-owner provenance on %s rejection without changing failure authority', async command => {
  const records: any[] = [];
  const remove = installPreviewDiagnosticSink({ enabled: () => true, record: (type: string, fields: any) => { records.push({ type, fields }); return true; } });
  const f = fixture({}, { code: 0 }, { handle(input: any, reply: Function) {
    if (input.command !== command) return false;
    reply({ ok: false, state: command === 'acquire' ? 'closed' : 'blocked',
      code: command === 'acquire' ? 'NO_POLICY_WRITES' : 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN',
      ...(command === 'acquire' ? { noPolicyWrites: true, failureCode: 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN' } : {}),
      physicalOwnerDiagnostic: { stage: 'owner-bus-type', reason: 'wrong-type', role: 1, originalKind: 'explicit',
        property: 'bus-type', propertyType: 18, propertyLength: 32, nativeResult: 0, depth: 1, bus: 'vendor',
        endpointId: 'PRIVATE_ENDPOINT', ownerId: 'PRIVATE_SERIAL', rawPolicy: 'PRIVATE_POLICY', message: 'PRIVATE_MESSAGE' } });
    return true;
  } });
  try {
    await expect(f.host.request(command, {})).rejects.toMatchObject({ code: command === 'acquire' ? 'NO_POLICY_WRITES' : 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN' });
    expect(records.filter(record => record.type === 'spotify.route-owner-proof')).toEqual([{ type: 'spotify.route-owner-proof', fields: {
      operation: command, errorCode: 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN', stage: 'owner-bus-type', reason: 'wrong-type',
      role: 1, originalKind: 'explicit', depth: 1, nativeResult: 0, property: 'bus-type', propertyType: 18, propertyLength: 32, bus: 'vendor',
    } }]);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE/);
  } finally { remove(); await f.host.close().catch(() => {}); }
});
it.each([{ ok: true, code: 'INSPECTED' }, { ok: false, code: 'SOURCE_NOT_PAUSED' },
  { ok: false, code: 'private-native-error' }])('does not emit owner proof for unrelated or successful reply %j', async response => {
  const records: any[] = [];
  const remove = installPreviewDiagnosticSink({ enabled: () => true, record: (type: string, fields: any) => records.push({ type, fields }) });
  const f = fixture({}, { code: 0 }, { handle(input: any, reply: Function) {
    if (input.command !== 'inspect') return false;
    reply({ ...response, state: 'blocked', physicalOwnerDiagnostic: { stage: 'owner-identity', reason: 'unsupported' } }); return true;
  } });
  try { await f.host.request('inspect', {}).catch(() => {}); expect(records.filter(record => record.type === 'spotify.route-owner-proof')).toEqual([]); }
  finally { remove(); await f.host.close().catch(() => {}); }
});
it('physical-owner evidence ignores getters, unknown fields, invalid numbers and caller strings', () => {
  let getterCalls = 0;
  const input = { stage: 'owner-parent', reason: 'api-failed', role: 4, originalKind: 'private-client-name', depth: 99,
    nativeResult: -1, hresult: -2147467259, property: 'private-property', propertyType: Infinity, propertyLength: 9000,
    bus: 'private-bus', ownerId: 'private-owner', get rawPolicy() { getterCalls++; return 'private-policy'; } };
  Object.defineProperty(input, 'role', { get() { getterCalls++; return 0; } });
  expect(physicalOwnerDiagnostic(input)).toEqual({ stage: 'owner-parent', reason: 'api-failed', hresult: -2147467259 });
  expect(physicalOwnerDiagnostic({ stage: 'private-stage', reason: 'api-failed' })).toBeUndefined();
  expect(physicalOwnerDiagnostic({ stage: 'owner-parent', reason: 'private-error' })).toBeUndefined();
  expect(getterCalls).toBe(0);
});
it('requires an exact qualified single-file component manifest and binary digest', async () => {
  const bytes = Buffer.from('mock executable bytes'), manifest: any = { schema: 1, version: '0.19.0-dev.25', protocolMajor: 1,
    executable: 'folia-route-service.exe', sha256: createHash('sha256').update(bytes).digest('hex'),
    distribution: 'self-contained-single-file', productionQualified: true, lengthBytes: bytes.length };
  const io = { readFile: vi.fn(async (file: string) => file.endsWith('.json') ? JSON.stringify(manifest) : bytes),
    lstat: vi.fn(async () => ({ isFile: () => true, isSymbolicLink: () => false, size: bytes.length })) };
  expect(await resolveOwnedRouteComponent('/component', io)).toBe(path.join('/component', 'folia-route-service.exe'));
  manifest.productionQualified = false; await expect(resolveOwnedRouteComponent('/component', io)).rejects.toMatchObject({ code: 'ROUTE_HELPER_UNQUALIFIED' });
  manifest.productionQualified = true; manifest.distribution = 'apphost-and-unverified-dlls';
  await expect(resolveOwnedRouteComponent('/component', io)).rejects.toMatchObject({ code: 'ROUTE_COMPONENT_INVALID' });
  manifest.distribution = 'self-contained-single-file'; manifest.sha256 = '0'.repeat(64);
  await expect(resolveOwnedRouteComponent('/component', io)).rejects.toMatchObject({ code: 'ROUTE_COMPONENT_INVALID' });
});
it('requires explicit main opt-in plus the immutable private profile and exact Windows build for trial admission', async () => {
  const trial = { productionQualified: false, supported: false, trialAuthorized: true, implementationAvailable: true, canOperate: true,
    validationProfile: 'folia-r19-owned-route-28000-x64-v1' };
  const off = fixture(trial, { code: 0 }, { systemRelease: () => '10.0.28000' });
  expect(await off.host.capabilities()).toMatchObject({ supported: false, productionQualified: false }); await off.host.close().catch(() => {});
  const allowed = fixture(trial, { code: 0 }, { systemRelease: () => '10.0.28000' }); allowed.host.setTrialEnabled(true);
  expect(await allowed.host.capabilities()).toMatchObject({ supported: true, productionQualified: false, trialAuthorized: true,
    validationProfile: trial.validationProfile });
  allowed.host.setTrialEnabled(false);
  expect(await allowed.host.capabilities()).toMatchObject({ supported: false, productionQualified: false, trialAvailable: true,
    code: 'ROUTE_TRIAL_OPT_IN_REQUIRED' }); await allowed.host.close();
  const wrong = fixture(trial, { code: 0 }, { systemRelease: () => '10.0.26100' }); wrong.host.setTrialEnabled(true);
  expect(await wrong.host.capabilities()).toMatchObject({ supported: false, code: 'ROUTE_TRIAL_PLATFORM_MISMATCH' });
  expect(wrong.spawnImpl).not.toHaveBeenCalled(); await wrong.host.close();
});
it('will not admit a trial manifest through a production or ad-hoc profile path', async () => {
  const bytes = Buffer.from('fixed private build'), manifest: any = { schema: 1, version: '0.19.0-dev.25', protocolMajor: 1, executable: 'folia-route-service.exe',
    sha256: createHash('sha256').update(bytes).digest('hex'), lengthBytes: bytes.length, distribution: 'self-contained-single-file',
    productionQualified: false, trialAuthorized: true, validationProfile: 'folia-r19-owned-route-28000-x64-v1' };
  const io = { readFile: async (file: string) => file.endsWith('.json') ? JSON.stringify(manifest) : bytes,
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: bytes.length }) };
  await expect(resolveOwnedRouteComponent('/component', io)).rejects.toMatchObject({ code: 'ROUTE_TRIAL_OPT_IN_REQUIRED' });
  expect(await resolveOwnedRouteComponent('/component', io, { allowTrial: true })).toBe(path.join('/component', 'folia-route-service.exe'));
  manifest.validationProfile = 'any-windows-build';
  await expect(resolveOwnedRouteComponent('/component', io, { allowTrial: true })).rejects.toMatchObject({ code: 'ROUTE_HELPER_UNQUALIFIED' });
});

const ownerSession = '12345678-1234-1234-1234-123456789abc';
const ownerTrackA = 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA', ownerTrackB = 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB';
const sourceFrame = (sourceEpoch: number, expectedSourceUri: string, id = '12345678-1234-1234-1234-123456789abc') => ({
  event: 'sourceControl', requestId: `source-${id}`, action: 'read', session: ownerSession, generation: 1,
  sourceEpoch, sourceDeviceId: 'desktop', expectedSourceUri, pausedPreviousUri: null, allowPreviousPaused: false,
});
async function establishOwner(f: ReturnType<typeof fixture>) {
  await f.host.request('acquire', { session: ownerSession, generation: 1, sourceDeviceId: 'desktop', expectedSourceUri: ownerTrackA });
  await f.host.request('authorizePreparedSelection', { selectedSourceUri: ownerTrackA });
  await f.host.request('completePreparedSelection', {});
}
const rebindPayload = (selectedSourceUri = ownerTrackB, pausedSourceUri = ownerTrackA, sourceEpoch = 2) => ({
  session: ownerSession, generation: 1, leaseId: 'lease', pausedSourceUri, selectedSourceUri, sourceEpoch, intervalEpoch: sourceEpoch,
});
const pausedSource = (trackUri: string) => ({ sourceDeviceId: 'desktop', trackUri, isPlaying: false, observedAtUtc: '2026-10-10T00:00:00.000Z' });
it.each([undefined, 0, 1, 3])('rejects old or unbound source epoch %s after successful track rebind', async sourceEpoch => {
  const onSourceControl = vi.fn(async () => pausedSource(ownerTrackB));
  const f = fixture({}, { code: 0 }, { onSourceControl, timeoutMs: 1000, handle(input: any, _reply: Function, child: any) {
    if (input.command !== 'heartbeat') return false;
    child.stdout.write(JSON.stringify({ ...sourceFrame(2, ownerTrackB), sourceEpoch }) + '\n'); return true;
  } });
  await establishOwner(f); await f.host.request('rebindPreparedSelection', rebindPayload());
  await expect(f.host.request('heartbeat', {})).rejects.toMatchObject({ code: 'ROUTE_PROTOCOL_INVALID' });
  expect(onSourceControl).not.toHaveBeenCalled(); await f.host.close().catch(() => {});
});
it('rejects old source epoch through same-URI A B A and retains current epoch across heartbeat', async () => {
  let beat = 0, pendingReply: Function | undefined;
  const onSourceControl = vi.fn(async () => pausedSource(ownerTrackA));
  const f = fixture({}, { code: 0 }, { onSourceControl, timeoutMs: 1000, handle(input: any, reply: Function, child: any) {
    if (input.command === 'heartbeat') {
      pendingReply = reply; child.stdout.write(JSON.stringify(sourceFrame(++beat === 1 ? 3 : 1, ownerTrackA)) + '\n'); return true;
    }
    if (input.command === 'sourceControlResult') { pendingReply!({ ok: true, state: 'pausedHeld', ready: false }); return true; }
    return false;
  } });
  await establishOwner(f); await f.host.request('rebindPreparedSelection', rebindPayload());
  await f.host.request('completePreparedSelection', {});
  await f.host.request('rebindPreparedSelection', rebindPayload(ownerTrackA, ownerTrackB, 3));
  await f.host.request('completePreparedSelection', {});
  await expect(f.host.request('heartbeat', {})).resolves.toMatchObject({ ready: false });
  await expect(f.host.request('heartbeat', {})).rejects.toMatchObject({ code: 'ROUTE_PROTOCOL_INVALID' });
  expect(onSourceControl).toHaveBeenCalledOnce(); await f.host.close().catch(() => {});
});
it('failed rebind rolls provisional URI and source epoch back for retained-owner cleanup', async () => {
  let pendingReply: Function | undefined;
  const onSourceControl = vi.fn(async () => pausedSource(ownerTrackA));
  const f = fixture({}, { code: 0 }, { onSourceControl, timeoutMs: 1000, handle(input: any, reply: Function, child: any) {
    if (input.command === 'rebindPreparedSelection') { reply({ ok: false, state: 'held', code: 'SOURCE_NOT_PAUSED' }); return true; }
    if (input.command === 'heartbeat') { pendingReply = reply; child.stdout.write(JSON.stringify(sourceFrame(1, ownerTrackA)) + '\n'); return true; }
    if (input.command === 'sourceControlResult') { pendingReply!({ ok: true, state: 'pausedHeld' }); return true; }
    return false;
  } });
  await establishOwner(f);
  await expect(f.host.request('rebindPreparedSelection', rebindPayload())).rejects.toMatchObject({ code: 'SOURCE_NOT_PAUSED' });
  await expect(f.host.request('heartbeat', {})).resolves.toMatchObject({ state: 'pausedHeld' });
  expect(onSourceControl).toHaveBeenCalledOnce(); await f.host.close().catch(() => {});
});
it('rebind cannot overlap a pending old callback and its late result cannot attach to a new command', async () => {
  let finish!: (value: any) => void;
  const held = new Promise(resolve => { finish = resolve; });
  const onSourceControl = vi.fn(() => held);
  const f = fixture({}, { code: 0 }, { onSourceControl, timeoutMs: 1000, handle(input: any, reply: Function, child: any) {
    if (input.command !== 'heartbeat') return false;
    child.stdout.write(JSON.stringify(sourceFrame(1, ownerTrackA)) + '\n');
    reply({ ok: true, state: 'pausedHeld' }); return true;
  } });
  await establishOwner(f);
  await expect(f.host.request('heartbeat', {})).rejects.toMatchObject({ code: 'ROUTE_PROTOCOL_INVALID' });
  await expect(f.host.request('rebindPreparedSelection', rebindPayload())).rejects.toMatchObject({ code: 'ROUTE_HELPER_CLOSED' });
  finish(pausedSource(ownerTrackA)); await new Promise(resolve => setImmediate(resolve));
  expect(f.calls.filter(value => value.command === 'rebindPreparedSelection' || value.command === 'sourceControlResult')).toHaveLength(0);
  await expect(f.host.request('heartbeat', {})).rejects.toMatchObject({ code: 'ROUTE_HELPER_CLOSED' });
  await f.host.close().catch(() => {});
});
it('old callback URI is retired after completed selection even inside current source epoch', async () => {
  const onSourceControl = vi.fn();
  const f = fixture({}, { code: 0 }, { onSourceControl, timeoutMs: 1000, handle(input: any, _reply: Function, child: any) {
    if (input.command !== 'heartbeat') return false;
    child.stdout.write(JSON.stringify(sourceFrame(2, ownerTrackA)) + '\n'); return true;
  } });
  await establishOwner(f); await f.host.request('rebindPreparedSelection', rebindPayload());
  await f.host.request('completePreparedSelection', {});
  await expect(f.host.request('heartbeat', {})).rejects.toMatchObject({ code: 'ROUTE_PROTOCOL_INVALID' });
  expect(onSourceControl).not.toHaveBeenCalled(); await f.host.close().catch(() => {});
});



