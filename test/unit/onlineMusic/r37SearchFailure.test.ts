import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSpotifySong, normalizeSpotifyPage } from '../../../src/services/onlineMusic/spotifyNormalize';
import { getNativeErrorCode } from '../../../src/services/nativeAudio/errors';

// test/unit/onlineMusic/r37SearchFailure.test.ts: production catalog, control, capture host and error projection; external/native boundaries are synthetic.
const require = createRequire(import.meta.url);
const { createCableCaptureHost } = require('../../../electron/spotify/cableCaptureHost.cjs');
const { QUEUE_BYTES } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
const session = '12345678-1234-1234-1234-123456789abc';
const selection = { captureDeviceId: 'capture-private-id', renderDeviceId: 'render-private-id', outputDeviceId: 'physical-private-id' };
const format = { sampleRate: 44100, channels: 2, containerBits: 32 };
function configuration() {
  return { ready: true, issues: [], selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le', sampleRateConversion: false,
    capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat: format },
    render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat: format },
    sessions: [{ processId: 1234, startedAtUnixMs: 1700000000000, state: 'inactive', identityReadable: true, processName: 'Spotify', executablePath: 'C:\\Synthetic\\Spotify.exe' }],
    route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options: any = {}) {
  const calls: any[] = [], sockets: any[] = [], diagnostics: any[] = [], controlDiagnostics: any[] = [];
  const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
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
      actualMixFormat: format, queueCapacityBytes: QUEUE_BYTES, configuration: config, pipeConnected: state === 'running', startValidated: state === 'running',
      spotifyProcess: { processId: 1234, startedAtUnixMs: 1700000000000,
        ...(active.bootstrapMode ? { startedAtUtcTicks: active.expectedSpotifyStartTimeUtcTicks } : {}) },
      capturedFrames: options.prefixFrames || 0, deliveredFrames: 0, queuedBytes: 0, initialDiscontinuity: false,
      ...(active.bootstrapMode ? { bootstrapMode: active.bootstrapMode, bootstrapDelivery: active.bootstrapDelivery,
        deliveryState: promoted ? 'live' : active.bootstrapDelivery === 'buffer' ? 'buffering' : 'discarding' } : {}) };
  }
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()); calls.push(request); callback();
    queueMicrotask(() => {
      if (options.handle?.(request, reply, child) === true) return;
      if (request.action === 'hello') reply(request, { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100, channels: 2, bitDepth: 32,
        sampleFormat: 's32le', queueCapacityBytes: QUEUE_BYTES,
        capabilities: ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', 'post-start-route-proof-v1', 'temporary-format-lease-v1',
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

const { createDesktopPlaybackControl } = require('../../../electron/spotify/desktopPlaybackControl.cjs');
const { createCableAudioPreparation } = require('../../../electron/spotify/cableAudioPreparation.cjs');
const { createSpotifyCatalog } = require('../../../electron/spotify/catalog.cjs');
const { createOfficialTrackMetadata } = require('../../../electron/spotify/officialTrackMetadata.cjs');
const { errorCode, sourceLifecycleError } = require('../../../electron/nativeAudio/errors.cjs');
const { officialTrack, TRACK_ID, OTHER_ID } = require('../../fixtures/spotifyOfficialTrack.cjs');
const nativeCode = 'FORMAT_LEASE_READBACK_MISMATCH';
const nativeTerminal = (generation: number, patch = {}) => ({ session, generation, snapshotSource: 'native-terminal',
  state: 'failed', errorCode: nativeCode, cleanupConfirmed: true, capturedFrames: 30870, deliveredFrames: 0, queuedBytes: 0, ...patch });
const emitFailure = (f: any, generation: number, code = nativeCode, eventSession = session) => f.child.stdout.write(JSON.stringify({
  event: 'capture-error', session: eventSession, generation, errorCode: code,
  terminalEvidence: nativeTerminal(generation, { session: eventSession, errorCode: code }) }) + '\n');

it('preserves the exact native failure after PCM EOF has synchronously stopped publication', async () => {
  const f = fixture(), onFailure = vi.fn(), source = await f.host.open({ session, ...selection, onFailure }); await source.start();
  const failed = source.stream[Symbol.asyncIterator]().next().catch((e: any) => e);
  f.sockets[0].emit('end');
  expect(f.sockets[0].destroy).toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledOnce();
  const pipeError = await failed;
  expect(pipeError.code).toBe('CAPTURE_PIPE_CLOSED');
  setTimeout(() => emitFailure(f, source.generation), 17);
  const resolved = source.resolveFailure ? await source.resolveFailure(pipeError) : pipeError;
  expect(resolved.code).toBe(nativeCode);
});

it('recovers terminal failure from the exact stop reply when the native event is unavailable', async () => {
  const f = fixture({ handle(request: any, reply: Function) {
    if (request.action !== 'capture-stop') return false;
    reply(request, { session, generation: request.generation, state: 'closed', terminalEvidence: nativeTerminal(request.generation) }); return true;
  } });
  const source = await f.host.open({ session, ...selection }); await source.start();
  const failed = source.stream[Symbol.asyncIterator]().next().catch((e: any) => e); f.sockets[0].emit('end');
  const pipeError = await failed; await source.stopVerified();
  expect((source.resolveFailure ? await source.resolveFailure(pipeError) : pipeError).code).toBe(nativeCode);
});

// Fully synthetic HTTP bodies are consumed by the unmodified production catalog/control/preparation.
function sourceFixture(raw = officialTrack()) {
  const f = fixture(), requests: string[] = [], selects: string[] = [];
  const vault = { stamp: () => ({ epoch: 0, revision: 0 }), token: async () => 'synthetic-not-a-credential',
    grantedScopes: async () => ({ epoch: 0, revision: 0, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const cooldown = { load: async () => 0, defer: async () => 0 };
  const metadata = createOfficialTrackMetadata({ getStamp: vault.stamp });
  const state: any = { device: { id: 'synthetic-desktop', type: 'Computer', is_active: true, is_restricted: false },
    item: { type: 'track', uri: `spotify:track:${OTHER_ID}`, duration_ms: raw.duration_ms }, progress_ms: 0,
    currently_playing_type: 'track', is_playing: false, actions: { disallows: {} } };
  let playHook: (() => Promise<void> | void) | undefined;
  const fetcher = async (address: string, init: any = {}) => {
    const url = new URL(address); const op = url.pathname.endsWith('/search') ? 'search'
      : url.pathname.includes('/tracks/') ? 'metadata' : url.pathname.endsWith('/devices') ? 'devices'
      : (init.method || 'GET') === 'GET' ? 'state' : url.pathname.endsWith('/pause') ? 'pause'
      : url.pathname.endsWith('/seek') ? 'seek' : init.body ? 'select' : 'play';
    requests.push(op);
    if (op === 'search') return Response.json({ tracks: { items: [raw], total: 1 } });
    if (op === 'metadata') return Response.json(raw);
    if (op === 'devices') return Response.json({ devices: [state.device] });
    if (op === 'state') return Response.json(state);
    if (op === 'select') { const body = JSON.parse(init.body); selects.push(body.uris[0]); state.item.uri = body.uris[0]; state.is_playing = true; state.progress_ms = body.position_ms; }
    if (op === 'pause') state.is_playing = false;
    if (op === 'seek') state.progress_ms = Number(url.searchParams.get('position_ms'));
    if (op === 'play') { state.is_playing = true; await playHook?.(); }
    return new Response(null, { status: 204 });
  };
  const catalog = createSpotifyCatalog({ vault, cooldown, officialMetadata: metadata, fetcher });
  let audio: any;
  const control = createDesktopPlaybackControl({ vault, cooldown, fetcher,
    onRevoke: (value: any) => audio?.revokeSession(value.session, value.code) });
  audio = createCableAudioPreparation({ captureHost: f.host, control, vault, cooldown, fetcher, officialMetadata: metadata,
    getSelection: async () => ({ ...selection, deviceId: state.device.id }),
    media: { add: async () => ({ url: 'http://127.0.0.1/synthetic-owned-pcm', revoke: async () => {} }), close: async () => {} } });
  cleanups.push(async () => { await audio.close(); await control.dispose(); });
  return { ...f, catalog, audio, requests, selects, state, metadata, playHook: (hook: typeof playHook) => { playHook = hook; } };
}

it.each(['porno', 'Different title'])('search and playlist normalization preserve identical identity for synthetic title %s', async title => {
  const raw = { ...officialTrack(), name: title }, f = sourceFixture(raw);
  const page = await f.catalog.request('search', { query: title });
  const searchSong = normalizeSpotifyPage(page, 0, normalizeSpotifySong, true).items[0];
  const playlistSongs = normalizeSpotifyPage({ items: [{ item: raw }, { track: raw }] }, 0, normalizeSpotifySong, true).items;
  expect(playlistSongs).toEqual([searchSong, searchSong]);
  const result = await f.audio.prepare(searchSong.sourceRef!.mediaId, randomUUID());
  expect(result.durationMs).toBe(raw.duration_ms); expect(f.selects).toEqual([raw.uri]);
  expect(f.requests.filter(x => x === 'metadata')).toHaveLength(0);
});

it('a relinked search ID fetches and selects the resolved track without substituting the old ID', async () => {
  const raw = { ...officialTrack(OTHER_ID), linked_from: { id: TRACK_ID, uri: `spotify:track:${TRACK_ID}`, type: 'track' } };
  const f = sourceFixture(raw), page = await f.catalog.request('search', { query: 'synthetic relink' });
  const song = normalizeSpotifyPage(page, 0, normalizeSpotifySong, true).items[0];
  expect(song.sourceRef!.mediaId).toBe(OTHER_ID);
  await f.audio.prepare(song.sourceRef!.mediaId, randomUUID());
  expect(f.selects).toEqual([raw.uri]); expect(f.requests.filter(x => x === 'metadata')).toHaveLength(1);
});

it('carries pipe-first format failure through actual source preparation to the native IPC and renderer error projection', async () => {
  const f = sourceFixture(); await f.catalog.request('search', { query: 'synthetic track' });
  const prepared = await f.audio.prepare(TRACK_ID, randomUUID());
  f.playHook(async () => {
    const request = f.calls.find((x: any) => x.action === 'capture-open');
    f.sockets[0].emit('end');
    setTimeout(() => emitFailure(f, request.generation, nativeCode, request.session), 17);
  });
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const caught = await opened.stream[Symbol.asyncIterator]().next().catch((error: any) => error);
  expect(caught.nativeCode).toBe(nativeCode);
  expect(errorCode(caught)).toBe(nativeCode);
  expect(sourceLifecycleError(caught).code).toBe(nativeCode);
  expect(getNativeErrorCode({ code: errorCode(caught) })).toBe(nativeCode);
  expect(f.diagnostics.some((x: any) => x.phase === 'native-terminal' && x.errorCode === nativeCode)).toBe(true);
});

it('bounds missing terminal evidence to 250ms and never reclassifies an unknown helper code', async () => {
  const f = fixture(), source = await f.host.open({ session, ...selection }); await source.start();
  const failed = source.stream[Symbol.asyncIterator]().next().catch((e: any) => e); f.sockets[0].emit('end');
  const pipeError = await failed, start = performance.now();
  const result = await source.resolveFailure(pipeError);
  expect(result).toBe(pipeError); expect(performance.now() - start).toBeLessThan(600);
  expect(performance.now() - start).toBeGreaterThanOrEqual(200);
  emitFailure(f, source.generation, 'PRIVATE_UNKNOWN_CODE');
  expect(await source.resolveFailure(pipeError)).toBe(pipeError);
});

it('keeps cancellation immediate during native-cause observation and ignores late errors for that caller', async () => {
  const f = fixture(), source = await f.host.open({ session, ...selection }); await source.start();
  const failed = source.stream[Symbol.asyncIterator]().next().catch((e: any) => e); f.sockets[0].emit('end');
  const pipeError = await failed, abort = new AbortController(), start = performance.now();
  const waiting = source.resolveFailure(pipeError, abort.signal); abort.abort();
  expect((await waiting).code).toBe('CANCELLED'); expect(performance.now() - start).toBeLessThan(100);
  emitFailure(f, source.generation);
  const cancelled = Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
  expect(await source.resolveFailure(cancelled)).toBe(cancelled);
});

it('does not apply a foreign session or retired generation terminal to another capture', async () => {
  const f = fixture(), first = await f.host.open({ session, ...selection }); await first.start(); await first.stopVerified();
  const second = await f.host.open({ session, ...selection }); await second.start();
  const failed = second.stream[Symbol.asyncIterator]().next().catch((e: any) => e); f.sockets[1].emit('end');
  const error = await failed;
  emitFailure(f, first.generation); emitFailure(f, second.generation, nativeCode, randomUUID());
  expect(await second.resolveFailure(error)).toBe(error);
});

it('delivers the exact code through production live PCM, stream readiness and the registered native IPC handler', async () => {
  const { registerNativeAudio } = require('../../../electron/nativeAudio/service.cjs');
  const { createLivePcmSession } = require('../../../electron/nativeAudio/livePcmSession.cjs');
  const f = sourceFixture(); await f.catalog.request('search', { query: 'synthetic track' });
  const prepared = await f.audio.prepare(TRACK_ID, randomUUID());
  f.playHook(async () => {
    const request = f.calls.find((x: any) => x.action === 'capture-open'); f.sockets[0].emit('end');
    setTimeout(() => emitFailure(f, request.generation, nativeCode, request.session), 17);
  });
  const sockets: net.Socket[] = [], buffers: Buffer[] = [];
  const server = net.createServer(socket => { sockets.push(socket); socket.on('data', bytes => buffers.push(Buffer.from(bytes))); socket.on('error', () => {}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-r37-ipc-'));
  const app = Object.assign(new EventEmitter(), { isPackaged: false, getAppPath: () => directory, getPath: () => directory });
  const sender = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
  const handlers = new Map<string, Function>();
  const helper = { dispose: vi.fn(), request: vi.fn(async (request: any) => request.action === 'hello'
    ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry', 'streaming-pcm-v1'] }
    : { session: request.session, duration: 180, streaming: true, streamGeneration: 1, position: 0, bufferedStart: 0, bufferedEnd: 0, producerComplete: false }) };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    // Platform admission is a boundary double, never evidence of Windows/device execution.
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    registerNativeAudio({ app, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
      isTrustedSender: (value: unknown) => value === sender,
      componentManager: { status: async () => ({ available: true, executable: 'synthetic-helper.exe' }) }, helperFactory: () => helper,
      decoderResolver: async () => 'unused-decoder', hqplayerFactory: () => ({ dispose: vi.fn() }),
      resolveLivePcmSource: (url: string) => f.audio.lookup(url),
      liveStreamFactory: (options: any) => createLivePcmSession({ ...options,
        connectPipe: () => net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true }) }) });
  } finally { Object.defineProperty(process, 'platform', platform); }
  const ipc = (request: any) => handlers.get('native-audio:request')!({ sender, senderFrame: sender.mainFrame }, request);
  cleanups.push(async () => {
    await ipc({ action: 'stop', session: 'r37-live-output' }); app.emit('before-quit');
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  });
  await ipc({ action: 'begin', session: 'r37-live-output', backend: 'asio', deviceId: 'synthetic-output', url: prepared.url });
  const result = await ipc({ action: 'finish', session: 'r37-live-output' });
  expect(result).toEqual({ nativeAudioError: { code: nativeCode } });
  expect(getNativeErrorCode(result.nativeAudioError)).toBe(nativeCode); expect(buffers).toEqual([]);
});

it('preserves native-first failures without waiting and leaves explicit cancellation unchanged', async () => {
  const f = fixture(), onFailure = vi.fn(), source = await f.host.open({ session, ...selection, onFailure }); await source.start();
  const failed = source.stream[Symbol.asyncIterator]().next().catch((e: any) => e);
  emitFailure(f, source.generation); const cause = await failed;
  expect(cause.code).toBe(nativeCode); expect(await source.resolveFailure(cause)).toBe(cause);
  expect(onFailure).toHaveBeenCalledOnce();
  const cancelled = Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
  expect(await source.resolveFailure(cancelled)).toBe(cancelled);
});

it('starts source pause cleanup before the bounded native-cause wait settles', async () => {
  const f = sourceFixture(), prepared = await f.audio.prepare(TRACK_ID, randomUUID());
  f.playHook(() => { f.sockets[0].emit('end'); });
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const before = f.requests.filter(x => x === 'pause').length;
  let settled = false;
  const result = opened.stream[Symbol.asyncIterator]().next().catch((error: any) => error).finally(() => { settled = true; });
  await tick(); await tick();
  expect(f.requests.filter(x => x === 'pause').length).toBeGreaterThan(before);
  expect(f.sockets[0].destroy).toHaveBeenCalled(); expect(settled).toBe(false);
  const error = await result; expect(error.message).toBe('Spotify: cable-preparation-failed');
});
