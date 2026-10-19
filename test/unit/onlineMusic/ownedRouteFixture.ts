import { createRequire } from 'node:module';
import { afterEach, expect, vi } from 'vitest';

// test/unit/onlineMusic/ownedRouteFixture.ts: real product orchestration with only process, policy, capture and HTTP boundaries mocked.
const externalFetch = vi.fn(async () => { throw new Error('External network is disabled in owned-route tests'); });
vi.stubGlobal('fetch', externalFetch);
afterEach(() => expect(externalFetch).not.toHaveBeenCalled());
const require = createRequire(import.meta.url);
const { createCableAudioPreparation } = require('../../../electron/spotify/cableAudioPreparation.cjs');
const { createOwnedRouteLifecycle } = require('../../../electron/spotify/ownedRouteLifecycle.cjs');
const { createDesktopPlaybackControl } = require('../../../electron/spotify/desktopPlaybackControl.cjs');
const { createCablePcmQueue } = require('../../../electron/spotify/cablePcmQueue.cjs');
export const trackId = '3n3Ppam7vgaVa1iaRUc9Lp', oldTrack = '4n4Qqam7vgaVa1iaRUc9Lp';
export const requestId = '12345678-1234-1234-1234-123456789abc';
export const selection = { deviceId: 'desktop', captureDeviceId: 'base-capture', renderDeviceId: 'base-render', temporaryFormatLease: true };
export const processIdentity = { pid: 1234, startTimeUtcTicks: '638355968000000000', startedAtUnixMs: 1700000000000 };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (reason: any) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function routeFixture(options: any = {}) {
  let nativeLease: any, leaseSerial = 0, intervalEpoch = 1, intervalId: string | null = null;
  const events: string[] = [];
  const inspection = { process: processIdentity, sourcePaused: true, sourceOutputDefault: true, originalPolicySafe: true, baseCableVerified: true,
    originalRoles: [{ role: 0, original: null as string | null }, { role: 1, original: null as string | null }],
    defaultsUnchanged: true, noOtherWriters: true, captureDeviceId: selection.captureDeviceId, renderDeviceId: selection.renderDeviceId };
  const host = { capabilities: vi.fn(async () => ({ supported: true, productionQualified: true, providerRouteLifetime: true })), close: vi.fn(async () => {}),
    request: vi.fn(async (command: string, payload: any) => {
      events.push(`route:${command}`);
      if (command === 'inspect') return { ok: true, state: 'eligible', inspection };
      if (command === 'acquire') {
        nativeLease = { ...payload, leaseId: `lease-${++leaseSerial}`, state: 'heldPaused', process: processIdentity,
          originalRoles: structuredClone(inspection.originalRoles) };
        return { ok: true, ready: false, state: 'heldPaused', lease: structuredClone(nativeLease),
          intervalArmed: false, intervalId: null, intervalIsolated: false, intervalGeneration: 0 };
      }
      if (command === 'authorizePreparedSelection') {
        nativeLease.state = 'preparedSelection';
        return { ok: true, ready: false, state: nativeLease.state, lease: structuredClone(nativeLease),
          preparedSelectionAuthorized: true, code: 'PREPARED_SELECTION_AUTHORIZED', intervalArmed: false };
      }
      if (command === 'verifyPreparedTargetActive') {
        return { ok: true, ready: false, state: nativeLease.state, lease: structuredClone(nativeLease),
          preparedTargetActive: true, code: 'PREPARED_TARGET_ACTIVE', intervalEpoch, intervalArmed: false, intervalId: null };
      }
      if (command === 'completePreparedSelection') {
        nativeLease.state = 'heldPaused';
        return { ok: true, ready: false, state: nativeLease.state, lease: structuredClone(nativeLease),
          preparedSelectionCompleted: true, code: 'PREPARED_SELECTION_COMPLETED', intervalEpoch, intervalArmed: false };
      }
      if (command === 'suspendPaused') {
        nativeLease.state = 'pausedHeld'; intervalId = null;
        return { ok: true, ready: false, state: nativeLease.state, lease: structuredClone(nativeLease),
          pausedHeld: true, code: 'PAUSED_ROUTE_HELD', intervalEpoch, intervalArmed: false, intervalId };
      }
      if (command === 'validateHeld') return { ok: true, state: 'pausedHeld', ready: false, lease: structuredClone(nativeLease),
        heldOwnerValidated: true, code: 'HELD_ROUTE_VALIDATED', intervalEpoch, intervalArmed: false, intervalId: null };
      if (command === 'rebindPreparedSelection') {
        expect(payload.intervalEpoch).toBe(intervalEpoch + 1); intervalEpoch = payload.intervalEpoch;
        nativeLease.state = 'preparedSelection'; nativeLease.sourceEpoch = payload.sourceEpoch;
        return { ok: true, ready: false, state: nativeLease.state, lease: structuredClone(nativeLease),
          preparedSelectionAuthorized: true, preparedTargetActive: false, code: 'TRACK_PREPARATION_AUTHORIZED', intervalEpoch, intervalArmed: false, intervalId: null };
      }
      if (command === 'resumePreparation') {
        expect(payload.intervalEpoch).toBe(intervalEpoch + 1); intervalEpoch = payload.intervalEpoch;
        nativeLease.state = 'preparedSelection';
        return { ok: true, ready: false, state: nativeLease.state, lease: structuredClone(nativeLease),
          preparedSelectionAuthorized: true, preparedTargetActive: true, code: 'RESUME_PREPARATION_AUTHORIZED', intervalEpoch, intervalArmed: false, intervalId: null };
      }
      if (command === 'armCaptureInterval') {
        intervalId = `interval-${leaseSerial}-${intervalEpoch}`;
        return { ok: true, ready: false, state: 'heldPaused', lease: structuredClone(nativeLease),
          intervalArmed: true, intervalId, intervalEpoch, intervalIsolated: true, intervalGeneration: nativeLease.generation };
      }
      if (command === 'authorizeResume') {
        nativeLease.state = 'resumeAuthorized';
        return { ok: true, ready: false, state: 'resumeAuthorized', resumeAuthorized: true, lease: structuredClone(nativeLease),
          intervalArmed: true, intervalId, intervalEpoch, intervalIsolated: true, intervalGeneration: nativeLease.generation };
      }
      if (command === 'status') {
        nativeLease.state = 'active'; return { ok: true, ready: true, state: 'active', lease: structuredClone(nativeLease),
          intervalArmed: true, intervalId, intervalEpoch, intervalIsolated: true, intervalGeneration: nativeLease.generation };
      }
      if (command === 'heartbeat') return { ok: true, ready: false, state: nativeLease.state, lease: structuredClone(nativeLease), intervalEpoch, intervalArmed: Boolean(intervalId), intervalId };
      if (command === 'release') {
        nativeLease.state = 'restored';
        return { ok: true, ready: false, state: 'restored', lease: structuredClone(nativeLease),
          exactOriginalRolesRestored: true, defaultsUnchanged: true, globalDefaultsWritten: false, observedDefaultsChanged: false };
      }
      throw new Error(`Unexpected mock command ${command}`);
    }) };
  const route = createOwnedRouteLifecycle({ host, ...options });
  return { host, route, events, inspection, lease: () => nativeLease };
}
export function audioFixture(options: any = {}) {
  const routes = routeFixture(), { events } = routes;
  let clock = 10000, credentialRevision = 0, audio: any;
  const state: any = { device: { id: 'desktop', type: 'computer', is_active: true, is_restricted: false, supports_volume: true, volume_percent: 63 },
    item: { type: 'track', uri: `spotify:track:${oldTrack}`, duration_ms: 120000 },
    currently_playing_type: 'track', progress_ms: 0, is_playing: true, actions: { disallows: {} } };
  const vault = { token: async () => 'test-token', stamp: () => ({ epoch: 0, revision: credentialRevision }),
    grantedScopes: async () => ({ epoch: 0, revision: credentialRevision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const cooldown = { load: async () => 0, defer: async () => {} };
  let intercept: ((operation: string, state: any) => Promise<Response | void> | Response | void) | undefined;
  const fetcher = vi.fn(async (url: string, input: any) => {
    const address = new URL(url);
    const operation = address.pathname.startsWith('/v1/tracks/') ? 'metadata' : input.method === 'GET'
      ? address.pathname.endsWith('/devices') ? 'devices' : 'state'
      : address.pathname.endsWith('/pause') ? 'pause' : address.pathname.endsWith('/seek') ? 'seek'
        : address.pathname.endsWith('/volume') ? 'volume' : address.pathname === '/v1/me/player' ? 'transfer' : input.body ? 'select' : 'play';
    events.push(`control:${operation}`);
    const result = await intercept?.(operation, state); if (result) return result;
    if (operation === 'metadata') return Response.json({ id: address.pathname.split('/').at(-1), type: 'track', uri: `spotify:track:${address.pathname.split('/').at(-1)}`, duration_ms: 120000, is_local: false, is_playable: true, name: 'Fixture track', album: { id: '6n6Rram7vgaVa1iaRUc9Lp', name: 'Fixture album' }, artists: [{ id: '7n7Rram7vgaVa1iaRUc9Lp', name: 'Fixture artist' }] });
    if (operation === 'devices') return Response.json({ devices: [state.device] });
    if (operation === 'state') { events.push(`observed:${state.is_playing ? 'playing' : 'paused'}`); return Response.json(state); }
    if (operation === 'pause') state.is_playing = false;
    if (operation === 'play') state.is_playing = true;
    if (operation === 'volume') { state.device.volume_percent = Number(address.searchParams.get('volume_percent')); events.push(`volume:${state.device.volume_percent}`); }
    if (operation === 'transfer') state.device.is_active = true;
    if (operation === 'select') { state.device.is_active = true; state.item.uri = JSON.parse(input.body).uris[0]; state.progress_ms = JSON.parse(input.body).position_ms; state.is_playing = true; }
    if (operation === 'seek') state.progress_ms = Number(address.searchParams.get('position_ms'));
    return new Response(null, { status: 204 });
  });
  const sourceHarness = options.createSourceHarness?.({ state, vault, now: () => clock, events });
  const control = createDesktopPlaybackControl({ vault, cooldown, fetcher, now: () => clock,
    ...(sourceHarness ? { createSourceApi: () => sourceHarness.source } : {}),
    readRoutePcmEvidence: (session: string, generation: number) => routes.route.pcmStopped(session, generation),
    wait: async (ms: number) => { clock += ms; }, settleIntervalMs: 100, settleTimeoutMs: 400,
    ...(options.selectionTimeoutMs ? { selectionTimeoutMs: options.selectionTimeoutMs } : {}),
    onRevoke: (value: any) => { events.push('control:revoked'); void audio?.revokeSession(value.session, value.code).catch(() => {}); } });
  const controlPrepare = vi.spyOn(control, 'prepare');
  const nativeRequest = routes.host.request.getMockImplementation()!;
  let sourceTarget: any;
  routes.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'acquire') {
      sourceTarget = { action: 'read', session: payload.session, generation: payload.generation, sourceDeviceId: payload.sourceDeviceId,
        expectedSourceUri: payload.expectedSourceUri, pausedPreviousUri: null, allowPreviousPaused: false };
      const status = await control.routeSourceControl(sourceTarget);
      if (status.isPlaying) throw Object.assign(new Error(), { code: 'ROUTE_SOURCE_PAUSE_UNCONFIRMED' });
      if (status.pcmStopped !== true) throw Object.assign(new Error(), { code: 'ROUTE_PROOF_UNCONFIRMED' });
    }
    if (['authorizePreparedSelection', 'rebindPreparedSelection'].includes(command)) sourceTarget = { ...sourceTarget, expectedSourceUri: payload.selectedSourceUri,
      pausedPreviousUri: sourceTarget.expectedSourceUri, allowPreviousPaused: true };
    if (['completePreparedSelection', 'resumePreparation'].includes(command)) sourceTarget = { ...sourceTarget, pausedPreviousUri: null, allowPreviousPaused: false };
    if (command === 'release') {
      events.push('native:release-proof');
      let status = await control.routeSourceControl(sourceTarget);
      if (status.isPlaying && options.recoverOnRelease) {
        await control.routeSourceControl({ ...sourceTarget, action: 'pause' });
        status = await control.routeSourceControl(sourceTarget);
      }
      if (status.isPlaying) throw Object.assign(new Error(), { code: 'ROUTE_SOURCE_PAUSE_UNCONFIRMED' });
    }
    if (command === 'release' && (await control.routeSourceControl(sourceTarget)).pcmStopped !== true)
      throw Object.assign(new Error(), { code: 'ROUTE_PROOF_UNCONFIRMED' });
    return nativeRequest(command, payload);
  });
  const captures: any[] = [];
  const captureHost = { close: vi.fn(async () => { events.push('capture:exit'); }),
    inspectRoute: vi.fn(async () => ({ ready: true, issues: [], selectedSampleRate: 44100, selectedChannels: 2,
      preparedFormat: 's32le', sampleRateConversion: false,
      capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat: { sampleRate: 44100, channels: 2 } },
      render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat: { sampleRate: 44100, channels: 2 } },
      sessions: [{ processId: processIdentity.pid, startedAtUnixMs: processIdentity.startedAtUnixMs, state: 'inactive', identityReadable: true,
        processName: 'Spotify', executablePath: 'C:\\Fixture\\Spotify.exe' }],
      route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } })),
    open: vi.fn(async (input: any) => {
      events.push('capture:open');
      const queue = createCablePcmQueue({ onFailure: (error: any) => { if (error.code !== 'CANCELLED') input.onFailure(error); } });
      const capture = { stream: queue.stream, queue, receivedFrames: () => queue.receivedFrames, generation: captures.length + 1,
        ownedSilentRenderLease: () => ({ captureSession: input.session, captureGeneration: captures.length,
          endpointId: selection.renderDeviceId, sessionInstanceId: `fixture-silent-${captures.length}`,
          groupingId: '87654321-1234-1234-1234-123456789abc', processId: 4321, startedAtUtcTicks: '638355968000000001' }),
        start: vi.fn(async () => { events.push('capture:start'); }), status: vi.fn(async () => {}),
        promote: vi.fn(async () => { events.push('capture:promote'); return { capturedFrames: queue.receivedFrames }; }),
        beginPublication: vi.fn(() => { events.push('capture:publication'); return queue.receivedFrames; }),
        stop: vi.fn(async () => { events.push('capture:stop'); queue.cancel(); }),
        stopVerified: vi.fn(async () => { events.push('capture:stop-verified'); queue.cancel(); }) };
      input.signal.addEventListener('abort', () => queue.cancel(), { once: true }); captures.push(capture); return capture;
    }) };
  let mediaSerial = 0;
  const media = { add: vi.fn(async () => { events.push('media:publish'); return { url: `http://127.0.0.1:1234/test-${++mediaSerial}`, revoke: vi.fn(async () => {}) }; }),
    close: vi.fn(async () => {}) };
  audio = createCableAudioPreparation({ captureHost, control, vault, cooldown, fetcher, media, routeLifecycle: routes.route,
    getSelection: async () => ({ ...selection, automaticRouting: true }), onExternalSelection: options.onExternalSelection });
  return { ...routes, audio, control, controlPrepare, state, captures, captureHost, media, fetcher, sourceHarness,
    changeGrant: () => { credentialRevision++; },
    intercept: (value: typeof intercept) => { intercept = value; },
    async close() { await audio.close().catch(() => {}); await routes.route.close().catch(() => {}); await control.dispose(); sourceHarness?.close(); },
    prepare: () => audio.prepare(trackId, requestId) };
}
