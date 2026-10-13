import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/cableAudioPreparation.test.ts: official control, capture, and outputs are isolated mocks.
const require = createRequire(import.meta.url);
const { createCableAudioPreparation } = require('../../../electron/spotify/cableAudioPreparation.cjs');
const { createCablePcmQueue } = require('../../../electron/spotify/cablePcmQueue.cjs');
const { createSoloistBrowserSession } = require('../../../electron/spotify/soloistBrowserSession.cjs');
const { spotifyError } = require('../../../electron/spotify/errors.cjs');
const { diagnosticCode, publicError } = require('../../../electron/spotify/cableAudioFacts.cjs');
const id = '3n3Ppam7vgaVa1iaRUc9Lp', requestId = '12345678-1234-1234-1234-123456789abc';
const nextRequest = '12345678-1234-1234-1234-123456789abd';
const selection = { deviceId: 'explicit-desktop', captureDeviceId: 'explicit-capture', renderDeviceId: 'explicit-render', outputDeviceId: 'physical-output' };
const cleanups: Array<() => Promise<void>> = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
const failed = (code: string) => Object.assign(new Error('private body /token/path'), { code });
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (error: any) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
function configuration() {
  const mixFormat = { sampleRate: 44100, channels: 2 };
  return { ready: true, issues: [], selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le', sampleRateConversion: false,
    capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat },
    render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat },
    sessions: [{ processId: 1234, startedAtUnixMs: 1700000000000, state: 'inactive', identityReadable: true,
      processName: 'Spotify', executablePath: 'C:\\Spotify\\Spotify.exe' }],
    route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } };
}
function fixture(options: any = {}) {
  let revision = 0, retryAt = 0, state: any, activeSession: string;
  const captures: any[] = [], handles: any[] = [], diagnostics: any[] = [];
  const vault = { stamp: () => ({ epoch: 0, revision }), token: vi.fn(async () => 'test-private-bearer'),
    grantedScopes: vi.fn(async () => ({ scopes: options.scopes || ['user-read-playback-state', 'user-modify-playback-state'] })) };
  const cooldown = { load: async () => retryAt, defer: vi.fn(async () => { retryAt = Date.now() + 60000; }) };
  const control = {
    prepare: vi.fn(async (input: any) => {
      activeSession = input.session;
      state = { deviceId: input.deviceId, trackId: input.trackId, durationMs: input.durationMs, positionMs: options.originMs || 0,
        isPlaying: false, observedAt: Date.now(), disallows: { seeking: false, pausing: false, resuming: false } };
      return { ...state };
    }),
    readState: vi.fn(async () => ({ ...state })),
    play: vi.fn(async () => { state.isPlaying = true; return { ...state }; }),
    pause: vi.fn(async (session: string) => {
      if (session !== activeSession) throw failed('STALE_SESSION'); state.isPlaying = false; return { ...state };
    }),
    seek: vi.fn(async (_session: string, positionMs: number) => { state.positionMs = positionMs + (options.seekOffset || 0); return { ...state }; }),
    close: vi.fn(async () => {}),
  };
  const captureHost = {
    inspectRoute: vi.fn(async () => options.configuration || configuration()),
    formatProbe: vi.fn(async () => ({ state: 'released', verified: true, configuration: configuration() })),
    open: vi.fn(async (input: any) => {
      const queue = createCablePcmQueue({ onFailure(error: any) {
        if (error.code === 'CANCELLED') return; input.onFailure(error);
      } });
      const capture = { input, queue, stream: queue.stream, generation: captures.length + 1,
        receivedFrames: () => queue.receivedFrames,
        start: vi.fn(async () => ({ state: 'running' })), status: vi.fn(async () => ({ state: 'running' })),
        stop: vi.fn(async () => { queue.cancel(); }) };
      input.signal.addEventListener('abort', () => { queue.cancel(); }, { once: true });
      captures.push(capture); return capture;
    }), close: vi.fn(async () => {}),
  };
  const media = { add: vi.fn(async (producer: any) => {
    const handle = { url: `http://127.0.0.1:1234/opaque-${handles.length}`, revoke: vi.fn(async () => {}), producer };
    handles.push(handle); return handle;
  }), close: vi.fn(async () => {}) };
  const getSelection = vi.fn(async () => ({ ...selection, ...options.selection }));
  const fetcher = vi.fn(options.fetcher || (async () => Response.json({ id, type: 'track', uri: `spotify:track:${id}`, duration_ms: options.durationMs || 120000 })));
  const audio = createCableAudioPreparation({ captureHost, control, vault, cooldown, getSelection, fetcher, media, routeLifecycle: options.routeLifecycle,
    onDiagnostic: (value: any) => diagnostics.push(value) });
  cleanups.push(() => audio.close());
  return { audio, captureHost, control, vault, cooldown, getSelection, fetcher, media, captures, handles, diagnostics,
    facts: () => ({ ...state }), revokeGrant: () => { revision++; }, changeState: (change: any) => { Object.assign(state, change); } };
}
it('allows idle cleanup before any source or route was acquired', async () => {
  const f = fixture();
  await expect(f.audio.clear()).resolves.toBeUndefined();
  await expect(f.audio.clear()).resolves.toBeUndefined();
  expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.control.prepare).not.toHaveBeenCalled();
});
it('keeps setup failures as setup-required and never invents a capture failure before capture opens', async () => {
  const f = fixture(); f.getSelection.mockRejectedValue(spotifyError('setup-required', 'cable-setup-required'));
  await expect(f.audio.prepare(id, requestId)).rejects.toMatchObject({ code: 'setup-required', message: 'Spotify: cable-setup-required' });
  expect(f.captureHost.inspectRoute).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.control.prepare).not.toHaveBeenCalled(); expect(f.diagnostics).toEqual([]);
  expect(diagnosticCode(spotifyError('setup-required'))).toBe('setup-required');
  expect(publicError(Object.assign(new Error('PRIVATE_PATH'), { code: 'setup-required' })))
    .toMatchObject({ code: 'setup-required', message: 'Spotify: cable-configuration-required' });
});
async function start(f: any) {
  const prepared = await f.audio.prepare(id, requestId);
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const reader = opened.stream[Symbol.asyncIterator](), next = reader.next(); await tick();
  return { prepared, source, opened, reader, next };
}
it('preserves the off-mode r18 live source even when an automatic routing component is available', async () => {
  const routeLifecycle = { availability: vi.fn(), inspect: vi.fn(), acquire: vi.fn() }, f = fixture({ routeLifecycle });
  const active = await start(f); f.captures[0].queue.push(Buffer.alloc(8, 4));
  expect((await active.next).value).toEqual(Buffer.alloc(8, 4));
  expect(routeLifecycle.availability).not.toHaveBeenCalled(); expect(routeLifecycle.inspect).not.toHaveBeenCalled();
  expect(routeLifecycle.acquire).not.toHaveBeenCalled(); expect(f.captures).toHaveLength(1);
  expect(f.control.prepare.mock.calls[0][0].beforeSelect).toBeUndefined(); await active.source.pause();
});
it('publishes only an opaque prepared source with unknown Spotify encoding and actual quality', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId, () => {}, 'lossless');
  expect(prepared).toMatchObject({ playbackTransport: 'cable-pcm', requestedQuality: 'lossless', actualQuality: null, quality: null,
    sessionBoundAudio: true, sourceInfo: { codec: null, sampleRate: null, bitDepth: null, lossless: null, encodingVerified: false },
    preparedAudio: { representation: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 } });
  expect(JSON.stringify(prepared)).not.toMatch(/explicit-|test-private-bearer/);
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.control.play).not.toHaveBeenCalled();
  expect(f.control.prepare).toHaveBeenCalledWith(expect.objectContaining({ deviceId: selection.deviceId, trackId: id, positionMs: 0,
    durationMs: 120000, restoreSavedTarget: true }));
  expect(f.captureHost.inspectRoute.mock.invocationCallOrder[0]).toBeLessThan(f.control.prepare.mock.invocationCallOrder[0]);
});
it('never attempts saved-target restoration when the observed local Spotify route is missing', async () => {
  const f = fixture({ configuration: { ...configuration(), ready: false, sessions: [],
    route: { ready: false, spotifyOnlyObserved: false, spotifySessionPresent: false } } });
  await expect(f.audio.prepare(id, requestId)).rejects.toMatchObject({ code: 'setup-required' });
  expect(f.control.prepare).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.diagnostics).toEqual([]);
});
it.each([
  ['SCOPE_REQUIRED', 'auth-required', 'playback-scope-required'],
  ['SCOPES_UNKNOWN', 'auth-required', 'playback-scope-required'],
  ['PLAYBACK_STATE_UNCONFIRMED', 'unavailable', 'cable-playback-unconfirmed'],
])('does not publish a source or start capture when saved-target preparation fails: %s', async (code, publicCode, reason) => {
  const f = fixture(); f.control.prepare.mockRejectedValue(failed(code));
  await expect(f.audio.prepare(id, requestId)).rejects.toMatchObject({ code: publicCode, message: 'Spotify: ' + reason });
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  expect(f.control.play).not.toHaveBeenCalled(); expect(f.control.close).toHaveBeenCalledOnce(); expect(f.diagnostics).toEqual([]);
});
it('does not start PCM or official playback while a native output is opening', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url);
  await source.openReadable(); await tick();
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.control.play).not.toHaveBeenCalled();
});
it('binds a frozen expected wire descriptor to each reader without opening capture early', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url);
  const first = await source.openReadable();
  expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.transport)).toBe(true);
  expect(first.transport).toEqual({ contract: 'live-pcm-s32le-v1', sampleFormat: 's32le', sampleRate: 44100, channels: 2,
    containerBits: 32, endianness: 'little', interleaved: true, framing: 'raw', frameBytes: 8 });
  expect(() => source.assertReader(first)).not.toThrow();
  expect(() => source.assertReader({ ...first })).toThrow();
  const second = await source.openReadable({ positionMs: 1000 });
  expect(second.transport).not.toBe(first.transport); expect(() => source.assertReader(first)).toThrow();
  expect(() => first.assertCurrent()).toThrow(); expect(() => source.assertReader(second)).not.toThrow();
  expect(f.captureHost.open).not.toHaveBeenCalled();
  await source.pause(); expect(() => source.assertReader(second)).toThrow();
});
it('does not yield bytes or resume Spotify when lazy capture validation rejects after descriptor creation', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable(); source.assertReader(opened);
  f.captureHost.open.mockRejectedValueOnce(failed('CAPTURE_FORMAT_INVALID'));
  await expect(opened.stream[Symbol.asyncIterator]().next()).rejects.toThrow();
  expect(f.control.play).not.toHaveBeenCalled(); expect(f.audio.lookup(prepared.url)).toBeNull();
  expect(() => source.assertReader(opened)).toThrow();
});
it('buffers complete frames but releases none until targeted play is confirmed', async () => {
  const f = fixture(), playing = deferred(); f.control.play.mockImplementationOnce(() => playing.promise);
  const active = await start(f); let published = false; void active.next.then(() => { published = true; });
  f.captures[0].queue.push(Buffer.alloc(8, 6)); await tick(); expect(published).toBe(false);
  expect(f.captures[0].start.mock.invocationCallOrder[0]).toBeLessThan(f.control.play.mock.invocationCallOrder[0]);
  playing.resolve({ ...f.facts(), isPlaying: true }); expect((await active.next).value).toEqual(Buffer.alloc(8, 6));
  await active.source.pause();
});
it('fails closed when official play is acknowledged without playing state', async () => {
  const f = fixture(); f.control.play.mockImplementationOnce(async () => ({ ...f.facts(), isPlaying: false }));
  const prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  await expect(opened.stream[Symbol.asyncIterator]().next()).rejects.toThrow('cable-playback-unconfirmed');
  expect(f.captures[0].stop).toHaveBeenCalled(); expect(f.audio.lookup(prepared.url)).toBeNull();
});
it('bounds the pre-confirmation buffer and revokes an overflowing source', async () => {
  const f = fixture(), playing = deferred(); f.control.play.mockImplementationOnce(() => playing.promise);
  const active = await start(f); const failure = expect(active.next).rejects.toThrow('cable-capture-overflow');
  f.captures[0].queue.push(Buffer.alloc(44100 * 8 * 2 + 8)); playing.resolve({ ...f.facts(), isPlaying: true });
  await failure; expect(f.audio.lookup(active.prepared.url)).toBeNull(); expect(f.captures[0].stop).toHaveBeenCalled();
});
it('repeated pause and seek discard old buffers and require a new capture generation', async () => {
  const f = fixture(), active = await start(f);
  f.captures[0].queue.push(Buffer.alloc(16, 1)); expect((await active.next).value.length).toBe(16);
  f.captures[0].queue.push(Buffer.alloc(8, 9)); await active.source.pause();
  await active.source.seek(5000); const second = await active.source.openReadable({ positionMs: 5000 });
  const next = second.stream[Symbol.asyncIterator]().next(); await tick(); f.captures[1].queue.push(Buffer.alloc(8, 2));
  expect((await next).value).toEqual(Buffer.alloc(8, 2));
  await active.source.pause(); await active.source.seek(11000);
  const third = await active.source.openReadable({ positionMs: 11000 }), final = third.stream[Symbol.asyncIterator]().next();
  await tick(); f.captures[2].queue.push(Buffer.alloc(8, 3)); expect((await final).value).toEqual(Buffer.alloc(8, 3));
  expect(f.captures.map(value => value.generation)).toEqual([1, 2, 3]); expect(f.captures[0].stop).toHaveBeenCalled();
});
it('stages a paused seek without source writes and reports the observed origin when its reader is opened', async () => {
  const f = fixture({ seekOffset: 87 }), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url);
  expect(await source.seek(10000)).toEqual({ positionMs: 10000 });
  expect(f.control.seek).not.toHaveBeenCalled(); expect(f.control.play).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  const opened = await source.openReadable({ positionMs: 10000 }); expect(opened.positionMs).toBe(10087);
  expect(f.control.seek).toHaveBeenCalledWith(expect.any(String), 10000);
});
it('retiring output pause, stop, and revoke cannot affect a newer consumer of the same source', async () => {
  const f = fixture(), first = await start(f); f.captures[0].queue.push(Buffer.alloc(8)); await first.next;
  const second = f.audio.lookup(first.prepared.url), opened = await second.openReadable({ positionMs: 1000 });
  const next = opened.stream[Symbol.asyncIterator]().next(); await tick(); f.captures[1].queue.push(Buffer.alloc(8, 7)); await next;
  const before = f.control.pause.mock.calls.length;
  await first.source.pause(); await first.source.stop(); await first.source.revoke();
  expect(f.control.pause.mock.calls.length).toBe(before); expect(f.audio.lookup(first.prepared.url)).not.toBeNull();
  expect(f.captures[1].stop).not.toHaveBeenCalled();
});
it('old in-flight play completion cannot publish frames or re-pause a replacement consumer', async () => {
  const f = fixture(), playing = deferred(); f.control.play.mockImplementationOnce(() => playing.promise);
  const first = await start(f), rejected = expect(first.next).rejects.toThrow('request-cancelled');
  const second = f.audio.lookup(first.prepared.url), opening = second.openReadable({ positionMs: 12000 });
  expect(f.captures[0].stop).toHaveBeenCalled(); playing.resolve({ ...f.facts(), isPlaying: true });
  await rejected; const opened = await opening, next = opened.stream[Symbol.asyncIterator]().next();
  await tick(); f.captures[1].queue.push(Buffer.alloc(8, 4)); expect((await next).value).toEqual(Buffer.alloc(8, 4));
  const before = f.control.pause.mock.calls.length; await first.source.stop(); expect(f.control.pause.mock.calls.length).toBe(before);
});
it('serializes repeated paused seek intents and suppresses the stale checkpoint result', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url), oldPause = deferred();
  f.control.pause.mockImplementationOnce(() => oldPause.promise);
  const first = source.seek(5000), rejected = expect(first).rejects.toThrow('request-cancelled'); await tick();
  const second = source.seek(15000); oldPause.resolve({ ...f.facts(), positionMs: 0, isPlaying: false });
  await rejected; expect(await second).toEqual({ positionMs: 15000 });
  expect(f.control.seek).not.toHaveBeenCalled(); expect(f.control.play).not.toHaveBeenCalled(); expect(f.captureHost.open).not.toHaveBeenCalled();
  const opened = await source.openReadable({ positionMs: 15000 }); expect(opened.positionMs).toBe(15000);
  expect(f.control.seek.mock.calls.map(value => value[1])).toEqual([15000]);
});
it('refuses a pending combined-Play target as an observed reader origin before opening capture', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url);
  f.control.seek.mockResolvedValueOnce({ ...f.facts(), positionMs: 10000,
    pendingStart: { requestedPositionMs: 10000, resumeIntentId: nextRequest } });
  await expect(source.openReadable({ positionMs: 10000 })).rejects.toThrow('cable-playback-unconfirmed');
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.control.play).not.toHaveBeenCalled();
});
it('aborts a cold consumer without opening capture or revoking the reusable source', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url), abort = new AbortController();
  const opened = await source.openReadable({ signal: abort.signal }); abort.abort();
  await expect(opened.stream[Symbol.asyncIterator]().next()).rejects.toThrow('request-cancelled');
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.audio.lookup(prepared.url)).not.toBeNull();
});
it('revokes only the matching session and synchronously aborts its pending PCM read', async () => {
  const f = fixture(), active = await start(f), rejected = expect(active.next).rejects.toThrow('external-playback-change');
  await f.audio.revokeSession('another-session', 'TRACK_NOT_CURRENT'); expect(f.captures[0].stop).not.toHaveBeenCalled();
  const revocation = f.audio.revokeSession(f.control.prepare.mock.calls[0][0].session, 'TRACK_NOT_CURRENT');
  expect(f.captures[0].stop).toHaveBeenCalled(); await rejected; await revocation;
  expect(f.audio.lookup(active.prepared.url)).toBeNull();
});
it('active two-second observations detect external track/device/pause changes and stop capture', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture(), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8)); await active.next;
  await vi.advanceTimersByTimeAsync(2000); expect(f.captures[0].status).toHaveBeenCalledOnce();
  f.changeState({ trackId: 'x'.repeat(22) }); const waiting = active.reader.next(), rejected = expect(waiting).rejects.toThrow('external-playback-change');
  await vi.advanceTimersByTimeAsync(2000); await rejected;
  expect(f.audio.lookup(active.prepared.url)).toBeNull(); expect(f.captures[0].stop).toHaveBeenCalled();
});
it('a changed vault revision prevents the next PCM block and closes the source', async () => {
  const f = fixture(), active = await start(f), rejected = expect(active.next).rejects.toThrow('session-changed');
  f.revokeGrant(); f.captures[0].queue.push(Buffer.alloc(8)); await rejected;
  expect(f.audio.lookup(active.prepared.url)).toBeNull();
});
it('limits output to catalog duration from the observed origin and parks capture at that boundary', async () => {
  const f = fixture({ durationMs: 10 }), active = await start(f); f.captures[0].queue.push(Buffer.alloc(4096, 1));
  expect((await active.next).value.length).toBe(3528); expect(await active.reader.next()).toMatchObject({ done: true });
  await tick(); expect(f.captures[0].stop).toHaveBeenCalled(); expect(f.facts().isPlaying).toBe(false);
  expect(f.audio.lookup(active.prepared.url)).not.toBeNull();
});
it('reuses the existing main-owned browser session and guards late browser cleanup during native handoff', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), browser = createSoloistBrowserSession({ lookup: f.audio.lookup });
  cleanups.unshift(() => browser.close());
  await browser.request({ action: 'begin', session: requestId, url: prepared.url });
  const started = await browser.request({ action: 'start', session: requestId, positionMs: 0 });
  const pull = browser.request({ action: 'pull', session: requestId, generation: started.generation }); await tick();
  f.captures[0].queue.push(Buffer.alloc(8, 1)); expect((await pull).data).toEqual(Uint8Array.from(Buffer.alloc(8, 1)));
  const native = f.audio.lookup(prepared.url), opened = await native.openReadable({ positionMs: 1000 });
  const next = opened.stream[Symbol.asyncIterator]().next(); await tick(); f.captures[1].queue.push(Buffer.alloc(8, 2)); await next;
  const before = f.control.pause.mock.calls.length; await browser.clear(); expect(f.control.pause.mock.calls.length).toBe(before);
});
it('requires both scopes and validates metadata and route before selecting the desktop', async () => {
  const missing = fixture({ scopes: ['user-read-playback-state'] });
  await expect(missing.audio.prepare(id, requestId)).rejects.toThrow('playback-scope-required');
  expect(missing.fetcher).not.toHaveBeenCalled(); expect(missing.getSelection).not.toHaveBeenCalled();
  const invalid = fixture({ fetcher: async () => Response.json({ id, type: 'episode', uri: `spotify:track:${id}`, duration_ms: 120000 }) });
  await expect(invalid.audio.prepare(id, requestId)).rejects.toThrow('track-metadata-mismatch'); expect(invalid.control.prepare).not.toHaveBeenCalled();
  const route = fixture({ configuration: { ...configuration(), ready: false, issues: ['CABLE_SHARED_WITH_OTHER_AUDIO'] } });
  await expect(route.audio.prepare(id, requestId)).rejects.toThrow('cable-configuration-required'); expect(route.control.prepare).not.toHaveBeenCalled();
});
it('a 429 updates the shared cooldown and prevents another catalog or playback request', async () => {
  const f = fixture({ fetcher: async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }) });
  await expect(f.audio.prepare(id, requestId)).rejects.toThrow('rate-limited');
  await expect(f.audio.prepare(id, nextRequest)).rejects.toThrow('rate-limited');
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.control.prepare).not.toHaveBeenCalled(); expect(f.cooldown.defer).toHaveBeenCalledWith('60');
});
it('preserves requested identity while official catalog relinking selects the resolved track', async () => {
  const resolved = 'x'.repeat(22), f = fixture({ fetcher: async () => Response.json({ id: resolved, type: 'track', uri: `spotify:track:${resolved}`,
    duration_ms: 120000, linked_from: { id, uri: `spotify:track:${id}`, type: 'track' } }) });
  const prepared = await f.audio.prepare(id, requestId);
  expect(f.audio.lookup(prepared.url).trackId).toBe(id); expect(f.control.prepare.mock.calls[0][0].trackId).toBe(resolved);
});
it('requests a temporary lease probe only when explicitly enabled and eligible', async () => {
  const notReady = { ...configuration(), ready: false, temporaryFormatLeaseEligible: true, issues: ['CAPTURE_RATE_MISMATCH'] };
  const f = fixture({ configuration: notReady, selection: { temporaryFormatLease: true } });
  const prepared = await f.audio.prepare(id, requestId); expect(prepared.playbackTransport).toBe('cable-pcm');
  expect(f.captureHost.formatProbe).toHaveBeenCalledWith(expect.objectContaining({ temporaryFormatLease: true }));
  const manual = fixture({ configuration: notReady });
  await expect(manual.audio.prepare(id, requestId)).rejects.toThrow('cable-configuration-required'); expect(manual.captureHost.formatProbe).not.toHaveBeenCalled();
});
it('forwards an enabled setup lease request to capture-open even when the observed format is already valid', async () => {
  const f = fixture({ selection: { temporaryFormatLease: true },
    configuration: { ...configuration(), temporaryFormatLeaseEligible: true } });
  const active = await start(f);
  expect(f.captureHost.formatProbe).not.toHaveBeenCalled();
  expect(f.captureHost.open).toHaveBeenCalledWith(expect.objectContaining({
    captureDeviceId: selection.captureDeviceId, renderDeviceId: selection.renderDeviceId, temporaryFormatLease: true,
  }));
  // Simulated PCM only: this witnesses the existing command boundary, not Windows playback or lease restoration.
  f.captures[0].queue.push(Buffer.alloc(8)); await active.next;
  await active.source.pause(); expect(f.captures[0].stop).toHaveBeenCalled();
});
it('rejects invalid seek before changing a good lease and keeps shared host ownership in the service', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url);
  await expect(source.seek(120000)).rejects.toThrow('invalid-position'); expect(f.control.pause).not.toHaveBeenCalled();
  await f.audio.clear(); expect(f.audio.lookup(prepared.url)).toBeNull(); expect(f.captureHost.close).not.toHaveBeenCalled();
});
it('keeps pre-play capture lead outside the remaining-song frame budget instead of clipping the tail', async () => {
  const f = fixture({ durationMs: 1000 }), playing = deferred(); f.control.play.mockImplementationOnce(() => playing.promise);
  const active = await start(f);
  // 300 ms of paused lead plus 200 ms of song arrives before the official play observation.
  f.captures[0].queue.push(Buffer.alloc(44100 * 8 / 2, 1));
  playing.resolve({ ...f.facts(), isPlaying: true, positionMs: 200 });
  let bytes = (await active.next).value.length;
  f.captures[0].queue.push(Buffer.alloc(44100 * 8 * 0.8, 2));
  for (;;) { const value = await active.reader.next(); if (value.done) break; bytes += value.value.length; }
  expect(bytes).toBe(44100 * 8 * 1.3); expect(bytes).toBeGreaterThan(44100 * 8);
  expect(f.captures[0].stop).toHaveBeenCalled();
});
it('pins the preflight process across deferred output creation and rejects a restarted Spotify instance', async () => {
  const f = fixture(), prepared = await f.audio.prepare(id, requestId), source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  f.captureHost.open.mockImplementationOnce(async (input: any) => {
    expect(input).toMatchObject({ expectedSpotifyProcessId: 1234, expectedSpotifyStartedAtUnixMs: 1700000000000 });
    throw failed('SPOTIFY_PROCESS_CHANGED');
  });
  await expect(opened.stream[Symbol.asyncIterator]().next()).rejects.toThrow('external-playback-change');
  expect(f.audio.lookup(prepared.url)).toBeNull(); expect(f.control.play).not.toHaveBeenCalled();
  expect(f.diagnostics.at(-1)).toMatchObject({ phase: 'failed', errorCode: 'SPOTIFY_PROCESS_CHANGED' });
  expect(JSON.stringify(f.diagnostics)).not.toMatch(/Spotify\.exe|explicit-|1700000000000|private body/);
});
it('rejects ambiguous preflight identities and a process changed during a temporary format probe', async () => {
  const ambiguous = configuration(); ambiguous.sessions.push({ ...ambiguous.sessions[0], processId: 5678 });
  const f = fixture({ configuration: ambiguous });
  await expect(f.audio.prepare(id, requestId)).rejects.toThrow('cable-configuration-required'); expect(f.control.prepare).not.toHaveBeenCalled();
  const g = fixture({ selection: { temporaryFormatLease: true }, configuration: { ...configuration(), ready: false, temporaryFormatLeaseEligible: true } });
  const restarted = configuration(); restarted.sessions[0].startedAtUnixMs++;
  g.captureHost.formatProbe.mockResolvedValueOnce({ state: 'released', verified: true, configuration: restarted });
  await expect(g.audio.prepare(id, requestId)).rejects.toThrow('external-playback-change'); expect(g.control.prepare).not.toHaveBeenCalled();
});
it('revokes a media handle that finishes publishing after cancellation', async () => {
  const f = fixture(), publishing = deferred(); f.media.add.mockImplementationOnce(() => publishing.promise);
  const prepared = f.audio.prepare(id, requestId), rejected = expect(prepared).rejects.toThrow('request-cancelled'); await tick();
  f.audio.cancel(requestId); await tick();
  const handle = { url: 'http://127.0.0.1:1234/late-opaque', revoke: vi.fn(async () => {}) }; publishing.resolve(handle);
  await rejected; expect(handle.revoke).toHaveBeenCalledOnce(); expect(f.audio.lookup(handle.url)).toBeNull();
});
