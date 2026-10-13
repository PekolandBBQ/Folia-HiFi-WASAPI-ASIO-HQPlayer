import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/r37ControlSafety.test.ts: retained safety constraints with current targeted-select and single-fresh-observation contracts; external boundaries are synthetic.
const require = createRequire(import.meta.url);
const { createDesktopPlaybackControl } = require('../../../electron/spotify/desktopPlaybackControl.cjs');
const { createCableAudioPreparation } = require('../../../electron/spotify/cableAudioPreparation.cjs');
const { createCablePcmQueue } = require('../../../electron/spotify/cablePcmQueue.cjs');
const { installPreviewDiagnosticSink } = require('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp', otherTrackId = '4n4Qqam7vgaVa1iaRUc9Lp';
const requestId = '12345678-1234-1234-1234-123456789abc';
const selection = { deviceId: 'synthetic-desktop', captureDeviceId: 'synthetic-capture', renderDeviceId: 'synthetic-render',
  outputDeviceId: 'synthetic-output', temporaryFormatLease: true };
const cleanups: Array<() => Promise<void> | void> = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

function configuration(ready = true) {
  const mixFormat = { sampleRate: 44100, channels: 2 };
  return { ready, issues: ready ? [] : ['RENDER_RATE_MISMATCH'], temporaryFormatLeaseEligible: true,
    selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le', sampleRateConversion: false,
    capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat },
    render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat },
    sessions: [{ processId: 1234, startedAtUnixMs: 1700000000000, state: 'inactive', identityReadable: true,
      processName: 'Spotify', executablePath: 'C:\\Synthetic\\Spotify.exe' }],
    route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } };
}

