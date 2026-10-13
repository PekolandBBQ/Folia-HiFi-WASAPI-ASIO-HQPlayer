import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

// test/unit/onlineMusic/r37CaptureSafety.test.ts: targeted legacy-contract replacements using qualified synthetic native replies; no Windows helper or hardware executes.
const require = createRequire(import.meta.url);
const { createCableCaptureHost } = require('../../../electron/spotify/cableCaptureHost.cjs');
const { QUEUE_BYTES, BOOTSTRAP_QUEUE_BYTES, BOOTSTRAP_TIMEOUT_MS, BOOTSTRAP_CAPABILITY } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
const session = '12345678-1234-1234-1234-123456789abc';
const selection = { captureDeviceId: 'capture-private-id', renderDeviceId: 'render-private-id', outputDeviceId: 'physical-private-id' };
const format = { sampleRate: 44100, channels: 2, containerBits: 32 };
function configuration() {
  return { ready: true, issues: [], selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le', sampleRateConversion: false,
    capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat: format },
    render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat: format },
    route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options: any = {}) {
  const calls: any[] = [], sockets: any[] = [], diagnostics: any[] = [], controlDiagnostics: any[] = [];
  const child: any = new EventEmitter(); child.pid = 4321; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    if (options.kill) return options.kill(child);
    child.emit('exit', null, 'SIGTERM'); return true;
  });
  let active: any, promoted = false;
  const reply = (request: any, result: any) => child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
  function snapshot(state: string) {
    const config: any = configuration();
    if (active.bootstrapMode) {
      config.bootstrapReady = true;
      if (!promoted && options.missingSpotifySession) Object.assign(config, { ready: false, issues: ['SPOTIFY_ROUTE_NOT_FOUND'],
        route: { ready: false, spotifyOnlyObserved: false, spotifySessionPresent: false } });
    }
    if (active.temporaryFormatLease) config.formatLease = { state: 'held', requested: true, verified: true, persistentSettingsChanged: false };
    return { session: active.session, generation: active.generation, pipeName: active.pipeName, state,
      sampleRate: 44100, channels: 2, bitDepth: 32, sampleFormat: 's32le', sampleRateConversion: false,
      actualMixFormat: format, queueCapacityBytes: active.bootstrapDelivery === 'buffer' ? (promoted ? QUEUE_BYTES + (options.prefixFrames || 0) * 8 : BOOTSTRAP_QUEUE_BYTES) : QUEUE_BYTES, configuration: config, pipeConnected: state === 'running', startValidated: state === 'running',
      spotifyProcess: { processId: 1234, startedAtUnixMs: 1700000000000,
        ...(active.bootstrapMode ? { startedAtUtcTicks: active.expectedSpotifyStartTimeUtcTicks } : {}) },
      ...(active.temporaryFormatLease ? { ownedSilentRenderLease: { captureSession: active.session, captureGeneration: active.generation,
        endpointId: active.renderDeviceId, sessionInstanceId: `synthetic-format-${active.generation}`, groupingId: '87654321-4321-4321-4321-cba987654321',
        processId: child.pid, startedAtUtcTicks: '638355968000000001' } } : {}),
      ...(active.bootstrapDelivery === 'buffer' ? { bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS, bootstrapQueueCapacityBytes: BOOTSTRAP_QUEUE_BYTES,
        bootstrapPrefixFrames: promoted ? options.prefixFrames || 0 : null } : {}),
      capturedFrames: options.prefixFrames || 0, deliveredFrames: 0, queuedBytes: 0, initialDiscontinuity: false,
      ...(active.bootstrapMode ? { bootstrapMode: active.bootstrapMode, bootstrapDelivery: active.bootstrapDelivery,
        deliveryState: promoted ? 'live' : active.bootstrapDelivery === 'buffer' ? 'buffering' : 'discarding' } : {}) };
  }
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()); calls.push(request); callback();
    queueMicrotask(() => {
      if (options.handle?.(request, reply, child) === true) return;
      if (request.action === 'hello') reply(request, { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100, channels: 2, bitDepth: 32,
        sampleFormat: 's32le', queueCapacityBytes: QUEUE_BYTES, bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS, bootstrapQueueCapacityBytes: BOOTSTRAP_QUEUE_BYTES,
        capabilities: ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', 'post-start-route-proof-v1', 'temporary-format-lease-v1', 'active-silent-format-lease-v1', BOOTSTRAP_CAPABILITY,
          ...(options.bootstrapCapability ? ['paused-source-bootstrap-v1'] : [])] });
      else if (request.action === 'devices') reply(request, { endpoints: [] });
      else if (request.action === 'inspect-route') reply(request, configuration());
      else if (request.action === 'format-probe') {
        const formatLease = { state: 'released', requested: true, verified: true, persistentSettingsChanged: false };
        reply(request, { state: 'released', verified: true, configuration: { ...configuration(), formatLease }, formatLease });
      }
      else if (request.action === 'capture-open') { active = request; reply(request, { ...snapshot('prepared'), ...options.openSnapshot }); }
      else if (request.action === 'capture-start') reply(request, { ...snapshot('running'), ...options.startSnapshot });
      else if (request.action === 'capture-promote') { promoted = true; reply(request, { ...snapshot('running'), ...options.promoteSnapshot }); }
      else if (request.action === 'status') reply(request, snapshot('running'));
      else reply(request, { session: request.session, generation: request.generation, state: 'closed' });
    });
  } });
  const spawnImpl = vi.fn(() => child);
  const connectImpl = vi.fn((input: any) => {
    const socket: any = new EventEmitter(); socket.destroy = vi.fn(() => { socket.emit('close'); }); sockets.push(socket);
    queueMicrotask(() => socket.emit('connect')); return socket;
  });
  const host = (options.createHost || createCableCaptureHost)({ helperPath: 'C:\\Folia\\folia-capture.exe', platform: 'win32', spawnImpl, connectImpl,
    requestTimeoutMs: options.requestTimeoutMs || 8000, pipeTimeoutMs: options.pipeTimeoutMs || 8000,
    exitTimeoutMs: options.exitTimeoutMs || 2000,
    onDiagnostic: (value: any) => diagnostics.push(value),
    onControlDiagnostic: (value: any) => { controlDiagnostics.push(value); options.onControlDiagnostic?.(value); } });
  cleanups.push(() => host.close().catch((error: any) => {
    if (!options.expectedCloseCode) throw error;
    expect(error.code).toBe(options.expectedCloseCode);
  }));
  return { host, child, calls, sockets, spawnImpl, connectImpl, reply, diagnostics, controlDiagnostics };
}

