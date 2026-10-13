import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

// test/unit/onlineMusic/cablePostProbeLifecycle.test.ts: real application layers over a simulated native helper and official control.
const require = createRequire(import.meta.url);
const { createCableSetup } = require('../../../electron/spotify/cableSetup.cjs');
const { createCableCaptureHost } = require('../../../electron/spotify/cableCaptureHost.cjs');
const { createCableAudioPreparation } = require('../../../electron/spotify/cableAudioPreparation.cjs');
const { QUEUE_BYTES } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
const selection = { connectDeviceId: 'desktop', captureDeviceId: 'capture', renderDeviceId: 'render',
  internal44100Confirmed: true, spotifyOnlyConfirmed: true, defaultsConfirmed: true };
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp', requestId = '12345678-1234-1234-1234-123456789abc';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// Idle readback deliberately returns 48 kHz after every released probe. No success is retained as native readiness.
function fixture() {
  let routeIssue: string | undefined, leaseHeld = false, active: any, state: any, audio: any;
  const commands: any[] = [], sockets: any[] = [], diagnostics: any[] = [], captureDiagnostics: any[] = [];
  const files = new Map<string, string>();
  function configuration(leaseState?: string) {
    const format = { sampleRate: 44100, channels: 2, containerBits: 32 };
    const endpoint = (flow: string, sampleRate: number) => ({ id: flow, flow, supportedBaseCable: true,
      mixFormat: { ...format, sampleRate } });
    return { ready: Boolean(leaseState) && !routeIssue,
      issues: [...(!leaseState ? ['RENDER_RATE_MISMATCH'] : []), ...(routeIssue ? [routeIssue] : [])],
      temporaryFormatLeaseEligible: !routeIssue, selectedSampleRate: 44100, selectedChannels: 2,
      preparedFormat: 's32le', sampleRateConversion: false,
      capture: endpoint('capture', 44100), render: endpoint('render', leaseState ? 44100 : 48000),
      route: { ready: !routeIssue, spotifyOnlyObserved: !routeIssue, spotifySessionPresent: true },
      sessions: [{ state: 'active', processId: 1234, startedAtUnixMs: 1700000000000, identityReadable: true,
        processName: 'Spotify', executablePath: 'C:\\Spotify\\Spotify.exe' }],
      ...(leaseState ? { formatLease: { state: leaseState, requested: true, verified: true, persistentSettingsChanged: false } } : {}) };
  }
  function snapshot(captureState: string) {
    return { session: active.session, generation: active.generation, pipeName: active.pipeName, state: captureState,
      sampleRate: 44100, channels: 2, bitDepth: 32, sampleFormat: 's32le', sampleRateConversion: false,
      actualMixFormat: { sampleRate: 44100, channels: 2, containerBits: 32 }, queueCapacityBytes: QUEUE_BYTES,
      configuration: configuration('held'), pipeConnected: captureState === 'running', startValidated: captureState === 'running',
      spotifyProcess: { processId: 1234, startedAtUnixMs: 1700000000000 },
      ownedSilentRenderLease: { captureSession: active.session, captureGeneration: active.generation, endpointId: 'render',
        sessionInstanceId: `probe-silent-${active.generation}`, groupingId: '87654321-1234-1234-1234-123456789abc',
        processId: 4321, startedAtUtcTicks: '638355968000000001' } };
  }
  const child: any = new EventEmitter(); child.pid = 4321; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { leaseHeld = false; child.emit('exit', null, 'SIGTERM'); return true; });
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()); commands.push(request); callback();
    queueMicrotask(() => {
      let result;
      switch (request.action) {
        case 'hello': result = { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100, channels: 2,
          bitDepth: 32, sampleFormat: 's32le', queueCapacityBytes: QUEUE_BYTES,
          capabilities: ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', 'post-start-route-proof-v1', 'temporary-format-lease-v1', 'active-silent-format-lease-v1'] }; break;
        case 'devices': result = { spotifyRunning: true, endpoints: ['capture', 'render'].map(flow => ({
          id: flow, flow, name: 'CABLE ' + flow, supportedBaseCable: true })) }; break;
        case 'inspect-route': result = configuration(leaseHeld ? 'held' : undefined); break;
        case 'format-probe': {
          const config = configuration('released');
          result = { state: 'released', verified: true, configuration: config, formatLease: config.formatLease }; break;
        }
        case 'capture-open':
          if (routeIssue) result = { state: 'configuration-required', errorCode: routeIssue, configuration: configuration() };
          else { active = request; leaseHeld = true; result = snapshot('prepared'); }
          break;
        case 'capture-start':
        case 'status': result = snapshot('running'); break;
        case 'capture-stop': leaseHeld = false; result = { session: request.session, generation: request.generation, state: 'closed' }; break;
        default: throw new Error('Unexpected native command: ' + request.action);
      }
      child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
    });
  } });
  const host = createCableCaptureHost({ platform: 'win32', helperPath: 'C:\\Folia\\folia-capture.exe', spawnImpl: () => child,
    connectImpl: () => {
      const socket: any = new EventEmitter(); socket.destroy = vi.fn(() => socket.emit('close')); sockets.push(socket);
      queueMicrotask(() => socket.emit('connect')); return socket;
    }, onControlDiagnostic: (value: any) => diagnostics.push(value), onDiagnostic: (value: any) => captureDiagnostics.push(value) });
  const control = {
    listDevices: vi.fn(async () => [{ id: selection.connectDeviceId, selectable: true, isActive: true, type: 'Computer' }]),
    prepare: vi.fn(async (input: any) => {
      state = { deviceId: input.deviceId, trackId: input.trackId, durationMs: input.durationMs, positionMs: 0, isPlaying: false };
      return { ...state };
    }), readState: vi.fn(async () => ({ ...state })),
    play: vi.fn(async () => { state.isPlaying = true; return { ...state }; }),
    pause: vi.fn(async () => { if (state) state.isPlaying = false; return { ...state }; }),
    seek: vi.fn(async (_session: string, positionMs: number) => { state.positionMs = positionMs; return { ...state }; }),
    close: vi.fn(async () => {}) };
  const io = { readFile: vi.fn(async (file: string) => {
    if (!files.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return files.get(file);
  }), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async (file: string, data: string) => files.set(file, data)),
  rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
  unlink: vi.fn(async (file: string) => files.delete(file)) };
  const setup = createCableSetup({ directory: '/profile/spotify', captureHost: host, control, io, platform: 'win32',
    revokePlayback: async () => audio?.clear() });
  audio = createCableAudioPreparation({ captureHost: host, control, getSelection: () => setup.getSelection(),
    vault: { stamp: () => ({ epoch: 0, revision: 0 }), token: async () => 'test-token',
      grantedScopes: async () => ({ scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) },
    cooldown: { load: async () => 0, defer: async () => {} },
    fetcher: async () => Response.json({ id: trackId, type: 'track', uri: 'spotify:track:' + trackId, duration_ms: 120000 }),
    media: { add: async () => ({ url: 'http://127.0.0.1:1234/opaque', revoke: async () => {} }), close: async () => {} } });
  cleanups.push(async () => { await audio.close(); await setup.close(); await host.close(); });
  return { setup, audio, control, commands, sockets, diagnostics, captureDiagnostics, io,
    request: (operation: string) => setup.request({ action: 'playbackSetup', operation, ...(operation === 'saveSelection' ? { selection } : {}) }),
    count: (action: string) => commands.filter(value => value.action === action).length,
    saved: () => JSON.parse(files.get(join('/profile/spotify', 'cable-setup.json'))!),
    leaseHeld: () => leaseHeld, changeRoute: (issue: string) => { routeIssue = issue; } };
}