// Use the production revocation callback so preparation failures cannot hide behind a mocked control.prepare.
function fixture({ pauseStatus = 200, commandStatus = {}, settleTimeoutMs = 400, inactiveTarget = false }:
  { pauseStatus?: number; commandStatus?: Record<string, number>; settleTimeoutMs?: number; inactiveTarget?: boolean } = {}) {
  let clock = 10000, revision = 0, lastMutation = '', stateReadsAfterPause = 0;
  let audio: any;
  const events: string[] = [], diagnostics: any[] = [], captureDiagnostics: any[] = [], captures: any[] = [];
  const uninstall = installPreviewDiagnosticSink({ enabled: () => true,
    record: (type: string, fields: any) => { diagnostics.push({ type, fields }); return true; } });
  const state: any = { device: { id: selection.deviceId, name: 'Synthetic desktop', type: 'Computer', is_active: true, is_restricted: false },
    item: { type: 'track', uri: `spotify:track:${otherTrackId}`, duration_ms: 120000 },
    currently_playing_type: 'track', progress_ms: 0, is_playing: false, actions: { disallows: {} } };
  const targetDevice = state.device;
  if (inactiveTarget) { targetDevice.is_active = false; state.device = { ...targetDevice, id: 'other-device', is_active: true }; }
  const vault = { stamp: () => ({ epoch: 0, revision }), token: async () => 'synthetic-private-token',
    grantedScopes: async () => ({ epoch: 0, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const cooldown = { load: async () => 0, defer: vi.fn(async () => clock + 60000) };
  let intercept: ((operation: string, state: any, init: any) => Promise<Response | void> | Response | void) | undefined;
  const fetcher = vi.fn(async (address: string, init: any) => {
    const url = new URL(address);
    if (url.origin !== 'https://api.spotify.com') throw new Error('Unexpected synthetic request');
    const operation = url.pathname.startsWith('/v1/tracks/') ? 'metadata'
      : init.method === 'GET' ? url.pathname.endsWith('/devices') ? 'devices' : 'state'
      : url.pathname.endsWith('/pause') ? 'pause' : url.pathname.endsWith('/seek') ? 'seek'
      : url.pathname.endsWith('/play') ? init.body ? 'select' : 'play' : 'transfer';
    events.push(`request:${operation}`);
    if (operation === 'state' && lastMutation === 'pause') stateReadsAfterPause++;
    const override = await intercept?.(operation, state, init);
    if (override) return override;
    if (operation === 'metadata') return Response.json({ id: trackId, type: 'track', uri: `spotify:track:${trackId}`, duration_ms: 120000 });
    if (operation === 'devices') return Response.json({ devices: [targetDevice] });
    if (operation === 'state') { events.push(`observed:${state.is_playing ? 'playing' : 'paused'}`); return Response.json(state); }
    if (operation !== 'transfer') expect(url.searchParams.get('device_id')).toBe(selection.deviceId);
    lastMutation = operation;
    if (operation === 'select') {
      targetDevice.is_active = true; state.device = targetDevice;
      const body = JSON.parse(init.body); state.item.uri = body.uris[0]; state.progress_ms = body.position_ms; state.is_playing = true;
    } else if (operation === 'pause') state.is_playing = false;
    else if (operation === 'play') state.is_playing = true;
    else if (operation === 'seek') state.progress_ms = Number(url.searchParams.get('position_ms'));
    else if (operation === 'transfer') { targetDevice.is_active = true; state.device = targetDevice; }
    else throw new Error('Unexpected operation');
    return new Response(null, { status: commandStatus[operation] ?? (operation === 'pause' ? pauseStatus : 204) });
  });
  const onRevoke = vi.fn((value: any) => audio?.revokeSession(value.session, value.code));
  const wait = vi.fn(async (ms: number) => { clock += ms; });
  const control = createDesktopPlaybackControl({ vault, cooldown, fetcher, now: () => clock, wait,
    settleIntervalMs: 100, settleTimeoutMs, onRevoke });
  const captureHost = {
    inspectRoute: vi.fn(async () => { events.push('route:inspect'); return configuration(false); }),
    formatProbe: vi.fn(async () => { events.push('route:probe'); return { state: 'released', verified: true, configuration: configuration() }; }),
    open: vi.fn(async (input: any) => {
      events.push('capture:open');
      const queue = createCablePcmQueue({ onFailure(error: any) { if (error.code !== 'CANCELLED') input.onFailure(error); } });
      const capture = { queue, stream: queue.stream, generation: captures.length + 1, receivedFrames: () => queue.receivedFrames,
        start: vi.fn(async () => { events.push('capture:start'); return { state: 'running' }; }),
        status: vi.fn(async () => ({ state: 'running' })), stop: vi.fn(async () => { queue.cancel(); }) };
      input.signal.addEventListener('abort', () => queue.cancel(), { once: true }); captures.push(capture); return capture;
    }),
  };
  const media = { add: vi.fn(async () => { events.push('media:publish'); return { url: 'http://127.0.0.1:1234/synthetic', revoke: vi.fn(async () => {}) }; }),
    close: vi.fn(async () => {}) };
  audio = createCableAudioPreparation({ captureHost, control, vault, cooldown, fetcher, media, now: () => clock,
    getSelection: async () => ({ ...selection }), onDiagnostic: (value: any) => captureDiagnostics.push(value) });
  cleanups.push(async () => { await audio.close(); await control.dispose(); uninstall(); });
  return { audio, control, captureHost, media, fetcher, events, diagnostics, captureDiagnostics, captures, state, onRevoke, wait,
    intercept: (value: typeof intercept) => { intercept = value; }, changeGrant: () => { revision++; },
    advanceClock: (ms: number) => { clock += ms; }, pauseReads: () => stateReadsAfterPause, prepare: () => audio.prepare(trackId, requestId) };
}


it('confirms pause 200 with a fresh matching GET before source publication and capture', async () => {
  const f = fixture({ pauseStatus: 200 }), prepared = await f.prepare();
  const pause = f.events.indexOf('request:pause'), observed = f.events.indexOf('observed:paused', pause), published = f.events.indexOf('media:publish');
  expect(pause).toBeGreaterThan(-1); expect(observed).toBeGreaterThan(pause); expect(published).toBeGreaterThan(observed);
  expect(f.diagnostics).toContainEqual({ type: 'spotify.playback-control', fields: expect.objectContaining({
    endpoint: 'playback-pause', phase: 'state-confirmed', observationCount: 1, deviceMatched: true, trackMatched: true, paused: true }) });
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(prepared.playbackTransport).toBe('cable-pcm');
});
it('confirms target activation, select, pause, corrective seek and play 200 before any PCM escapes', async () => {
  const f = fixture({ inactiveTarget: true, commandStatus: { select: 200, pause: 200, seek: 200, play: 200 } });
  f.intercept((operation, state) => { if (operation === 'pause') state.progress_ms = 25000; });
  const prepared = await f.prepare(); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.events).not.toContain('request:transfer');
  const confirmed = f.diagnostics.filter(row => row.type === 'spotify.playback-control' && row.fields.phase === 'state-confirmed');
  expect(confirmed.map(row => row.fields.endpoint)).toEqual(['playback-select', 'playback-pause', 'playback-seek']);
  expect(confirmed.every(row => row.fields.deviceMatched && row.fields.trackMatched)).toBe(true);
  f.intercept(undefined);
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator]();
  const next = reader.next(); await tick(); f.captures[0].queue.push(Buffer.alloc(8, 5));
  expect((await next).value).toEqual(Buffer.alloc(8, 5));
  expect(f.diagnostics).toContainEqual({ type: 'spotify.playback-control', fields: expect.objectContaining({
    endpoint: 'playback-play', phase: 'state-confirmed', deviceMatched: true, trackMatched: true, playing: true, progressPlausible: true }) });
  await source.pause(); await reader.return();
});
it.each(['wrong-device', 'wrong-track', 'empty'])('empty baseline does not authorize selected source after %s observation', async mode => {
  const f = fixture({ inactiveTarget: true, commandStatus: { select: 200 } }); let selected = false;
  f.intercept((operation, state) => {
    if (operation === 'select') selected = true;
    if (operation === 'state' && !selected) return new Response(null, { status: 204 });
    if (operation === 'state' && selected) {
      if (mode === 'empty') return new Response(null, { status: 204 });
      if (mode === 'wrong-device') return Response.json({ ...state, device: { ...state.device, id: 'other-device' } });
      return Response.json({ ...state, item: { ...state.item, uri: `spotify:track:${otherTrackId}` } });
    }
  });
  await expect(f.prepare()).rejects.toHaveProperty('code', 'unavailable'); expect(f.events).toContain('request:select');
  expect(f.diagnostics.some(row => row.fields.endpoint === 'playback-select' && row.fields.phase === 'state-confirmed')).toBe(false);
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.captureDiagnostics).toEqual([]);
});
