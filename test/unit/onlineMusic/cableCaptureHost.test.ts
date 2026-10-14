import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

// test/unit/onlineMusic/cableCaptureHost.test.ts: native protocol is mocked; no Windows helper or hardware executes.
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
it('preserves native capture binding failures with a specific Chinese explanation', () => {
  const { failure } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
  const { failureDetails } = require('../../../electron/spotify/failureDetails.cjs');
  const error = failure('CAPTURE_STATE_INVALID');
  expect(error.code).toBe('CAPTURE_STATE_INVALID');
  expect(failureDetails(error, 'capture-open').detail).toContain('格式或运行状态不一致');
});
it('accepts independently negotiated process PCM with different VB endpoint formats, preserving legacy endpoint checks', () => {
  const { requireConfiguration, requireBootstrapConfiguration } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
  const config = configuration();
  Object.assign(config.route, { evidenceKind: 'windows-process-tree-loopback' });
  config.capture.mixFormat = { sampleRate: 48000, channels: 8, containerBits: 24 };
  config.render.mixFormat = { sampleRate: 96000, channels: 2, containerBits: 32 };
  expect(requireConfiguration(config, selection)).toBe(config);
  expect(requireBootstrapConfiguration({ ...config, bootstrapReady: true }, selection)).toBeDefined();
  Object.assign(config.route, { evidenceKind: 'windows-render-session-process-snapshot' });
  expect(() => requireConfiguration(config, selection)).toThrow('CAPTURE_PROTOCOL_INVALID');
});
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options: any = {}) {
  const calls: any[] = [], sockets: any[] = [], diagnostics: any[] = [], controlDiagnostics: any[] = [];
  const child: any = new EventEmitter(); child.pid = 4321; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    if (options.kill) return options.kill(child);
    child.emit('exit', null, 'SIGTERM'); return true;
  });
  let active: any, promoted = false, epoch: any;
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
      ...(epoch ? { positionEpoch: { positionIntentId: epoch.positionIntentId, cutSequence: epoch.cutSequence } } : {}),
      capturedFrames: options.prefixFrames || 0, deliveredFrames: 0, queuedBytes: 0, initialDiscontinuity: false,
      ...(active.bootstrapMode ? { bootstrapMode: active.bootstrapMode, bootstrapDelivery: active.bootstrapDelivery,
        deliveryState: promoted ? 'live' : active.bootstrapDelivery === 'buffer' ? 'buffering' : 'discarding' } : {}) };
  }
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()); calls.push(request); callback();
    queueMicrotask(() => {
      if (options.handle?.(request, reply, child) === true) return;
      if (request.action === 'hello') reply(request, { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100, channels: 2, bitDepth: 32,
        sampleFormat: 's32le', ...(options.seekCapability ? { componentVersion: '0.1.5-capture.7' } : {}), queueCapacityBytes: QUEUE_BYTES, bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS, bootstrapQueueCapacityBytes: BOOTSTRAP_QUEUE_BYTES,
        capabilities: ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', 'post-start-route-proof-v1', 'temporary-format-lease-v1', 'active-silent-format-lease-v1', BOOTSTRAP_CAPABILITY,
          ...(options.processCapability ? ['windows-process-tree-loopback-v1'] : []),
          ...(options.bootstrapCapability ? ['paused-source-bootstrap-v1'] : []),
          ...(options.seekCapability ? ['bounded-playing-seek-device-reuse-v1', 'unpublished-position-epoch-v1'] : [])] });
      else if (request.action === 'devices') reply(request, { endpoints: [] });
      else if (request.action === 'inspect-route') reply(request, configuration());
      else if (request.action === 'format-probe') {
        const formatLease = { state: 'released', requested: true, verified: true, persistentSettingsChanged: false };
        reply(request, { state: 'released', verified: true, configuration: { ...configuration(), formatLease }, formatLease });
      }
      else if (request.action === 'capture-open') { active = request; promoted = false; epoch = undefined; reply(request, { ...snapshot('prepared'), ...options.openSnapshot }); }
      else if (request.action === 'capture-start') reply(request, { ...snapshot('running'), ...options.startSnapshot });
      else if (request.action === 'capture-promote') { promoted = true; reply(request, { ...snapshot('running'), ...options.promoteSnapshot }); }
      else if (request.action === 'capture-seek-park') reply(request, parkReceipt(request));
      else if (request.action === 'capture-begin-position-epoch') {
        epoch = { session: request.session, generation: request.generation, positionIntentId: request.positionIntentId, cutSequence: 1,
          capturedFramesAtCut: 0, deliveredFramesAtCut: 0, queuedBytesAtCut: 0, freshBuffer: true, startValidated: true, stoppedAndResetAtUnixMs: Date.now() };
        options.prefixFrames = 0; reply(request, epoch);
      }
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
    fastInitialEpoch: options.fastInitialEpoch === true,
    requireProcessCapture: options.requireProcessCapture === true,
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
it('does not silently use endpoint mix capture when process capture is required', async () => {
  const f = fixture({ requireProcessCapture: true });
  await expect(f.host.devices()).rejects.toMatchObject({ code: 'CAPTURE_PROTOCOL_INVALID' });
  expect(f.calls.some((call: any) => call.action === 'capture-open')).toBe(false);
});
it('accepts the process capture capability from the paired helper', async () => {
  const f = fixture({ requireProcessCapture: true, processCapability: true });
  await expect(f.host.devices()).resolves.toEqual({ endpoints: [] });
});
it('does no constructor I/O and spawns only the main-owned hidden helper with bounded JSONL control', async () => {
  const f = fixture(); expect(f.spawnImpl).not.toHaveBeenCalled();
  expect(await f.host.devices()).toEqual({ endpoints: [] });
  expect(f.spawnImpl).toHaveBeenCalledWith('C:\\Folia\\folia-capture.exe', [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  expect(f.calls.map(value => value.action)).toEqual(['hello', 'devices']);
  expect(() => createCableCaptureHost({ helperPath: '/tmp/helper.exe', platform: 'linux' })).toThrow('CAPTURE_UNSUPPORTED_PLATFORM');
  expect(() => createCableCaptureHost({ helperPath: 'helper.exe', platform: 'win32' })).toThrow('CAPTURE_PROTOCOL_INVALID');
});
const bootstrap = { ...selection, expectedSpotifyProcessId: 1234, expectedSpotifyStartedAtUnixMs: 1700000000000,
  expectedSpotifyStartTimeUtcTicks: '638355968000000000', temporaryFormatLease: true, bootstrapMode: 'paused-source', bootstrapDelivery: 'buffer' };
it('requires the explicit native bootstrap capability and exact process ticks', async () => {
  const f = fixture(); await expect(f.host.open({ session, ...bootstrap })).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' });
  expect(f.calls.some(value => value.action === 'capture-open')).toBe(false);
  const g = fixture({ bootstrapCapability: true });
  await expect(g.host.open({ session, ...bootstrap, expectedSpotifyStartTimeUtcTicks: undefined })).rejects.toThrow('CAPTURE_CONFIGURATION_REQUIRED');
  expect(g.spawnImpl).not.toHaveBeenCalled();
});
it('allows only qualified paused bootstrap with no Spotify session and keeps PCM closed until promotion', async () => {
  const f = fixture({ bootstrapCapability: true, missingSpotifySession: true, prefixFrames: 2 });
  const source = await f.host.open({ session, ...bootstrap });
  expect(source.snapshot()).toMatchObject({ deliveryState: 'buffering', configuration: { ready: false, bootstrapReady: true } });
  await source.start(); expect(() => source.stream[Symbol.asyncIterator]()).toThrow('CAPTURE_PROTOCOL_INVALID');
  expect(await source.promote()).toMatchObject({ deliveryState: 'live', capturedFrames: 2, configuration: { ready: true } });
  source.beginPublication(); const read = source.stream[Symbol.asyncIterator]().next();
  f.sockets[0].emit('data', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  expect((await read).value).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])); await source.stopVerified();
});
it('rejects premature pipe output instead of silently using a leaking native bootstrap', async () => {
  const f = fixture({ bootstrapCapability: true, missingSpotifySession: true });
  const onFailure = vi.fn(), source = await f.host.open({ session, ...bootstrap, onFailure }); await source.start();
  expect(() => source.stream[Symbol.asyncIterator]()).toThrow('CAPTURE_PROTOCOL_INVALID');
  f.sockets[0].emit('data', Buffer.alloc(8));
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAPTURE_PROTOCOL_INVALID' }));
  expect(f.calls.some(value => value.action === 'capture-promote')).toBe(false);
});
it('never promotes preparation-discard mode and requires the complete normal route on promotion', async () => {
  const f = fixture({ bootstrapCapability: true, missingSpotifySession: true });
  const discard = await f.host.open({ session, ...bootstrap, bootstrapDelivery: 'discard' }); await discard.start();
  await expect(discard.promote()).rejects.toThrow('CAPTURE_PROTOCOL_INVALID'); await discard.stopVerified();
  const g = fixture({ bootstrapCapability: true, missingSpotifySession: true, promoteSnapshot: { configuration: { ready: false } } });
  const buffered = await g.host.open({ session, ...bootstrap }); await buffered.start();
  await expect(buffered.promote()).rejects.toThrow('CAPTURE_CONFIGURATION_REQUIRED');
});
it('keeps a manual-to-automatic transition behind the exact predecessor stop acknowledgment', async () => {
  let stopRequest: any, sendStop: Function | undefined;
  const f = fixture({ handle(request: any, reply: Function) {
    if (request.action !== 'capture-stop') return false; stopRequest = request; sendStop = reply; return true;
  } });
  const source = await f.host.open({ session, ...selection }); await source.start();
  const stopping = source.stop(), verified = f.host.verifyStopped(); let complete = false;
  void verified.then(() => { complete = true; }); await tick(); expect(complete).toBe(false);
  sendStop!(stopRequest, { session, generation: source.generation, state: 'closed' });
  await stopping; await verified; expect(complete).toBe(true);
});
it('requires the selected endpoint pair before spawning and never asks for default capture', async () => {
  const f = fixture(); await expect(f.host.inspectRoute({})).rejects.toThrow('CAPTURE_CONFIGURATION_REQUIRED');
  expect(f.spawnImpl).not.toHaveBeenCalled(); await f.host.inspectRoute(selection);
  expect(f.calls.at(-1)).toMatchObject({ action: 'inspect-route', ...selection });
});
it('reports read-only endpoint inventory and handshake without driver installation claims or identities', async () => {
  const endpoints = ['capture', 'render'].map(flow => ({ id: flow + '-private-id', name: 'private-name',
    devicePath: 'C:\\private\\driver', flow, supportedBaseCable: true, mixFormat: { sampleRate: 48000, channels: 2, containerBits: 32 } }));
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== 'devices') return false;
    reply(request, { endpoints, driverInstalled: true, token: 'private-token' }); return true;
  } });
  expect((await f.host.devices()).endpoints).toEqual(endpoints);
  expect(f.controlDiagnostics.find(value => value.phase === 'hello')).toMatchObject({ protocolMajor: 1,
    helperPlatform: 'win32-x64', processPlatform: 'win32', processArchitecture: process.arch, helloCompatible: true,
    baseCableCapability: true, pcmPipeCapability: true, routeObservationCapability: true, temporaryFormatLeaseCapability: true });
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'inventory', captureEndpointCount: 1, renderEndpointCount: 1,
    singleCaptureMixSampleRate: 48000, singleRenderMixSampleRate: 48000, singleCaptureBits: 32 });
  expect(JSON.stringify(f.controlDiagnostics)).not.toMatch(/private-|private\\|driverInstalled|endpointId|devicePath/);
  expect(f.calls.map(value => value.action)).toEqual(['hello', 'devices']);
});
it('records fixed native failure codes and numeric HRESULTs without exception text', async () => {
  const f = fixture({ handle(request: any, _reply: any, child: any) {
    if (request.action !== 'devices') return false;
    child.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: 'ENDPOINT_UNAVAILABLE',
      hresult: -2004287484, message: 'PRIVATE_PATH', token: 'PRIVATE_TOKEN' }) + '\n'); return true;
  } });
  await expect(f.host.devices()).rejects.toThrow('ENDPOINT_UNAVAILABLE');
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'result', operation: 'devices', ok: false,
    errorCode: 'ENDPOINT_UNAVAILABLE', hresult: -2004287484 });
  expect(JSON.stringify(f.controlDiagnostics)).not.toMatch(/PRIVATE_PATH|PRIVATE_TOKEN/);
});
it('observes a rejected helper handshake without retaining unexpected helper strings', async () => {
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== 'hello') return false;
    reply(request, { protocolMajor: 2, platform: 'PRIVATE_PATH', capabilities: ['PRIVATE_TOKEN'] }); return true;
  } });
  await expect(f.host.devices()).rejects.toThrow('CAPTURE_PROTOCOL_INVALID');
  expect(f.controlDiagnostics.find(value => value.phase === 'hello')).toMatchObject({ protocolMajor: 2,
    helloCompatible: false, baseCableCapability: false, errorCode: 'CAPTURE_PROTOCOL_INVALID' });
  expect(JSON.stringify(f.controlDiagnostics)).not.toMatch(/PRIVATE_PATH|PRIVATE_TOKEN/);
  expect(f.calls).toHaveLength(1);
});
it('does not let diagnostic failures interfere with helper commands', async () => {
  const f = fixture({ onControlDiagnostic() { throw new Error('diagnostics unavailable'); } });
  expect(await f.host.devices()).toEqual({ endpoints: [] });
  await f.host.close(); expect(f.controlDiagnostics.some(value => value.phase === 'failed')).toBe(false);
});
it('keeps native results and guarded playback unchanged even if configuration projection throws', async () => {
  const schema = require('../../../electron/debug/privatePreviewDiagnosticSchema.cjs');
  const filename = require.resolve('../../../electron/spotify/cableCaptureHost.cjs'), cached = require.cache[filename];
  const project = schema.projectConfigurationIssueCodes;
  let createHost;
  try {
    schema.projectConfigurationIssueCodes = () => { throw new Error('PRIVATE_PROJECTION_FAILURE'); };
    delete require.cache[filename]; createHost = require(filename).createCableCaptureHost;
  } finally { schema.projectConfigurationIssueCodes = project; require.cache[filename] = cached; }
  const f = fixture({ createHost });
  expect(await f.host.inspectRoute(selection)).toEqual(configuration());
  expect(await f.host.formatProbe({ ...selection, temporaryFormatLease: true })).toMatchObject({ state: 'released', verified: true });
  const capture = await f.host.open({ session, ...selection, temporaryFormatLease: true });
  expect(await capture.start()).toMatchObject({ state: 'running' }); await capture.stop();
  expect(f.diagnostics.at(-1)).toMatchObject({ phase: 'stopped', formatLeaseReleased: true });
  expect(JSON.stringify(f.controlDiagnostics)).not.toContain('PRIVATE_PROJECTION_FAILURE');
});
it('connects only a fresh random private pipe and requires capture running before returning start', async () => {
  const f = fixture(), opened = await f.host.open({ session, ...selection });
  const request = f.calls.find(value => value.action === 'capture-open');
  expect(request.pipeName).toMatch(/^folia-capture-[a-f0-9]{32}$/);
  expect(f.connectImpl.mock.calls[0][0].path).toBe('\\\\.\\pipe\\' + request.pipeName);
  expect(f.calls.some(value => value.action === 'capture-start')).toBe(false);
  expect(await opened.start()).toMatchObject({ state: 'running', generation: 1 });
  await opened.status(); await opened.stop();
  const second = await f.host.open({ session, ...selection });
  expect(second.generation).toBe(2); expect(f.calls.filter(value => value.action === 'capture-open')[1].pipeName).not.toBe(request.pipeName);
  expect(f.diagnostics.map(value => value.phase)).toContain('sample');
  expect(JSON.stringify(f.diagnostics)).not.toMatch(/private-id|folia-capture-|C:\\\\Folia/);
});
it.each([{ sampleRate: 48000 }, { pipeName: 'foreign-pipe' }, { channels: 1 }, { sampleRateConversion: true }])
('rejects mismatched capture snapshots before connecting: %o', async openSnapshot => {
  const f = fixture({ openSnapshot }); await expect(f.host.open({ session, ...selection })).rejects.toThrow('CAPTURE_PROTOCOL_INVALID');
  expect(f.connectImpl).not.toHaveBeenCalled(); expect(f.calls.at(-1).action).toBe('capture-stop');
});
it('rejects a starting acknowledgement rather than playing before WASAPI is running', async () => {
  const f = fixture({ startSnapshot: { state: 'starting' } }), onFailure = vi.fn();
  const source = await f.host.open({ session, ...selection, onFailure });
  await expect(source.start()).rejects.toThrow('CAPTURE_PROTOCOL_INVALID'); expect(onFailure).toHaveBeenCalledOnce();
});
it('assembles divided frames and delivers bounded private copies', async () => {
  const f = fixture(), source = await f.host.open({ session, ...selection }); await source.start();
  const reader = source.stream[Symbol.asyncIterator](), first = reader.next();
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); f.sockets[0].emit('data', bytes.subarray(0, 3));
  f.sockets[0].emit('data', bytes.subarray(3));
  const received = (await first).value; bytes.fill(0); expect(received).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  f.sockets[0].emit('data', Buffer.alloc(65536)); expect((await reader.next()).value.length).toBe(32768);
});
it('fails and clears an incomplete final frame instead of producing a short PCM sample', async () => {
  const f = fixture(), onFailure = vi.fn(), source = await f.host.open({ session, ...selection, onFailure }); await source.start();
  const next = source.stream[Symbol.asyncIterator]().next(); f.sockets[0].emit('data', Buffer.alloc(7)); f.sockets[0].emit('end');
  await expect(next).rejects.toThrow('CAPTURE_FRAME_INVALID'); expect(onFailure.mock.calls[0][0].code).toBe('CAPTURE_FRAME_INVALID');
  expect(f.sockets[0].destroy).toHaveBeenCalled();
});
it('fails overflow without backpressuring pipe reads or silently dropping PCM', async () => {
  const f = fixture(), onFailure = vi.fn(), source = await f.host.open({ session, ...selection, onFailure }); await source.start();
  f.sockets[0].emit('data', Buffer.alloc(QUEUE_BYTES)); f.sockets[0].emit('data', Buffer.alloc(8));
  await expect(source.stream[Symbol.asyncIterator]().next()).rejects.toThrow('CAPTURE_OVERFLOW');
  expect(onFailure).toHaveBeenCalledOnce(); expect(f.sockets[0].destroy).toHaveBeenCalled();
});
it('aborts a waiting read immediately and old stop or helper events cannot close its replacement', async () => {
  const f = fixture(), abort = new AbortController();
  const first = await f.host.open({ session, ...selection, signal: abort.signal }); await first.start();
  const waiting = first.stream[Symbol.asyncIterator]().next(); abort.abort(); await expect(waiting).rejects.toThrow('CANCELLED');
  const second = await f.host.open({ session, ...selection }); await second.start(); await first.stop();
  f.child.stdout.write(JSON.stringify({ event: 'capture-error', session, generation: first.generation, errorCode: 'CAPTURE_OVERFLOW' }) + '\n');
  const next = second.stream[Symbol.asyncIterator]().next(); f.sockets[1].emit('data', Buffer.alloc(8, 4));
  expect((await next).value).toEqual(Buffer.alloc(8, 4)); expect(f.sockets[1].destroy).not.toHaveBeenCalled();
});
it('sanitizes helper errors and revokes active PCM on an unexpected helper exit', async () => {
  const f = fixture(), onFailure = vi.fn(), source = await f.host.open({ session, ...selection, onFailure }); await source.start();
  const next = source.stream[Symbol.asyncIterator]().next(); f.child.emit('exit', 1);
  await expect(next).rejects.toMatchObject({ message: 'CAPTURE_HELPER_CLOSED' });
  expect(onFailure).toHaveBeenCalledOnce(); expect(f.diagnostics.at(-1).errorCode).toBe('CAPTURE_HELPER_CLOSED');
  const malformed = fixture({ handle(request: any, _reply: any, child: any) {
    if (request.action === 'devices') { child.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: '/private/token/device' }) + '\n'); return true; }
  } });
  await expect(malformed.host.devices()).rejects.toMatchObject({ message: 'CAPTURE_REQUEST_FAILED', code: 'CAPTURE_REQUEST_FAILED' });
});
it('bounds response lines and kills a helper that never answers a command', async () => {
  const f = fixture({ requestTimeoutMs: 20, handle(request: any) { return request.action === 'devices'; } });
  await expect(f.host.devices()).rejects.toThrow('CAPTURE_CONTROL_TIMEOUT'); expect(f.child.kill).toHaveBeenCalledOnce();
  const malformed = fixture({ handle(request: any, _reply: any, child: any) {
    if (request.action === 'devices') { child.stdout.write(Buffer.alloc(262145)); return true; }
  } });
  await expect(malformed.host.devices()).rejects.toThrow('CAPTURE_PROTOCOL_INVALID');
});
it('bounds outstanding control requests', async () => {
  const f = fixture({ requestTimeoutMs: 50, handle(request: any) { return request.action === 'devices'; } });
  const requests = Array.from({ length: 17 }, () => f.host.devices().catch((error: any) => error));
  await tick(); const all = await Promise.all(requests);
  expect(all.some(value => value.code === 'CAPTURE_CONTROL_BUSY')).toBe(true);
  expect(f.calls.filter(value => value.action === 'devices')).toHaveLength(1);
});
it.each(['HELPER_RESTART_REQUIRED', 'CAPTURE_STOP_TIMEOUT'])('replaces only the poisoned helper after %s', async code => {
  const f = fixture({ handle(request: any, _reply: any, child: any) {
    if (request.action === 'capture-stop') { child.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: code }) + '\n'); return true; }
  } }), replacement = fixture();
  f.spawnImpl.mockImplementationOnce(() => f.child).mockImplementationOnce(() => replacement.child);
  const old = await f.host.open({ session, ...selection }); await old.start(); await old.stop();
  expect(f.child.kill).toHaveBeenCalledOnce();
  const next = await f.host.open({ session, ...selection }); await next.start();
  expect(f.spawnImpl).toHaveBeenCalledTimes(2); f.child.emit('exit', 1);
  expect(replacement.child.kill).not.toHaveBeenCalled();
  const frame = next.stream[Symbol.asyncIterator]().next(); f.sockets[1].emit('data', Buffer.alloc(8, 2));
  expect((await frame).value).toEqual(Buffer.alloc(8, 2));
});
it('probes and releases only an explicitly enabled format lease, then verifies held capture evidence', async () => {
  const f = fixture(); await expect(f.host.formatProbe(selection)).rejects.toThrow('CAPTURE_CONFIGURATION_REQUIRED');
  expect(f.spawnImpl).not.toHaveBeenCalled();
  const result = await f.host.formatProbe({ ...selection, temporaryFormatLease: true });
  expect(result.formatLease.state).toBe('released');
  const source = await f.host.open({ session, ...selection, temporaryFormatLease: true }); await source.start(); await source.stop();
  expect(f.diagnostics.some(value => value.formatLeaseApplied)).toBe(true);
  expect(f.diagnostics.at(-1)).toMatchObject({ phase: 'stopped', formatLeaseReleased: true });
});
it.each(['FORMAT_LEASE_IDENTITY_UNAVAILABLE', 'FORMAT_LEASE_IDENTITY_LIMIT'])
('retains a native lease identity failure as a setup error after cleanup: %s', async errorCode => {
  const { publicError } = require('../../../electron/spotify/cableAudioFacts.cjs');
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== 'format-probe') return false;
    reply(request, { state: 'configuration-required', errorCode, message: 'PRIVATE_IDENTITY' }); return true;
  } });
  const error = await f.host.formatProbe({ ...selection, temporaryFormatLease: true }).catch((value: any) => value);
  expect(error).toMatchObject({ code: errorCode, message: errorCode });
  expect(publicError(error)).toMatchObject({ code: 'setup-required', message: 'Spotify: cable-configuration-required' });
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'result', operation: 'format-probe', ok: false, errorCode });
  expect(f.child.kill).not.toHaveBeenCalled(); expect(f.connectImpl).not.toHaveBeenCalled();
  expect(JSON.stringify(f.controlDiagnostics)).not.toContain('PRIVATE_IDENTITY');
});
it('passes the prepared Spotify process binding and rejects a changed helper identity', async () => {
  const f = fixture();
  await expect(f.host.open({ session, ...selection, expectedSpotifyProcessId: 9876, expectedSpotifyStartedAtUnixMs: 1700000000000 }))
    .rejects.toThrow('SPOTIFY_PROCESS_CHANGED');
  expect(f.calls.find(value => value.action === 'capture-open')).toMatchObject({ expectedSpotifyProcessId: 9876, expectedSpotifyStartedAtUnixMs: 1700000000000 });
  expect(f.connectImpl).not.toHaveBeenCalled();
});
it('preserves usable endpoints despite failed supplementary interface enumeration and exports only bounded facts', async () => {
  const endpoints = ['capture', 'render'].map(flow => ({ id: flow + '-private-id', flow,
    supportedBaseCable: true, mixFormat: format }));
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== 'devices') return false;
    reply(request, { endpoints, endpointInventory: { state: 'partial', activeCount: 2, disabledCount: 1,
      notPresentCount: 0, unpluggedCount: 0, unreadableCount: 1, hresult: -2147467259, path: 'PRIVATE_ENDPOINT' },
      controlInterface: { state: 'failed', interfaceCount: 0, activeInterfaceCount: 0, win32Error: 5,
        failureStage: 'enumerate', interfacePath: 'PRIVATE_INTERFACE' } }); return true;
  } });
  expect((await f.host.devices()).endpoints).toEqual(endpoints);
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'inventory', captureEndpointCount: 1,
    renderEndpointCount: 1, endpointInventoryState: 'partial', endpointActiveCount: 2,
    endpointDisabledCount: 1, endpointUnreadableCount: 1, endpointHresult: -2147467259,
    controlInterfaceState: 'failed', controlInterfaceWin32Error: 5, controlInterfaceFailureStage: 'enumerate' });
  expect(JSON.stringify(f.controlDiagnostics)).not.toMatch(/PRIVATE_|private-id/);
  const source = await f.host.open({ session, ...selection });
  expect(await source.start()).toMatchObject({ state: 'running' });
});
it.each(['format-probe', 'capture-open'])('retains nested configuration failure HRESULT from an otherwise valid %s reply', async operation => {
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== operation) return false;
    reply(request, { state: 'configuration-required', errorCode: 'FORMAT_LEASE_LOCKED',
      hresult: -2004287447, message: 'PRIVATE_NATIVE_ERROR', devicePath: 'PRIVATE_DEVICE_PATH' }); return true;
  } });
  const action = operation === 'format-probe' ? f.host.formatProbe({ ...selection, temporaryFormatLease: true })
    : f.host.open({ session, ...selection, temporaryFormatLease: true });
  await expect(action).rejects.toThrow('FORMAT_LEASE_LOCKED');
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'result', operation, ok: false,
    errorCode: 'FORMAT_LEASE_LOCKED', hresult: -2004287447 });
  expect(JSON.stringify(f.controlDiagnostics)).not.toMatch(/PRIVATE_|message|devicePath/);
  expect(f.connectImpl).not.toHaveBeenCalled();
});
it.each(['format-probe', 'capture-open'])('preserves requested and observed format differences from a rejected %s before a capture session exists', async operation => {
  const requested = { sampleRate: 44100, channels: 2, containerBits: 32, validBits: 32,
    blockAlign: 8, averageBytesPerSecond: 352800, encoding: 'float', channelMask: 3, subFormatKind: 'float' };
  const readback = { endpointRole: 'render', comparison: 'descriptor', periodFrames: 441, requested,
    observed: { ...requested, channelMask: 0, subFormatKind: 'none' }, differingFields: ['channelMask', 'subFormatKind'] };
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== operation) return false;
    reply(request, { state: 'configuration-required', errorCode: 'FORMAT_LEASE_READBACK_MISMATCH', formatLeaseReadback: readback }); return true;
  } });
  await expect(operation === 'format-probe' ? f.host.formatProbe({ ...selection, temporaryFormatLease: true })
    : f.host.open({ session, ...selection, temporaryFormatLease: true })).rejects.toThrow('FORMAT_LEASE_READBACK_MISMATCH');
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ formatLeaseReadback: readback });
});
it('classifies a code-free native configuration response as configuration-required, not a capture failure', async () => {
  const f = fixture({ handle(request: any, reply: any) {
    if (request.action !== 'format-probe') return false;
    reply(request, { state: 'configuration-required' }); return true;
  } });
  await expect(f.host.formatProbe({ ...selection, temporaryFormatLease: true })).rejects.toThrow('CAPTURE_CONFIGURATION_REQUIRED');
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'result', operation: 'format-probe', ok: false,
    errorCode: 'CAPTURE_CONFIGURATION_REQUIRED' });
});
it('rejects a native different-owner pair before opening a pipe and reports only its fixed setup failure', async () => {
  const { publicError } = require('../../../electron/spotify/cableAudioFacts.cjs');
  const { reportCableHelper } = require('../../../electron/spotify/cableDiagnostics.cjs');
  const { installPreviewDiagnosticSink } = require('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
  const journal: any[] = [];
  const restore = installPreviewDiagnosticSink({ enabled: () => true,
    record: (type: string, fields: any) => { journal.push({ type, fields }); return true; } });
  cleanups.push(async () => restore());
  const f = fixture({ onControlDiagnostic: reportCableHelper, handle(request: any, reply: any) {
    if (request.action !== 'capture-open') return false;
    const config = configuration();
    reply(request, { state: 'configuration-required', errorCode: 'BASE_CABLE_ENDPOINT_REQUIRED',
      configuration: { ...config, ready: false, issues: ['BASE_CABLE_ENDPOINT_REQUIRED'],
        capture: { ...config.capture, baseIdentity: { state: 'verified', ownerInstanceId: 'PRIVATE_CAPTURE_OWNER' } },
        render: { ...config.render, baseIdentity: { state: 'verified', ownerInstanceId: 'PRIVATE_RENDER_OWNER' } } },
      message: 'PRIVATE_NATIVE_ERROR', token: 'PRIVATE_TOKEN' }); return true;
  } });
  const error = await f.host.open({ session, ...selection }).catch((value: any) => value);
  expect(error).toMatchObject({ code: 'BASE_CABLE_ENDPOINT_REQUIRED', message: 'BASE_CABLE_ENDPOINT_REQUIRED' });
  expect(publicError(error)).toMatchObject({ code: 'setup-required', message: 'Spotify: cable-configuration-required' });
  expect(journal.find(value => value.type === 'spotify.capture-helper' && value.fields.operation === 'capture-open'))
    .toEqual({ type: 'spotify.capture-helper', fields: { phase: 'result', operation: 'capture-open', ok: false,
      processPlatform: 'win32', processArchitecture: process.arch, errorCode: 'BASE_CABLE_ENDPOINT_REQUIRED',
      configurationIssueCodes: 'BASE_CABLE_ENDPOINT_REQUIRED' } });
  expect(JSON.stringify(journal)).not.toMatch(/PRIVATE_|ownerInstanceId|"configuration"|token/);
  expect(f.connectImpl).not.toHaveBeenCalled();
  expect(f.calls.map(value => value.action)).toEqual(['hello', 'capture-open']);
});

it.each([0, -1, 15001, 1.5, NaN, Infinity])('rejects an unbounded exit deadline: %s', exitTimeoutMs => {
  expect(() => createCableCaptureHost({ helperPath: 'C:\\Folia\\folia-capture.exe', platform: 'win32', exitTimeoutMs }))
    .toThrow('CAPTURE_PROTOCOL_INVALID');
});
it('closes an unused host idempotently without creating any process', async () => {
  const f = fixture(); const first = f.host.close(), duplicate = f.host.close();
  expect(duplicate).toBe(first); await first; expect(f.spawnImpl).not.toHaveBeenCalled();
  await expect(f.host.devices()).rejects.toThrow('CAPTURE_HELPER_CLOSED');
});
it.each(['false', 'true-with-killed', 'throws'])('retains cleanup uncertainty after kill %s and a timed out probe', async mode => {
  const f = fixture({ requestTimeoutMs: 10, exitTimeoutMs: 20, expectedCloseCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED',
    handle: (request: any) => request.action === 'format-probe',
    kill(child: any) {
      if (mode === 'throws') throw new Error('PRIVATE_PATH_TOKEN');
      if (mode === 'true-with-killed') child.killed = true;
      return mode !== 'false';
    } });
  await expect(f.host.formatProbe({ ...selection, temporaryFormatLease: true })).rejects.toThrow('CAPTURE_CONTROL_TIMEOUT');
  const blocked = f.host.devices(); const closed = f.host.close();
  expect(f.host.close()).toBe(closed);
  await expect(blocked).rejects.toMatchObject({ code: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  await expect(closed).rejects.toMatchObject({ message: 'CAPTURE_HELPER_EXIT_UNCONFIRMED', code: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  await expect(f.host.close()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
  expect(f.spawnImpl).toHaveBeenCalledOnce(); expect(f.child.kill).toHaveBeenCalledOnce();
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ phase: 'failed', operation: 'close', errorCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  expect(JSON.stringify(f.controlDiagnostics)).not.toMatch(/PRIVATE|private-id|C:\\\\Folia|killed/);
  expect(f.diagnostics.some(value => value.formatLeaseReleased)).toBe(false);
  // A late actual exit cannot rewrite a result already returned to a close caller.
  f.child.emit('exit', 0); await expect(f.host.close()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
});
it('does not equate a voluntary capture-stop acknowledgement with child exit', async () => {
  const f = fixture({ exitTimeoutMs: 20, kill: () => true, expectedCloseCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  const source = await f.host.open({ session, ...selection }); await source.start(); await source.stop();
  expect(f.calls.at(-1).action).toBe('capture-stop');
  await expect(f.host.close()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
  expect(f.child.kill).toHaveBeenCalledOnce();
});
it('waits for delayed observed exit on duplicate close and revokes PCM immediately', async () => {
  const f = fixture({ kill: () => true, exitTimeoutMs: 1000 });
  const source = await f.host.open({ session, ...selection, temporaryFormatLease: true }); await source.start();
  const next = source.stream[Symbol.asyncIterator]().next(); const closed = f.host.close(), done = vi.fn();
  closed.then(done); expect(f.host.close()).toBe(closed);
  await expect(next).rejects.toThrow('CANCELLED'); await tick(); expect(done).not.toHaveBeenCalled();
  expect(f.diagnostics.some(value => value.formatLeaseReleased)).toBe(false);
  f.child.emit('exit', 0); await closed; expect(done).toHaveBeenCalledOnce();
  expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.controlDiagnostics.some(value => value.phase === 'failed')).toBe(false);
});
it.each(['socket-destroy', 'signal-detach'])('still requires own-child exit when %s throws during close', async mode => {
  const f = fixture({ kill: () => true, exitTimeoutMs: 1000, expectedCloseCode: 'CAPTURE_REQUEST_FAILED' });
  const abort = new AbortController(), source = await f.host.open({ session, ...selection, signal: abort.signal });
  const fail = () => { throw new Error('PRIVATE_LOCAL_DISPOSAL'); };
  const disposer = mode === 'socket-destroy' ? f.sockets[0].destroy : vi.spyOn(abort.signal, 'removeEventListener');
  disposer.mockImplementation(fail);
  const next = source.stream[Symbol.asyncIterator]().next();
  const closed = f.host.close(), done = vi.fn(); closed.then(done, done);
  expect(f.host.close()).toBe(closed); expect(f.child.kill).toHaveBeenCalledOnce();
  await expect(next).rejects.toThrow('CANCELLED'); await tick(); expect(done).not.toHaveBeenCalled();
  f.child.emit('exit', 0);
  await expect(closed).rejects.toMatchObject({ code: 'CAPTURE_REQUEST_FAILED', message: 'CAPTURE_REQUEST_FAILED' });
  await expect(f.host.close()).rejects.toThrow('CAPTURE_REQUEST_FAILED');
  expect(disposer).toHaveBeenCalledOnce(); expect(f.child.kill).toHaveBeenCalledOnce();
  expect(f.calls.some(value => value.action === 'capture-stop')).toBe(false);
  expect(JSON.stringify(f.controlDiagnostics)).not.toContain('PRIVATE_LOCAL_DISPOSAL');
});
it.each(['socket-destroy', 'signal-detach'])('prioritizes bounded exit uncertainty over a throwing %s on close', async mode => {
  const f = fixture({ kill: () => false, exitTimeoutMs: 20, expectedCloseCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED',
    handle: (request: any) => request.action === 'devices' });
  const abort = new AbortController(), source = await f.host.open({ session, ...selection, signal: abort.signal });
  const fail = () => { throw new Error('PRIVATE_LOCAL_DISPOSAL'); };
  const disposer = mode === 'socket-destroy' ? f.sockets[0].destroy : vi.spyOn(abort.signal, 'removeEventListener');
  disposer.mockImplementation(fail);
  const pending = f.host.devices(); await tick();
  const next = source.stream[Symbol.asyncIterator]().next(), closed = f.host.close();
  expect(f.host.close()).toBe(closed); expect(f.child.kill).toHaveBeenCalledOnce();
  await expect(next).rejects.toThrow('CANCELLED');
  await expect(pending).rejects.toThrow('CAPTURE_HELPER_CLOSED');
  await expect(closed).rejects.toMatchObject({ code: 'CAPTURE_HELPER_EXIT_UNCONFIRMED', message: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  await expect(f.host.close()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
  expect(f.controlDiagnostics.at(-1)).toMatchObject({ operation: 'close', errorCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  expect(JSON.stringify(f.controlDiagnostics)).not.toContain('PRIVATE_LOCAL_DISPOSAL');
  expect(f.spawnImpl).toHaveBeenCalledOnce(); expect(disposer).toHaveBeenCalledOnce();
  f.child.emit('exit', 0); await expect(f.host.close()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
});
it('blocks all new generations until delayed own-child exit, then ignores old events', async () => {
  const f = fixture({ kill: () => false, exitTimeoutMs: 1000 }), replacement = fixture();
  f.spawnImpl.mockImplementationOnce(() => f.child).mockImplementationOnce(() => replacement.child);
  const first = await f.host.open({ session, ...selection }); await first.start();
  f.child.stdout.emit('error', new Error('PRIVATE')); await tick();
  const obsolete = f.host.open({ session, ...selection }).catch((error: any) => error);
  const current = f.host.open({ session, ...selection }); await tick();
  expect(f.spawnImpl).toHaveBeenCalledOnce(); expect(replacement.child.kill).not.toHaveBeenCalled();
  f.child.emit('exit', 1);
  expect((await obsolete).code).toBe('CANCELLED'); const source = await current; await source.start();
  expect(source.generation).toBe(3); expect(f.spawnImpl).toHaveBeenCalledTimes(2);
  f.child.emit('exit', 1); f.child.emit('error', new Error('PRIVATE')); f.child.stdout.emit('end'); await first.stop();
  expect(replacement.child.kill).not.toHaveBeenCalled();
  const next = source.stream[Symbol.asyncIterator]().next(); f.sockets[1].emit('data', Buffer.alloc(8, 3));
  expect((await next).value).toEqual(Buffer.alloc(8, 3));
});
it('retains a timed-out child until a late observed exit permits a fresh helper', async () => {
  const f = fixture({ requestTimeoutMs: 10, exitTimeoutMs: 20, kill: () => false,
    handle: (request: any) => request.action === 'devices' }), replacement = fixture();
  f.spawnImpl.mockImplementationOnce(() => f.child).mockImplementationOnce(() => replacement.child);
  await expect(f.host.devices()).rejects.toThrow('CAPTURE_CONTROL_TIMEOUT');
  await expect(f.host.devices()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
  await expect(f.host.formatProbe({ ...selection, temporaryFormatLease: true })).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
  expect(f.spawnImpl).toHaveBeenCalledOnce(); f.child.emit('exit', 0);
  expect(await f.host.devices()).toEqual({ endpoints: [] }); expect(f.spawnImpl).toHaveBeenCalledTimes(2);
});
it('observes synchronous exit before kill returns and never kills an already exited helper', async () => {
  const f = fixture({ kill(child: any) { expect(child.listenerCount('exit')).toBeGreaterThan(0); child.emit('exit', 0); return false; } });
  await f.host.devices(); await f.host.close(); expect(f.child.kill).toHaveBeenCalledOnce();
  const exited = fixture(); await exited.host.devices(); exited.child.emit('exit', 0);
  await exited.host.close(); expect(exited.child.kill).not.toHaveBeenCalled();
});
it('does not infer exit from stdout end, child close, or an error event', async () => {
  const f = fixture({ exitTimeoutMs: 20, kill: () => true, expectedCloseCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  await f.host.devices(); f.child.stdout.emit('end'); f.child.emit('close', 0); f.child.emit('error', new Error('PRIVATE'));
  await expect(f.host.close()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED'); expect(f.spawnImpl).toHaveBeenCalledOnce();
});
it('keeps cleanup failure exact even when diagnostic callbacks throw', async () => {
  const f = fixture({ exitTimeoutMs: 20, kill: () => { throw new Error('PRIVATE'); }, expectedCloseCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED',
    onControlDiagnostic() { throw new Error('PRIVATE_DIAGNOSTIC'); } });
  await f.host.devices(); await expect(f.host.close()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
  expect(f.controlDiagnostics.at(-1).errorCode).toBe('CAPTURE_HELPER_EXIT_UNCONFIRMED');
});

it('preserves a synchronous hello write failure when its child exits during termination', async () => {
  const f = fixture(); f.child.stdin.write = () => { throw new Error('PRIVATE_WRITE'); };
  await expect(f.host.devices()).rejects.toMatchObject({ code: 'CAPTURE_HELPER_UNAVAILABLE', message: 'CAPTURE_HELPER_UNAVAILABLE' });
  expect(f.child.kill).toHaveBeenCalledOnce(); await f.host.close();
});
it('does not spawn a waiting replacement if close begins before the owned child exits', async () => {
  const f = fixture({ kill: () => false, exitTimeoutMs: 1000 }); await f.host.devices();
  f.child.stdout.emit('end'); const request = f.host.devices().catch((error: any) => error), closed = f.host.close();
  f.child.emit('exit', 0); await closed;
  expect((await request).code).toBe('CAPTURE_HELPER_CLOSED'); expect(f.spawnImpl).toHaveBeenCalledOnce();
});


it('cancels publication immediately but keeps the reader until native stop acknowledges cleanup', async () => {
  let stopRequest: any, acknowledge: Function | undefined, nativeStopped = false;
  const f = fixture({ handle(request: any, reply: Function) {
    if (request.action !== 'capture-stop') return false;
    stopRequest = request; acknowledge = reply; return true;
  } });
  const onFailure = vi.fn(), source = await f.host.open({ session, ...selection, onFailure }); await source.start();
  const socket = f.sockets[0];
  socket.destroy.mockImplementation(() => {
    if (!nativeStopped) f.child.stdout.write(JSON.stringify({ event: 'capture-error', session,
      generation: source.generation, errorCode: 'CAPTURE_PIPE_FAILED' }) + '\n');
    socket.emit('close');
  });
  const reader = source.stream[Symbol.asyncIterator](), read = reader.next(), stopped = source.stop();
  const verified = source.stopVerified(), completed = vi.fn(); verified.then(completed, () => {});
  expect(source.stop()).toBe(stopped);
  await expect(read).rejects.toThrow('CANCELLED'); await tick();
  expect(socket.destroy).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
  const admittedFrames = source.receivedFrames(); socket.emit('data', Buffer.alloc(QUEUE_BYTES + 8, 4));
  expect(source.receivedFrames()).toBe(admittedFrames);
  await expect(reader.next()).rejects.toThrow('CANCELLED');
  nativeStopped = true; acknowledge!(stopRequest, { session, generation: source.generation, state: 'closed' });
  await stopped; await verified;
  expect(socket.destroy).toHaveBeenCalledOnce(); expect(completed).toHaveBeenCalledOnce();
  expect(onFailure).not.toHaveBeenCalled(); expect(f.diagnostics.some(value => value.phase === 'native-failed')).toBe(false);
});

it('drains a paused reader while native stop waits behind an outstanding control request', async () => {
  let heldRequest: any, acknowledge: Function | undefined;
  const f = fixture({ handle(request: any, reply: Function) {
    if (request.action !== 'devices') return false;
    heldRequest = request; acknowledge = reply; return true;
  } });
  const source = await f.host.open({ session, ...selection }); await source.start(); const socket = f.sockets[0];
  socket.pause = vi.fn(); socket.resume = vi.fn(() => socket.emit('data', Buffer.alloc(32768, 5)));
  socket.emit('data', Buffer.alloc(QUEUE_BYTES - 32768, 3)); expect(socket.pause).toHaveBeenCalledOnce();
  const devices = f.host.devices(); void devices.catch(() => {}); await tick();
  const frames = source.receivedFrames(), stopping = source.stop();
  expect(socket.resume).toHaveBeenCalledOnce(); expect(source.receivedFrames()).toBe(frames);
  expect(socket.destroy).not.toHaveBeenCalled(); expect(f.calls.some(value => value.action === 'capture-stop')).toBe(false);
  await expect(source.stream[Symbol.asyncIterator]().next()).rejects.toThrow('CANCELLED');
  acknowledge!(heldRequest, { endpoints: [] }); await devices; await stopping;
  expect(f.calls.at(-1).action).toBe('capture-stop'); expect(socket.destroy).toHaveBeenCalledOnce();
  await source.stopVerified();
});

it.each(['rejected', 'timeout', 'channel-break'])('releases a deferred reader after native stop %s and accepts only ACK or exact child exit', async mode => {
  const f = fixture({ requestTimeoutMs: 25, handle(request: any, _reply: Function, child: any) {
    if (request.action !== 'capture-stop') return false;
    if (mode === 'rejected') child.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: 'ENDPOINT_UNAVAILABLE' }) + '\n');
    if (mode === 'channel-break') child.stdout.emit('error', new Error('private control failure'));
    return true;
  } });
  const source = await f.host.open({ session, ...selection }); await source.start();
  const stopping = source.stop(); expect(f.sockets[0].destroy).not.toHaveBeenCalled();
  await stopping; expect(f.sockets[0].destroy).toHaveBeenCalledOnce();
  if (mode === 'rejected') await expect(source.stopVerified()).rejects.toThrow('CAPTURE_STOP_TIMEOUT');
  else await expect(source.stopVerified()).resolves.toBeUndefined();
  expect(f.diagnostics.some(value => value.formatLeaseReleased)).toBe(false);
  if (mode !== 'rejected') expect(f.child.kill).toHaveBeenCalledOnce();
});

it('accepts unexpected exact child exit as stopped without waiting for a dead control channel', async () => {
  const f = fixture();
  const source = await f.host.open({ session, ...selection }); await source.start();
  f.child.emit('exit', 1);
  await expect(source.stopVerified()).resolves.toBeUndefined();
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.diagnostics.some(value => value.formatLeaseReleased)).toBe(false);
});

it('does not accept a broken channel or dispatched kill as capture stop proof', async () => {
  const f = fixture({ exitTimeoutMs: 20, kill: () => true, expectedCloseCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  const source = await f.host.open({ session, ...selection }); await source.start();
  f.child.stdout.emit('error', new Error('control channel failed'));
  await expect(source.stopVerified()).rejects.toThrow('CAPTURE_HELPER_EXIT_UNCONFIRMED');
});

it.each(['CAPTURE_PIPE_FAILED', 'FORMAT_LEASE_READBACK_MISMATCH'])('preserves a native %s before stop intent and isolates its late event from the next generation', async errorCode => {
  const f = fixture(), onFailure = vi.fn(), source = await f.host.open({ session, ...selection, onFailure }); await source.start();
  const read = source.stream[Symbol.asyncIterator]().next();
  const event = JSON.stringify({ event: 'capture-error', session, generation: source.generation, errorCode }) + '\n';
  f.child.stdout.write(event); await expect(read).rejects.toThrow(errorCode); await source.stop();
  expect(onFailure).toHaveBeenCalledOnce(); expect(onFailure.mock.calls[0][0].code).toBe(errorCode);
  expect(f.diagnostics.some(value => value.phase === 'native-failed' && value.errorCode === errorCode)).toBe(true);
  const nextFailure = vi.fn(), next = await f.host.open({ session, ...selection, onFailure: nextFailure }); await next.start();
  f.child.stdout.write(event);
  const frame = next.stream[Symbol.asyncIterator]().next(); f.sockets[1].emit('data', Buffer.alloc(8, 6));
  expect((await frame).value).toEqual(Buffer.alloc(8, 6)); expect(nextFailure).not.toHaveBeenCalled();
  expect(f.sockets[1].destroy).not.toHaveBeenCalled();
});

const seekTransaction = '12345678-4321-4321-4321-cba987654321';
function parkReceipt(request: any) {
  return { state: 'seek-parked', session: request.session, generation: request.generation,
    seekToken: '87654321-4321-4321-4321-cba987654321', seekTransaction: request.seekTransaction, expiresInMs: 5000,
    captureStopped: true, captureReset: true, oldGenerationRetired: true, retainedInitialized: true, formatLeaseReleased: false,
    resetBoundary: { previousSession: request.session, previousGeneration: request.generation, resetSequence: 1, stoppedAndResetAtUnixMs: Date.now() } };
}
async function playingCapture(f: any) {
  const source = await f.host.open({ session, ...bootstrap }); await source.start(); await source.promote(); source.beginPublication(); return source;
}
it('reuses only explicit playing-seek retirement and ignores late old stop after adoption', async () => {
  const f = fixture({ bootstrapCapability: true, seekCapability: true }); const first = await playingCapture(f);
  const retired = first.beginSeekRetirement(seekTransaction); expect(retired).toBeTruthy();
  await retired.park(); expect(f.calls.filter((call: any) => call.action === 'capture-stop')).toHaveLength(0);
  const second = await f.host.open({ session, ...bootstrap, seekReuse: retired }); await second.start();
  await first.stop(); expect(f.calls.filter((call: any) => call.action === 'capture-stop')).toHaveLength(0);
  expect(f.calls.filter((call: any) => call.action === 'capture-open')[1]).toMatchObject({ generation: 2, seekTransaction });
  await second.stopVerified(); expect(f.calls.filter((call: any) => call.action === 'capture-stop').map((call: any) => call.generation)).toEqual([2]);
});
it('cold-start optimization preserves the ordinary position epoch after playing-seek device reuse', async () => {
  const f = fixture({ bootstrapCapability: true, seekCapability: true, fastInitialEpoch: true });
  const first = await playingCapture(f);
  const retired = first.beginSeekRetirement(seekTransaction); await retired.park();
  const second = await f.host.open({ session, ...bootstrap, seekReuse: retired });
  await second.start({ positionIntentId: seekTransaction });
  const cut = await second.beginPositionEpoch({ positionIntentId: seekTransaction });
  expect(cut).toMatchObject({ generation: 2, positionIntentId: seekTransaction, freshBuffer: true });
  expect(f.calls.some((call: any) => call.action === 'capture-start-position-epoch')).toBe(false);
  await second.promote(); second.beginPublication();
  const read = second.stream[Symbol.asyncIterator]().next();
  f.sockets[1].emit('data', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  expect((await read).value).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  await second.stopVerified();
});
it('Pause during pending park awaits full stop and rejects the late park ACK', async () => {
  let park: any, send: Function | undefined;
  const f = fixture({ bootstrapCapability: true, seekCapability: true, handle(request: any, reply: Function) {
    if (request.action === 'capture-seek-park') { park = request; send = reply; return true; } return false;
  } });
  const first = await playingCapture(f), retired = first.beginSeekRetirement(seekTransaction);
  const parking = retired.park(); const rejected = expect(parking).rejects.toHaveProperty('code', 'CANCELLED'); await tick();
  const stopping = first.stopVerified(); send!(park, parkReceipt(park)); await rejected; await stopping;
  expect(f.calls.filter((call: any) => call.action === 'capture-stop').map((call: any) => call.generation)).toEqual([1]);
  await expect(f.host.open({ session, ...bootstrap, seekReuse: retired })).rejects.toHaveProperty('code', 'CANCELLED');
});
it('Pause after park performs full release immediately without expiry', async () => {
  const f = fixture({ bootstrapCapability: true, seekCapability: true }); const first = await playingCapture(f);
  const retired = first.beginSeekRetirement(seekTransaction); await retired.park(); await first.stopVerified();
  expect(f.calls.at(-1)).toMatchObject({ action: 'capture-stop', generation: 1 });
});
it('position cut starts a counter epoch without rewriting the pre-cut snapshot', async () => {
  const f = fixture({ bootstrapCapability: true, seekCapability: true, prefixFrames: 4410 });
  expect(await f.host.supportsPositionEpoch()).toBe(true);
  const source = await f.host.open({ session, ...bootstrap }); await source.start(); const before = source.snapshot();
  expect(before.capturedFrames).toBe(4410);
  const cut = await source.beginPositionEpoch({ positionIntentId: seekTransaction }); expect(cut.capturedFramesAtCut).toBe(0);
  expect(source.snapshot()).toBe(before); expect(before.capturedFrames).toBe(4410);
  expect(await source.promote()).toMatchObject({ capturedFrames: 0, positionEpoch: { positionIntentId: seekTransaction, cutSequence: 1 } });
  await expect(source.beginPositionEpoch({ positionIntentId: seekTransaction })).rejects.toHaveProperty('code', 'CAPTURE_PROTOCOL_INVALID');
});
it('retains concealed silence separately from received PCM in native terminal evidence', async () => {
  const f = fixture({ bootstrapCapability: true });
  const source = await playingCapture(f);
  f.child.stdout.write(JSON.stringify({ event: 'capture-error', session, generation: source.generation,
    errorCode: 'CAPTURE_DISCONTINUITY', terminalEvidence: { session, generation: source.generation,
      snapshotSource: 'native-terminal', state: 'failed', errorCode: 'CAPTURE_DISCONTINUITY', cleanupConfirmed: true,
      capturedFrames: 1000, deliveredFrames: 1441, queuedBytes: 0, concealedFrames: 441,
      discontinuities: 2, lastGapFrames: 441 } }) + '\n');
  await tick();
  expect(f.diagnostics.find((x: any) => x.phase === 'native-terminal')).toMatchObject({
    capturedFrames: 1000, deliveredFrames: 1441, concealedFrames: 441, discontinuities: 2, lastGapFrames: 441,
  });
});
it('old helpers do not advertise cuts or seek retention', async () => {
  const f = fixture({ bootstrapCapability: true }); expect(await f.host.supportsPositionEpoch()).toBe(false);
  const source = await playingCapture(f); expect(source.supportsSeekPark).toBe(false);
  expect(source.beginSeekRetirement(seekTransaction)).toBeNull();
});
it('refines pipe closure only from the exact failed position-cut command before helper shutdown', async () => {
  let cut: any;
  const f = fixture({ bootstrapCapability: true, seekCapability: true, handle(request: any) {
    if (request.action === 'capture-begin-position-epoch') { cut = request; return true; } return false;
  } });
  const source = await f.host.open({ session, ...bootstrap }); await source.start();
  const cutting = source.beginPositionEpoch({ positionIntentId: seekTransaction });
  const failed = expect(cutting).rejects.toHaveProperty('code', 'HELPER_RESTART_REQUIRED'); await tick();
  f.sockets[0].emit('close');
  const resolved = source.resolveFailure({ code: 'CAPTURE_PIPE_CLOSED' });
  f.child.stdout.write(JSON.stringify({ id: cut.id, ok: false, errorCode: 'HELPER_RESTART_REQUIRED' }) + '\n');
  await failed; expect(await resolved).toMatchObject({ code: 'HELPER_RESTART_REQUIRED' });
  const cancelled = new AbortController(); cancelled.abort();
  expect(await source.resolveFailure({ code: 'CAPTURE_PIPE_CLOSED' }, cancelled.signal)).toMatchObject({ code: 'CANCELLED' });
});
it('a non-cut command rejection cannot manufacture the position-cut native failure receipt', async () => {
  let promote: any;
  const f = fixture({ bootstrapCapability: true, seekCapability: true, handle(request: any) {
    if (request.action === 'capture-promote') { promote = request; return true; } return false;
  } });
  const source = await f.host.open({ session, ...bootstrap }); await source.start();
  const promoting = source.promote(); const failed = expect(promoting).rejects.toHaveProperty('code', 'HELPER_RESTART_REQUIRED'); await tick();
  f.child.stdout.write(JSON.stringify({ id: promote.id, ok: false, errorCode: 'HELPER_RESTART_REQUIRED' }) + '\n');
  await failed; expect(await source.resolveFailure({ code: 'CAPTURE_PIPE_CLOSED' })).toMatchObject({ code: 'CAPTURE_PIPE_CLOSED' });
});
it('keeps an earlier exact native terminal cause when a failed cut later requires helper restart', async () => {
  let cut: any;
  const f = fixture({ bootstrapCapability: true, seekCapability: true, handle(request: any) {
    if (request.action === 'capture-begin-position-epoch') { cut = request; return true; } return false;
  } });
  const source = await f.host.open({ session, ...bootstrap }); await source.start();
  const cutting = source.beginPositionEpoch({ positionIntentId: seekTransaction });
  const failed = expect(cutting).rejects.toHaveProperty('code', 'HELPER_RESTART_REQUIRED'); await tick();
  f.child.stdout.write(JSON.stringify({ event: 'capture-error', session, generation: source.generation,
    errorCode: 'FORMAT_LEASE_READBACK_MISMATCH', terminalEvidence: { session, generation: source.generation,
      snapshotSource: 'native-terminal', state: 'failed', errorCode: 'FORMAT_LEASE_READBACK_MISMATCH', cleanupConfirmed: true,
      capturedFrames: 0, deliveredFrames: 0, queuedBytes: 0 } }) + '\n');
  f.child.stdout.write(JSON.stringify({ id: cut.id, ok: false, errorCode: 'HELPER_RESTART_REQUIRED' }) + '\n');
  await failed; expect(await source.resolveFailure({ code: 'CAPTURE_PIPE_CLOSED' })).toMatchObject({ code: 'FORMAT_LEASE_READBACK_MISMATCH' });
});