it('reacquires after a released setup probe, then holds only playback capture and releases on Stop', async () => {
  const f = fixture();
  await f.request('saveSelection');
  expect(await f.request('probe')).toMatchObject({ state: 'ready', code: 'FORMAT_LEASE_PROBE_RELEASED',
    probe: { captureMixSampleRate: 44100, renderMixSampleRate: 44100, formatLeaseApplied: true } });
  expect(f.saved().enabled).toBe(false); expect(f.leaseHeld()).toBe(false); expect(f.count('format-probe')).toBe(1);
  for (const operation of ['status', 'devices']) expect(await f.request(operation)).toMatchObject({
    state: 'format-mismatch', code: 'CABLE_FORMAT_REQUIRED', probe: { captureMixSampleRate: 44100,
      renderMixSampleRate: 48000, temporaryFormatLeaseEligible: true, formatLeaseApplied: false, routeVerified: true } });
  expect(f.count('format-probe')).toBe(1);
  const beforeStart = f.commands.length;
  expect(await f.request('start')).toMatchObject({ state: 'ready', code: 'FORMAT_LEASE_PROBE_RELEASED' });
  expect(f.commands.slice(beforeStart).map(value => value.action)).toEqual(['devices', 'inspect-route', 'format-probe']);
  expect(f.saved()).toEqual({ schema: 1, enabled: true, selection }); expect(f.leaseHeld()).toBe(false);
  expect(await f.request('status')).toMatchObject({ state: 'ready', code: 'FORMAT_LEASE_ON_PLAY',
    probe: { renderMixSampleRate: 48000, formatLeaseApplied: false, routeVerified: true } });
  const prepared = await f.audio.prepare(trackId, requestId);
  expect(f.count('format-probe')).toBe(3); expect(f.count('capture-open')).toBe(0); expect(f.control.play).not.toHaveBeenCalled();
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const reader = opened.stream[Symbol.asyncIterator](), first = reader.next();
  await vi.waitFor(() => expect(f.control.play).toHaveBeenCalledOnce());
  expect(f.commands.find(value => value.action === 'capture-open')).toMatchObject({ temporaryFormatLease: true,
    expectedSpotifyProcessId: 1234, expectedSpotifyStartedAtUnixMs: 1700000000000 });
  expect(f.leaseHeld()).toBe(true);
  expect(f.captureDiagnostics.find(value => value.phase === 'running')).toMatchObject({ formatLeaseApplied: true });
  f.sockets[0].emit('data', Buffer.alloc(8, 1)); expect((await first).value).toEqual(Buffer.alloc(8, 1));
  await f.request('stop');
  expect(f.count('capture-stop')).toBe(1); expect(f.leaseHeld()).toBe(false); expect(f.saved().enabled).toBe(false);
  expect(f.audio.lookup(prepared.url)).toBeNull();
  expect(f.captureDiagnostics.at(-1)).toMatchObject({ phase: 'stopped', formatLeaseReleased: true });
  await expect(f.setup.getSelection()).rejects.toMatchObject({ code: 'setup-required' });
});

