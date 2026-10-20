import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/cableAudioPreparationControl.integration.test.ts: real control/API/preparation; only external boundaries are simulated.
const externalFetch = vi.fn(async () => { throw new Error('External network is disabled in cable control tests'); });
vi.stubGlobal('fetch', externalFetch);
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
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); expect(externalFetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

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
    if (operation === 'metadata') return Response.json({ id: trackId, type: 'track', uri: `spotify:track:${trackId}`, duration_ms: 120000, is_local: false, is_playable: true, name: 'Fixture track', album: { id: '6n6Rram7vgaVa1iaRUc9Lp', name: 'Fixture album' }, artists: [{ id: '7n7Rram7vgaVa1iaRUc9Lp', name: 'Fixture artist' }] });
    if (operation === 'devices') return Response.json({ devices: [targetDevice] });
    if (operation === 'state') { events.push(`observed:${state.is_playing ? 'playing' : 'paused'}`); return Response.json(state); }
    if (operation !== 'transfer') expect(url.searchParams.get('device_id')).toBe(selection.deviceId);
    lastMutation = operation;
    if (operation === 'select') {
      const body = JSON.parse(init.body); targetDevice.is_active = true; state.device = targetDevice; state.item.uri = body.uris[0]; state.progress_ms = body.position_ms; state.is_playing = true;
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

it.each([204, 200])('parks via real PUT pause %s and a fresh GET before publishing or opening capture', async pauseStatus => {
  const f = fixture({ pauseStatus }), prepared = await f.prepare();
  expect(f.captureHost.formatProbe).toHaveBeenCalledOnce();
  expect(f.pauseReads()).toBeGreaterThan(0);
  if (pauseStatus === 200) expect(f.diagnostics).toContainEqual({ type: 'spotify.playback-control', fields: expect.objectContaining({
    endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'unconfirmed', bodyShape: 'empty', bodyBytes: 0 }) });
  expect(f.events).toEqual(['request:metadata', 'route:inspect', 'route:probe', 'request:devices', 'request:state', 'observed:paused',
    'request:select', 'request:state', 'observed:playing', 'request:state', 'observed:playing', 'request:pause',
    'request:state', 'observed:paused', 'media:publish']);
  expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(prepared).toMatchObject({ playbackTransport: 'cable-pcm', pcmOriginMs: 0, actualQuality: null });
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  expect(f.captureHost.open).not.toHaveBeenCalled();
  const reader = opened.stream[Symbol.asyncIterator](), block = reader.next(); await tick();
  expect(f.events.slice(-8)).toEqual(['observed:paused', 'capture:open', 'capture:start', 'request:state', 'observed:paused',
    'request:play', 'request:state', 'observed:playing']);
  f.captures[0].queue.push(Buffer.alloc(8, 1)); expect((await block).value).toEqual(Buffer.alloc(8, 1));
  await source.pause(); await reader.return();
  expect(f.captureDiagnostics).toEqual([expect.objectContaining({phase:'capture-boundary',trackId})]);
  expect(JSON.stringify(prepared)).not.toMatch(/synthetic-private-token|synthetic-desktop|Synthetic/);
});

it('keeps publication and capture blocked while the real paused-state confirmation is pending', async () => {
  const f = fixture(), paused = deferred<Response>(); let pauseSeen = false;
  f.intercept((operation: string) => {
    if (operation === 'pause') pauseSeen = true;
    if (operation === 'state' && pauseSeen) return paused.promise;
  });
  const preparing = f.prepare(); void preparing.catch(() => {}); await tick();
  expect(f.pauseReads()).toBe(1); expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  f.intercept(undefined); paused.resolve(Response.json(f.state)); const prepared = await preparing;
  expect(prepared.playbackTransport).toBe('cable-pcm'); expect(f.captureHost.open).not.toHaveBeenCalled();
});

it.each([
  ['still playing', (state: any) => { state.is_playing = true; }, 'PLAYBACK_STATE_UNCONFIRMED'],
  ['wrong desktop', (state: any) => { state.device.id = 'another-desktop'; }, 'DEVICE_ID_MISMATCH'],
  ['wrong track', (state: any) => { state.item.uri = `spotify:track:${otherTrackId}`; }, 'TRACK_NOT_CURRENT'],
  ['malformed playing state', (state: any) => { state.is_playing = 'false'; }, 'PROTOCOL_INVALID'],
])('rejects pause 200 followed by %s without publishing a source or claiming capture failed', async (_label, change, code) => {
  const f = fixture(); let pauseSeen = false;
  f.intercept((operation: string, state: any) => {
    if (operation === 'pause') pauseSeen = true;
    if (operation === 'state' && pauseSeen) { change(state); return Response.json(state); }
  });
  await expect(f.prepare()).rejects.toHaveProperty('code', 'unavailable');
  expect(f.pauseReads()).toBeGreaterThan(0); expect(f.onRevoke).toHaveBeenCalledWith(expect.objectContaining({ code }));
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.captureDiagnostics).toEqual([]);
  expect(f.diagnostics).toContainEqual({ type: 'spotify.preparation', fields: expect.objectContaining({ causeCode: code }) });
});

it('rejects a 200 error body even if the subsequent remote facts would be paused', async () => {
  const f = fixture();
  f.intercept((operation: string, state: any) => {
    if (operation !== 'pause') return;
    state.is_playing = false;
    return Response.json({ error: { status: 403, message: 'PRIVATE_RESPONSE_SENTINEL synthetic-private-token' } });
  });
  await expect(f.prepare()).rejects.toHaveProperty('code');
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.captureDiagnostics).toEqual([]);
  expect(f.onRevoke).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROTOCOL_INVALID' }));
  expect(f.diagnostics).toContainEqual({ type: 'spotify.playback-control', fields: expect.objectContaining({
    endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'failed', errorCode: 'PROTOCOL_INVALID', bodyShape: 'error-json' }) });
  expect(JSON.stringify(f.diagnostics)).not.toMatch(/PRIVATE_RESPONSE_SENTINEL|synthetic-private-token/);
});