const bootstrap = { ...selection, expectedSpotifyProcessId: 1234, expectedSpotifyStartedAtUnixMs: 1700000000000,
  expectedSpotifyStartTimeUtcTicks: '638355968000000000', temporaryFormatLease: true, bootstrapMode: 'paused-source', bootstrapDelivery: 'buffer' };

it('keeps qualified bounded bootstrap PCM inaccessible through promotion until explicit publication', async () => {
  const f = fixture({ bootstrapCapability: true, missingSpotifySession: true, prefixFrames: 2 });
  const source = await f.host.open({ session, ...bootstrap }); await source.start();
  expect(source.snapshot()).toMatchObject({ deliveryState: 'buffering', configuration: { ready: false, bootstrapReady: true } });
  expect(() => source.stream[Symbol.asyncIterator]()).toThrow('CAPTURE_PROTOCOL_INVALID');
  expect(await source.promote()).toMatchObject({ deliveryState: 'live', capturedFrames: 2, configuration: { ready: true } });
  expect(() => source.stream[Symbol.asyncIterator]()).toThrow('CAPTURE_PROTOCOL_INVALID');
  source.beginPublication(); const next = source.stream[Symbol.asyncIterator]().next();
  f.sockets[0].emit('data', Buffer.alloc(16, 3)); expect((await next).value).toEqual(Buffer.alloc(16, 3));
  await source.stopVerified();
});
it('rejects premature pipe output immediately with zero publication even under a qualified native lease', async () => {
  const f = fixture({ bootstrapCapability: true, missingSpotifySession: true }), onFailure = vi.fn();
  const source = await f.host.open({ session, ...bootstrap, onFailure }); await source.start();
  expect(() => source.stream[Symbol.asyncIterator]()).toThrow('CAPTURE_PROTOCOL_INVALID');
  f.sockets[0].emit('data', Buffer.alloc(8));
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAPTURE_PROTOCOL_INVALID' }));
  expect(f.sockets[0].destroy).toHaveBeenCalled(); expect(f.calls.some(value => value.action === 'capture-promote')).toBe(false);
  expect(() => source.stream[Symbol.asyncIterator]()).toThrow('CAPTURE_PROTOCOL_INVALID');
  await source.stopVerified();
});
it('rejects discard promotion and malformed full-route confirmation without publishing PCM', async () => {
  const f = fixture({ bootstrapCapability: true, missingSpotifySession: true });
  const discard = await f.host.open({ session, ...bootstrap, bootstrapDelivery: 'discard' }); await discard.start();
  await expect(discard.promote()).rejects.toThrow('CAPTURE_PROTOCOL_INVALID'); await discard.stopVerified();
  const g = fixture({ bootstrapCapability: true, missingSpotifySession: true, promoteSnapshot: { configuration: { ready: false } } });
  const buffered = await g.host.open({ session, ...bootstrap }); await buffered.start();
  await expect(buffered.promote()).rejects.toThrow('CAPTURE_CONFIGURATION_REQUIRED');
  expect(() => buffered.beginPublication()).toThrow('CANCELLED');
});
it('keeps native lease cleanup independent of a throwing diagnostic projection', async () => {
  const schema = require('../../../electron/debug/privatePreviewDiagnosticSchema.cjs');
  const filename = require.resolve('../../../electron/spotify/cableCaptureHost.cjs'), cached = require.cache[filename];
  const project = schema.projectConfigurationIssueCodes; let createHost;
  try { schema.projectConfigurationIssueCodes = () => { throw new Error('PRIVATE_PROJECTION_FAILURE'); };
    delete require.cache[filename]; createHost = require(filename).createCableCaptureHost;
  } finally { schema.projectConfigurationIssueCodes = project; require.cache[filename] = cached; }
  const f = fixture({ createHost });
  expect(await f.host.inspectRoute(selection)).toEqual(configuration());
  expect(await f.host.formatProbe({ ...selection, temporaryFormatLease: true })).toMatchObject({ state: 'released', verified: true });
  const capture = await f.host.open({ session, ...selection, temporaryFormatLease: true });
  expect(await capture.start()).toMatchObject({ state: 'running' }); await capture.stopVerified();
  expect(f.diagnostics.at(-1)).toMatchObject({ phase: 'stopped', formatLeaseReleased: true });
  expect(JSON.stringify(f.controlDiagnostics)).not.toContain('PRIVATE_PROJECTION_FAILURE');
});
it('requires explicit format-lease opt-in and confirms exact native stop before released evidence', async () => {
  const f = fixture(); await expect(f.host.formatProbe(selection)).rejects.toThrow('CAPTURE_CONFIGURATION_REQUIRED');
  expect(f.spawnImpl).not.toHaveBeenCalled();
  expect(await f.host.formatProbe({ ...selection, temporaryFormatLease: true })).toMatchObject({ formatLease: { state: 'released' } });
  const source = await f.host.open({ session, ...selection, temporaryFormatLease: true }); await source.start();
  expect(f.diagnostics.some(value => value.formatLeaseApplied)).toBe(true);
  await source.stopVerified(); expect(f.diagnostics.at(-1)).toMatchObject({ phase: 'stopped', formatLeaseReleased: true });
});
it('preserves capture-open rejection and bounded HRESULT before any PCM connection', async () => {
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== 'capture-open') return false;
    reply(request, { state: 'configuration-required', errorCode: 'FORMAT_LEASE_LOCKED', hresult: -2004287447,
      message: 'PRIVATE_NATIVE_ERROR', devicePath: 'PRIVATE_DEVICE_PATH' }); return true;
  } });
  await expect(f.host.open({ session, ...selection, temporaryFormatLease: true })).rejects.toThrow('FORMAT_LEASE_LOCKED');
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'result', operation: 'capture-open', ok: false,
    errorCode: 'FORMAT_LEASE_LOCKED', hresult: -2004287447 });
  expect(JSON.stringify(f.controlDiagnostics)).not.toMatch(/PRIVATE_|message|devicePath/); expect(f.connectImpl).not.toHaveBeenCalled();
});
it('revokes held-lease PCM immediately and waits for exact child exit across duplicate close', async () => {
  const f = fixture({ kill: () => true, exitTimeoutMs: 1000 });
  const source = await f.host.open({ session, ...selection, temporaryFormatLease: true }); await source.start();
  const next = source.stream[Symbol.asyncIterator]().next(), closed = f.host.close(), done = vi.fn();
  closed.then(done); expect(f.host.close()).toBe(closed);
  await expect(next).rejects.toThrow('CANCELLED'); await tick(); expect(done).not.toHaveBeenCalled();
  expect(f.diagnostics.some(value => value.formatLeaseReleased)).toBe(false);
  f.child.emit('exit', 0); await closed; expect(done).toHaveBeenCalledOnce();
  expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.controlDiagnostics.some(value => value.phase === 'failed')).toBe(false);
});