it.each(['FOLIA_FEEDBACK_ROUTE', 'ROUTE_IDENTITY_UNAVAILABLE', 'CABLE_SHARED_WITH_OTHER_AUDIO',
  'CABLE_IS_DEFAULT_RENDER', 'SPOTIFY_ROUTE_NOT_FOUND'])('rejects new %s after old probe success without retrying the unsafe lease', async issue => {
  const f = fixture(); await f.request('saveSelection'); await f.request('probe');
  f.changeRoute(issue); const writes = f.io.writeFile.mock.calls.length;
  expect(await f.request('start')).toMatchObject({ state: 'format-mismatch', code: 'CABLE_FORMAT_REQUIRED',
    probe: { temporaryFormatLeaseEligible: false, formatLeaseApplied: false, routeVerified: false } });
  expect(f.diagnostics.at(-1)).toMatchObject({ operation: 'inspect-route', ok: true,
    configurationIssueCodes: [issue, 'RENDER_RATE_MISMATCH'].sort().join(' ') });
  await expect(f.audio.prepare(trackId, requestId)).rejects.toMatchObject({ code: 'setup-required' });
  expect(f.count('format-probe')).toBe(1); expect(f.count('capture-open')).toBe(0);
  expect(f.control.prepare).not.toHaveBeenCalled(); expect(f.control.play).not.toHaveBeenCalled();
  expect(f.io.writeFile).toHaveBeenCalledTimes(writes); expect(f.saved().enabled).toBe(false);
});

it('blocks an enabled route when a new failure arrives before audio preparation', async () => {
  const f = fixture(); await f.request('saveSelection'); await f.request('start'); f.changeRoute('ROUTE_IDENTITY_UNAVAILABLE');
  await expect(f.audio.prepare(trackId, requestId)).rejects.toMatchObject({ code: 'setup-required' });
  expect(f.saved().enabled).toBe(true); expect(f.count('format-probe')).toBe(1); expect(f.count('capture-open')).toBe(0);
  expect(f.control.prepare).not.toHaveBeenCalled(); expect(f.control.play).not.toHaveBeenCalled();
});

it('rejects new feedback at capture-open even after fresh preparation succeeded', async () => {
  const f = fixture(); await f.request('saveSelection'); await f.request('start');
  const prepared = await f.audio.prepare(trackId, requestId), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable(); f.changeRoute('FOLIA_FEEDBACK_ROUTE');
  await expect(opened.stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'setup-required' });
  expect(f.count('capture-open')).toBe(1); expect(f.count('capture-start')).toBe(0);
  expect(f.leaseHeld()).toBe(false); expect(f.control.play).not.toHaveBeenCalled(); expect(f.audio.lookup(prepared.url)).toBeNull();
  expect(f.diagnostics.at(-1)).toMatchObject({ operation: 'capture-open', ok: false, errorCode: 'FOLIA_FEEDBACK_ROUTE',
    configurationIssueCodes: 'FOLIA_FEEDBACK_ROUTE RENDER_RATE_MISMATCH' });
});