it('rejects pause 200 followed by a position that an acknowledged seek never corrects', async () => {
  const f = fixture();
  f.intercept((operation: string, state: any) => {
    if (operation === 'pause') state.progress_ms = 25000;
    if (operation === 'seek') return new Response(null, { status: 204 });
  });
  await expect(f.prepare()).rejects.toHaveProperty('code', 'unavailable');
  expect(f.events).toContain('request:seek');
  expect(f.onRevoke).toHaveBeenCalledWith(expect.objectContaining({ code: 'SEEK_UNCONFIRMED' }));
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.captureDiagnostics).toEqual([]);
  expect(f.diagnostics).toContainEqual({ type: 'spotify.preparation', fields: expect.objectContaining({ causeCode: 'SEEK_UNCONFIRMED' }) });
});

it.each(['pause', 'state'])('cancellation during the %s response prevents late 200 from publishing or starting capture', async heldOperation => {
  const f = fixture(), held = deferred<Response>(); let pauseSeen = false;
  f.intercept((operation: string) => {
    if (operation === 'pause') { pauseSeen = true; if (heldOperation === 'pause') return held.promise; }
    if (operation === 'state' && pauseSeen && heldOperation === 'state') return held.promise;
  });
  const preparing = f.prepare().then(() => ({ message: 'unexpected success' }), (error: Error) => error); await tick();
  expect(f.events).toContain('request:pause'); f.audio.cancel(requestId);
  held.resolve(heldOperation === 'pause' ? new Response(null, { status: 200 }) : Response.json(f.state)); expect((await preparing).message).toContain('request-cancelled');
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.captureDiagnostics).toEqual([]);
});

it('does not publish buffered PCM until a real post-play GET confirms the selected song playing', async () => {
  const f = fixture(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  const playing = deferred<Response>(); let playSeen = false;
  f.intercept((operation: string) => {
    if (operation === 'play') playSeen = true;
    if (operation === 'state' && playSeen) return playing.promise;
  });
  const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator](); let delivered = false;
  const first = reader.next().then((value: any) => { delivered = true; return value; }); await tick();
  expect(f.captures[0].start).toHaveBeenCalledOnce();
  f.captures[0].queue.push(Buffer.alloc(8, 7)); await tick(); expect(delivered).toBe(false);
  playing.resolve(Response.json(f.state)); expect((await first).value).toEqual(Buffer.alloc(8, 7));
  f.intercept(undefined); await source.pause(); await reader.return();
});


it('rejects a changed authorization revision while waiting for the fresh paused state', async () => {
  const f = fixture(), held = deferred<Response>(); let pauseSeen = false;
  f.intercept((operation: string) => {
    if (operation === 'pause') pauseSeen = true;
    if (operation === 'state' && pauseSeen) return held.promise;
  });
  const preparing = f.prepare().then(() => null, (error: Error) => error); await tick();
  expect(f.pauseReads()).toBe(1); f.changeGrant(); held.resolve(Response.json(f.state));
  expect((await preparing).message).toBe('Spotify: session-changed');
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.captureDiagnostics).toEqual([]);
});

it('runs targeted select/pause/seek/play 200 through actual gates without a separate Transfer', async () => {
  const f = fixture({ inactiveTarget: true, commandStatus: { transfer: 200, select: 200, pause: 200, seek: 200, play: 200 } });
  f.intercept((operation, state) => { if (operation === 'pause') state.progress_ms = 25000; });
  const prepared = await f.prepare();
  expect(f.captureHost.open).not.toHaveBeenCalled();
  const confirmed = f.diagnostics.filter(row => row.type === 'spotify.playback-control' && row.fields.phase === 'state-confirmed');
  expect(confirmed.map(row => row.fields.endpoint)).toEqual(['playback-select', 'playback-pause', 'playback-seek']);
  expect(confirmed.map(row => row.fields.observationCount)).toEqual([1, 1, 1]);
  expect(f.events).not.toContain('request:transfer');
  expect(confirmed.find(row => row.fields.endpoint === 'playback-select').fields)
    .toMatchObject({ playing: true, stablePosition: false, progressPlausible: true, trackMatched: true });
  f.intercept(undefined); f.wait.mockClear();
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator]();
  const next = reader.next(); await tick(); f.captures[0].queue.push(Buffer.alloc(8, 5));
  expect((await next).value).toEqual(Buffer.alloc(8, 5)); expect(f.wait).not.toHaveBeenCalled();
  expect(f.diagnostics).toContainEqual({ type: 'spotify.playback-control', fields: expect.objectContaining({
    endpoint: 'playback-play', phase: 'state-confirmed', observationCount: 1, playing: true, stablePosition: false, progressPlausible: true }) });
  await source.pause(); await reader.return();
  expect(JSON.stringify(f.diagnostics.filter(row => row.type === 'spotify.playback-control')))
    .not.toMatch(/synthetic-private-token|synthetic-desktop|3n3Ppam|Spotify\.exe/);
});

it.each(['wrong-device', 'wrong-track', 'empty'])('initial empty-player state cannot bypass the targeted select confirmation: %s', async mode => {
  const f = fixture({ inactiveTarget: true, commandStatus: { transfer: 200, select: 200 } }); let selected = false;
  f.intercept((operation, state) => {
    if (operation === 'select') selected = true;
    if (operation === 'state' && !selected) return new Response(null, { status: 204 });
    if (operation === 'state' && selected) {
      if (mode === 'empty') return new Response(null, { status: 204 });
      if (mode === 'wrong-device') return Response.json({ ...state, device: { ...state.device, id: 'other-device' } });
      return Response.json({ ...state, item: { ...state.item, uri: `spotify:track:${otherTrackId}` } });
    }
  });
  await expect(f.prepare()).rejects.toHaveProperty('code', 'unavailable');
  expect(f.events).not.toContain('request:transfer');
  expect(f.events).toContain('request:select');
  expect(f.diagnostics.some(row => row.fields.endpoint === 'playback-select' && row.fields.phase === 'state-confirmed')).toBe(false);
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.captureDiagnostics).toEqual([]);
});

it('keeps the resume 200 GET immediate after a delayed remote start and consumes the existing two-second queue', async () => {
  const f = fixture({ commandStatus: { play: 200 }, settleTimeoutMs: 4000 }), prepared = await f.prepare();
  f.wait.mockClear(); let playing = false, reads = 0;
  f.intercept(operation => {
    if (operation === 'play') {
      playing = true; f.advanceClock(1500);
      f.captures[0].queue.push(Buffer.alloc(44100 * 8 * 1.5, 3));
    }
    if (playing && operation === 'state') reads++;
  });
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator]();
  expect((await reader.next()).value).toEqual(Buffer.alloc(32768, 3));
  expect(reads).toBe(1); expect(f.wait).not.toHaveBeenCalled();
  expect(f.captureDiagnostics).toEqual([expect.objectContaining({phase:'capture-boundary',trackId})]);
  f.intercept(undefined); await source.pause(); await reader.return();
});

it('retains fail-closed two-second PCM overflow while resume 200 state observation is pending', async () => {
  const f = fixture({ commandStatus: { play: 200 } }), prepared = await f.prepare(), held = deferred<Response>(); let playing = false;
  f.intercept(operation => {
    if (operation === 'play') playing = true;
    if (playing && operation === 'state') return held.promise;
  });
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator]();
  const next = reader.next(), rejected = expect(next).rejects.toThrow('cable-capture-overflow'); await tick();
  f.captures[0].queue.push(Buffer.alloc(44100 * 8 * 2 + 8)); held.resolve(Response.json(f.state));
  await rejected;
  expect(f.audio.lookup(prepared.url)).toBeNull(); expect(f.captures[0].stop).toHaveBeenCalled();
  expect(f.captureDiagnostics).toContainEqual(expect.objectContaining({ errorCode: 'CAPTURE_OVERFLOW' }));
});

it.each(['select', 'pause', 'seek'])('never publishes or captures after an unresolved %s 200 state', async target => {
  const f = fixture({ commandStatus: { select: 200, pause: 200, seek: 200 } }); let failing = false;
  f.intercept((operation, state) => {
    if (target === 'seek' && operation === 'pause') state.progress_ms = 25000;
    if (operation === target) { failing = true; return new Response('Opaque'); }
    if (failing && operation === 'state') return Response.json(state);
  });
  await expect(f.prepare()).rejects.toHaveProperty('code', 'unavailable');
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.captureDiagnostics).toEqual([]);
  expect(f.diagnostics.some(row => row.fields.endpoint === `playback-${target}` && row.fields.phase === 'state-confirmed')).toBe(false);
});

it.each([false, true])('rejects state 200 JSON null rather than granting the empty-player exception (inactive target=%s)', async inactiveTarget => {
  const f = fixture({ inactiveTarget, commandStatus: { transfer: 200, select: 200 } });
  f.intercept(operation => operation === 'state' ? new Response('null') : undefined);
  await expect(f.prepare()).rejects.toHaveProperty('code', 'unavailable');
  expect(f.onRevoke).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROTOCOL_INVALID' }));
  expect(f.events).not.toContain('request:select'); expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.diagnostics.some(row => row.fields.phase === 'state-confirmed')).toBe(false);
});
