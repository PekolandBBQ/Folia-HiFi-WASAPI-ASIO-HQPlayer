import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { audioFixture, deferred, oldTrack, requestId, tick, trackId } from './ownedRouteFixture';

// test/unit/onlineMusic/ownedRouteAudio.integration.test.ts: mocks prove lifecycle ordering, never Windows routing qualification.
const fixtures: ReturnType<typeof audioFixture>[] = [];
const create = (options: any = {}) => { const value = audioFixture(options); fixtures.push(value); return value; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function start(f: ReturnType<typeof audioFixture>) {
  const prepared = await f.prepare(), source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const reader = opened.stream[Symbol.asyncIterator](), next = reader.next(); await tick();
  return { prepared, source, opened, reader, next };
}
it('waits for native inactivity after the source Pause ACK before acquisition', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!;
  let checks = 0;
  f.inspection.sourcePaused = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect' && !f.state.is_playing) {
      if (++checks === 2) f.inspection.sourcePaused = true;
    }
    if (command === 'acquire') expect(f.inspection.sourcePaused).toBe(true);
    return native(command, payload);
  });
  await f.prepare();
  expect(checks).toBe(2);
  expect(f.events.filter(value => value === 'route:acquire')).toHaveLength(1);
});
it('a proven no-write acquisition refusal neither suspends a phantom lease nor poisons retry', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!;
  let refuse = true;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'acquire' && refuse) {
      refuse = false;
      throw Object.assign(new Error('NO_POLICY_WRITES'), { code: 'NO_POLICY_WRITES', noPolicyWrites: true, failureCode: 'SOURCE_NOT_PAUSED' });
    }
    return native(command, payload);
  });
  await expect(f.prepare()).rejects.toThrow();
  expect(f.events).not.toContain('route:suspendPaused');
  await expect(f.prepare()).resolves.toHaveProperty('url');
});
it('blocks unqualified routing before official prepare/select, capture or media publication', async () => {
  const f = create(); f.host.capabilities.mockResolvedValue({ supported: false, productionQualified: false, providerRouteLifetime: false });
  await expect(f.prepare()).rejects.toThrow('automatic-route-unavailable');
  expect(f.events).not.toContain('control:select'); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('recovers target activation failure on the held route without restoring or reacquiring it', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!;
  let refuse = true;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'verifyPreparedTargetActive' && refuse) {
      refuse = false;
      throw Object.assign(new Error('target not active'), { code: 'SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET' });
    }
    return native(command, payload);
  });
  await expect(f.prepare()).rejects.toThrow();
  expect(f.state.is_playing).toBe(false);
  await expect(f.prepare()).resolves.toHaveProperty('url');
  expect(f.events.filter(value => value === 'route:acquire')).toHaveLength(1);
  expect(f.events).not.toContain('route:release');
  expect(f.events).not.toContain('control:volume');
});
it('rejects a cold Select whose state remains GET204 without route, capture, publication or volume writes', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!;
  f.intercept(operation => operation === 'state' ? new Response(null, { status: 204 }) : undefined);
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect') throw Object.assign(new Error(), { code: 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN' });
    return native(command, payload);
  });
  await expect(f.prepare()).rejects.toThrow('cable-playback-unconfirmed');
  expect(f.events).not.toContain('control:volume'); expect(f.events).toContain('control:select');
  expect(f.events).not.toContain('route:acquire'); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('confirms cold identity at the current volume before acquiring the exact prepared route', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!; let selected = false;
  f.intercept(operation => {
    if (operation === 'state' && !selected) return new Response(null, { status: 204 });
    if (operation === 'select') selected = true;
  });
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect' && !selected) throw Object.assign(new Error(), { code: 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN' });
    if (command === 'inspect') { expect(f.state.device.volume_percent).toBe(63); f.events.push('identity:accepted'); }
    return native(command, payload);
  });
  const prepared = await f.prepare();
  expect(f.events).toContain('identity:accepted'); expect(f.events).toContain('route:acquire');
  expect(f.events.indexOf('control:select')).toBeLessThan(f.events.indexOf('identity:accepted'));
  expect(f.events.indexOf('identity:accepted')).toBeLessThan(f.events.indexOf('route:acquire'));
  expect(f.events).not.toContain('control:volume'); expect(f.events).not.toContain('control:transfer');
  expect(f.state).toMatchObject({ is_playing: false, device: { volume_percent: 63 } });
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(prepared.playbackTransport).toBe('cable-pcm');
  await f.audio.lookup(prepared.url).stop(); expect(f.lease().state).toBe('pausedHeld');
  await f.audio.leaveProvider(); expect(f.lease().state).toBe('restored');
});
it('selects an inactive saved target with exact native identity without changing volume', async () => {
  const f = create(); f.state.device.is_active = false; f.state.is_playing = false;
  await f.prepare();
  expect(f.events).toContain('control:select'); expect(f.events).toContain('route:acquire');
  expect(f.events).not.toContain('control:volume'); expect(f.events).not.toContain('control:transfer');
  expect(f.state).toMatchObject({ is_playing: false, device: { is_active: true, volume_percent: 63 } });
});
it('lets late cold audio-session creation use the selection budget without repeating Select', async () => {
  const f = create({ selectionTimeoutMs: 1200 }), native = f.host.request.getMockImplementation()!;
  let checks = 0;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect' && ++checks <= 7)
      throw Object.assign(new Error(), { code: 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN' });
    return native(command, payload);
  });
  await f.prepare();
  expect(checks).toBeGreaterThan(7);
  expect(f.events).toContain('route:acquire');
  expect(f.events).not.toContain('control:volume');
});
it('uses a targeted Select from an active remote device without a separate Transfer or volume change', async () => {
  const f = create(); f.state.device.is_active = false;
  let selected = false;
  f.intercept((operation, state) => {
    if (operation === 'state' && !selected) return Response.json({ ...state,
      device: { id: 'remote-phone', type: 'smartphone', is_active: true, is_restricted: false } });
    if (operation === 'select') selected = true;
  });
  await f.prepare();
  expect(f.events).toContain('control:select'); expect(f.events).toContain('route:acquire');
  expect(f.events).not.toContain('control:volume'); expect(f.events).not.toContain('control:transfer');
  expect(f.state).toMatchObject({ is_playing: false, progress_ms: 0, device: { id: 'desktop', volume_percent: 63 } });
});
it.each(['SPOTIFY_AUDIO_PROCESS_AMBIGUOUS', 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN'])('rejects an unproven native target (%s) without route, capture or volume writes', async code => {
  const f = create(), native = f.host.request.getMockImplementation()!; f.state.device.supports_volume = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect') throw Object.assign(new Error(), { code });
    return native(command, payload);
  });
  await expect(f.prepare()).rejects.toThrow();
  expect(f.events).not.toContain('control:volume');
  expect(f.events.includes('control:select')).toBe(code === 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN');
  expect(f.events).not.toContain('route:acquire'); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('preserves the original volume when session discovery stays unproven', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect') throw Object.assign(new Error(), { code: 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN' });
    return native(command, payload);
  });
  await expect(f.prepare()).rejects.toThrow('spotify-cold-identity-unconfirmed');
  expect(f.state.device.volume_percent).toBe(63); expect(f.events).not.toContain('control:volume');
  expect(f.events).not.toContain('route:acquire'); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('cancels a dispatched cold Select by parking the source without changing volume or acquiring a route', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!, selected = deferred<Response>(); let entered = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect') throw Object.assign(new Error(), { code: 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN' });
    return native(command, payload);
  });
  f.intercept((operation, state) => {
    if (operation === 'select') { state.item.uri = `spotify:track:${trackId}`; state.is_playing = true; entered = true; return selected.promise; }
  });
  const preparing = f.prepare(), rejected = expect(preparing).rejects.toThrow('request-cancelled');
  await vi.waitFor(() => expect(entered).toBe(true));
  f.audio.cancel(requestId); selected.resolve(new Response(null, { status: 204 })); await rejected;
  expect(f.state).toMatchObject({ is_playing: false, device: { volume_percent: 63 } });
  expect(f.events).not.toContain('control:volume'); expect(f.events).not.toContain('route:acquire');
  expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('cancels pending native identity inspection before selection, capture or route acquisition', async () => {
  const f = create(), native = f.host.request.getMockImplementation()!, inspecting = deferred(); let entered = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'inspect') { entered = true; await inspecting.promise; }
    return native(command, payload);
  });
  const preparing = f.prepare(), rejection = expect(preparing).rejects.toThrow('request-cancelled');
  await vi.waitFor(() => expect(entered).toBe(true));
  f.audio.cancel(requestId); inspecting.resolve(null); await rejection;
  expect(f.events).not.toContain('control:volume'); expect(f.events).not.toContain('control:select');
  expect(f.events).not.toContain('route:acquire'); expect(f.captureHost.open).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('provides fresh exact-target source proof from inside acquire without waiting behind its own preparation queue', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!, samples: any[] = [];
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'acquire') samples.push(await f.control.routeSourceControl({ action: 'read', session: payload.session,
      generation: payload.generation, sourceDeviceId: payload.sourceDeviceId, expectedSourceUri: payload.expectedSourceUri,
      pausedPreviousUri: null, allowPreviousPaused: false }));
    return real(command, payload);
  });
  await f.prepare(); expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ sourceDeviceId: 'desktop', trackUri: `spotify:track:${oldTrack}`, isPlaying: false });
  expect(samples[0].observedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
it('source broker pauses only the exact owned active track and rejects an external track without touching it', async () => {
  const f = create(), prepared = await f.prepare();
  const session = f.host.request.mock.calls.find(call => call[0] === 'acquire')![1].session;
  const request = { action: 'pause', session, generation: 1, sourceDeviceId: 'desktop', expectedSourceUri: `spotify:track:${trackId}`,
    allowPreviousPaused: false, pausedPreviousUri: null };
  f.state.is_playing = true;
  expect(await f.control.routeSourceControl(request)).toMatchObject({ isPlaying: false, trackUri: `spotify:track:${trackId}` });
  f.state.item.uri = `spotify:track:${oldTrack}`; f.state.is_playing = true; const before = f.events.filter(value => value === 'control:pause').length;
  await expect(f.control.routeSourceControl(request)).rejects.toMatchObject({ code: 'TRACK_NOT_CURRENT' });
  expect(f.events.filter(value => value === 'control:pause')).toHaveLength(before); expect(f.state.is_playing).toBe(true);
  expect(f.audio.lookup(prepared.url)).not.toBeNull();
});
it('holds the exact prepared route without capture until a reader starts, keeps Stop held and restores on provider exit', async () => {
  const f = create(), prepared = await f.prepare();
  const before = (a: string, b: string) => {
    expect(f.events.indexOf(a)).toBeGreaterThan(-1); expect(f.events.indexOf(b)).toBeGreaterThan(-1);
    expect(f.events.indexOf(a)).toBeLessThan(f.events.indexOf(b));
  };
  before('observed:paused', 'route:acquire'); before('route:acquire', 'route:authorizePreparedSelection');
  before('route:authorizePreparedSelection', 'control:select'); before('control:select', 'route:verifyPreparedTargetActive');
  before('route:verifyPreparedTargetActive', 'route:completePreparedSelection'); before('route:completePreparedSelection', 'media:publish');
  expect(f.host.request.mock.calls.find(call => call[0] === 'acquire')?.[1]).toMatchObject({
    sourceDeviceId: 'desktop', expectedSourceUri: `spotify:track:${oldTrack}` });
  expect(f.host.request.mock.calls.find(call => call[0] === 'authorizePreparedSelection')?.[1]).toMatchObject({ selectedSourceUri: `spotify:track:${trackId}` });
  expect(f.state.is_playing).toBe(false); expect(f.captures).toHaveLength(0); expect(f.events).not.toContain('route:release');
  await f.audio.lookup(prepared.url).stop();
  expect(f.events).not.toContain('route:release'); expect(f.lease().state).toBe('pausedHeld');
  await f.audio.leaveProvider(); expect(f.events).toContain('route:release'); expect(f.lease().state).toBe('restored');
});
it('keeps private trial qualification separate while requiring the same capture and exact restore lifecycle', async () => {
  const f = create();
  f.host.capabilities.mockResolvedValue({ supported: true, productionQualified: false, trialAuthorized: true,
    validationProfile: 'folia-r19-owned-route-28000-x64-v1' } as any);
  const active = await start(f); f.captures[0].queue.push(Buffer.alloc(8, 5)); await active.next; await active.source.pause();
  expect(f.events.filter(value => value === 'route:acquire')).toHaveLength(1);
  expect(f.events).toContain('route:suspendPaused'); expect(f.events).not.toContain('route:release');
  await active.source.stop(); expect(f.events.filter(value => value === 'route:release')).toHaveLength(0);
  await f.audio.leaveProvider(); expect(f.events.filter(value => value === 'route:release')).toHaveLength(1);
  expect(await f.host.capabilities()).toMatchObject({ productionQualified: false });
});
it('keeps active-read PCM unpublished until complete native proof arrives after official Play', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url), proof = deferred();
  const real = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => command === 'status' ? proof.promise : real(command, payload));
  const opened = await source.openReadable(), next = opened.stream[Symbol.asyncIterator]().next(); let settled = false;
  void next.then(() => { settled = true; }); await tick(); f.captures[0].queue.push(Buffer.alloc(8, 7)); await tick();
  expect(settled).toBe(false); expect(f.state.is_playing).toBe(true);
  proof.resolve(await real('status', {})); expect((await next).value).toEqual(Buffer.alloc(8, 7));
  await source.pause();
});
it('finishes an in-flight route poll before EOF stops capture and retains the route for the next song', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  await source.seek(119990);
  const opened = await source.openReadable({ positionMs: 119990 });
  const reader = opened.stream[Symbol.asyncIterator](), first = reader.next(); await tick();
  const real = f.host.request.getMockImplementation()!, entered = deferred(), release = deferred();
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'status') { entered.resolve(undefined); await release.promise; f.events.push('poll:finished'); }
    return real(command, payload);
  });
  await entered.promise;
  f.captures[0].queue.push(Buffer.alloc(441 * 8, 7)); await first;
  const end = reader.next(); await tick();
  expect(f.captures[0].stop).not.toHaveBeenCalled();
  expect(f.captures[0].stopVerified).not.toHaveBeenCalled();
  release.resolve(undefined); await expect(end).resolves.toMatchObject({ done: true });
  expect(f.events.indexOf('poll:finished')).toBeLessThan(f.events.indexOf('capture:stop'));
  expect(f.lease().state).toBe('pausedHeld');
  expect(f.events).not.toContain('route:release');
}, 10000);
it('discards the entire held prefix if sticky isolation fails after promotion but before any PCM publication', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  const real = f.host.request.getMockImplementation()!; let activeChecks = 0;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    const value: any = await real(command, payload);
    if (command === 'status' && ++activeChecks === 2) return { ...value, intervalIsolated: false };
    return value;
  });
  const open = f.captureHost.open.getMockImplementation()!;
  f.captureHost.open.mockImplementation(async (input: any) => {
    const capture = await open(input);
    capture.promote.mockImplementation(async () => { capture.queue.push(Buffer.alloc(16, 9)); return { capturedFrames: 2 }; });
    return capture;
  });
  const opened = await source.openReadable();
  await expect(opened.stream[Symbol.asyncIterator]().next()).rejects.toThrow(); await tick();
  expect(f.captures[0].stopVerified).toHaveBeenCalled(); expect(f.audio.lookup(prepared.url)).toBeNull();
});
it('preserves the first buffered frame and requested resume position through both isolation checks', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url); await source.seek(7000);
  const open = f.captureHost.open.getMockImplementation()!;
  f.captureHost.open.mockImplementation(async (input: any) => {
    const capture = await open(input);
    capture.promote.mockImplementation(async () => { capture.queue.push(Buffer.from([7, 0, 0, 0, 8, 0, 0, 0])); return { capturedFrames: 1 }; });
    return capture;
  });
  const opened = await source.openReadable({ positionMs: 7000 });
  expect(opened.positionMs).toBe(7000);
  expect((await opened.stream[Symbol.asyncIterator]().next()).value).toEqual(Buffer.from([7, 0, 0, 0, 8, 0, 0, 0]));
  expect(f.state.progress_ms).toBe(7000); await source.stop();
});
it('stops capture while Pause holds the route, resumes with a fresh interval, and restores only on provider exit', async () => {
  const f = create(), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8)); await active.next;
  f.events.length = 0; await active.source.pause();
  const held = f.events.indexOf('route:suspendPaused'); expect(held).toBeGreaterThan(-1);
  expect(f.events.indexOf('observed:paused')).toBeGreaterThan(-1); expect(f.events.indexOf('observed:paused')).toBeLessThan(held);
  expect(f.events.indexOf('capture:stop-verified')).toBeGreaterThan(-1); expect(f.events.indexOf('capture:stop-verified')).toBeLessThan(held);
  expect(f.events).not.toContain('route:release');
  const reopened = await active.source.openReadable(), next = reopened.stream[Symbol.asyncIterator]().next(); await tick();
  f.captures[1].queue.push(Buffer.alloc(8, 9)); expect((await next).value).toEqual(Buffer.alloc(8, 9));
  expect(f.host.request.mock.calls.filter(call => call[0] === 'acquire').map(call => call[1].generation)).toEqual([1]);
  expect(f.host.request.mock.calls.filter(call => call[0] === 'resumePreparation').map(call => call[1].intervalEpoch)).toEqual([2]);
  await active.source.stop(); expect(f.events.filter(event => event === 'route:release')).toHaveLength(0);
  await f.audio.leaveProvider(); expect(f.events.filter(event => event === 'route:release')).toHaveLength(1);
});
it('pauses and blocks a failed selected track until provider exit explicitly restores', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'verifyPreparedTargetActive') { f.events.push('proof:rejected'); throw Object.assign(new Error(), { code: 'ROUTE_PROOF_UNCONFIRMED' }); }
    return real(command, payload);
  });
  await expect(f.prepare()).rejects.toThrow();
  const rejected = f.events.indexOf('proof:rejected'), paused = f.events.indexOf('observed:paused', rejected);
  expect(paused).toBeGreaterThan(rejected); expect(f.events).not.toContain('route:release');
  await f.audio.leaveProvider(); expect(f.events.indexOf('route:release')).toBeGreaterThan(paused);
  expect(f.events.indexOf('native:release-proof')).toBeGreaterThan(f.events.indexOf('control:revoked'));
  expect(f.state.is_playing).toBe(false); expect(f.media.add).not.toHaveBeenCalled();
});
it('retains cleanup authority when cancellation lands after select dispatch and before its reply', async () => {
  const f = create(), selecting = deferred<Response>();
  f.intercept((operation, state) => {
    if (operation === 'select') { state.item.uri = `spotify:track:${trackId}`; state.is_playing = true; return selecting.promise; }
  });
  const preparing = f.prepare(), failure = expect(preparing).rejects.toThrow(); await tick();
  expect(f.state.item.uri).toBe(`spotify:track:${trackId}`); f.audio.cancel(requestId); selecting.resolve(new Response(null, { status: 204 }));
  await failure; expect(f.state.is_playing).toBe(false); expect(f.events).not.toContain('route:release'); expect(f.media.add).not.toHaveBeenCalled();
  await f.audio.leaveProvider(); expect(f.events).toContain('route:release');
});
it('does not pause a different externally selected track or restore while that source is still playing', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'verifyPreparedTargetActive') { f.state.item.uri = `spotify:track:${oldTrack}`; f.events.push('external:track'); throw new Error('changed'); }
    return real(command, payload);
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.events.slice(f.events.indexOf('external:track'))).not.toContain('control:pause');
  expect(f.events).not.toContain('route:release'); expect(f.state.is_playing).toBe(true);
  await expect(f.route.close()).rejects.toMatchObject({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
});
it('cancels in-flight held-route resume preparation without opening capture or resuming the source', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url), gate = deferred();
  const real = f.host.request.getMockImplementation()!;
  await source.pause();
  let waitOnce = true, entered = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'resumePreparation' && waitOnce) { waitOnce = false; entered = true; await gate.promise; }
    return real(command, payload);
  });
  const opening = source.openReadable(), rejected = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(entered).toBe(true));
  const paused = source.pause(); gate.resolve(null); await rejected; await paused;
  expect(f.captures).toHaveLength(0); expect(f.state.is_playing).toBe(false);
  const again = await source.openReadable(), next = again.stream[Symbol.asyncIterator]().next(); await tick();
  f.captures[0].queue.push(Buffer.alloc(8)); await next; await source.stop();
});
it('blocks restore and further playback when source pause is unconfirmed', async () => {
  const f = create(), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8)); await active.next;
  const before = f.events.filter(event => event === 'route:release').length;
  f.intercept(operation => operation === 'pause' ? new Response(null, { status: 503 }) : undefined);
  await expect(active.source.pause()).rejects.toThrow();
  await tick(); expect(f.events.filter(event => event === 'route:release')).toHaveLength(before);
  expect(f.audio.lookup(active.prepared.url)).toBeNull(); expect(f.state.is_playing).toBe(true);
  await expect(f.route.close()).rejects.toMatchObject({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
});
it('retains exact-source authority until cleanup succeeds before native restoration', async () => {
  const f = create({ recoverOnRelease: true }), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8)); await active.next;
  let failures = 0;
  f.intercept(operation => operation === 'pause' && failures++ < 2 ? new Response(null, { status: 503 }) : undefined);
  await expect(active.source.pause()).rejects.toThrow(); await f.audio.clear();
  expect(f.state.is_playing).toBe(false); expect(f.events.filter(value => value === 'route:release')).toHaveLength(1);
  const revoked = f.events.lastIndexOf('control:revoked'), proof = f.events.lastIndexOf('native:release-proof');
  expect(proof).toBeGreaterThan(revoked);
  const paused = f.events.lastIndexOf('observed:paused', proof); expect(paused).toBeGreaterThan(-1);
  expect(f.events.lastIndexOf('control:pause', paused)).toBeGreaterThan(-1);
  expect(f.audio.lookup(active.prepared.url)).toBeNull();
});
it('does not retain source proof authority across a changed account grant', async () => {
  const f = create(); await f.prepare();
  const payload = f.host.request.mock.calls.find(call => call[0] === 'acquire')![1];
  await f.control.close(payload.session); f.changeGrant(); const before = f.fetcher.mock.calls.length;
  await expect(f.control.routeSourceControl({ action: 'pause', session: payload.session, generation: payload.generation,
    sourceDeviceId: 'desktop', expectedSourceUri: `spotify:track:${trackId}`, allowPreviousPaused: false, pausedPreviousUri: null }))
    .rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(f.fetcher.mock.calls).toHaveLength(before);
});
it('does not restore or acquire a replacement when native capture stop remains unconfirmed', async () => {
  const f = create(), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8)); await active.next;
  const count = f.events.filter(event => event === 'route:release').length;
  f.captures[0].stopVerified.mockRejectedValue(Object.assign(new Error('stop timeout'), { code: 'CAPTURE_STOP_TIMEOUT' }));
  await expect(active.source.stop()).rejects.toThrow();
  expect(f.events.filter(event => event === 'route:release')).toHaveLength(count); expect(f.state.is_playing).toBe(false);
  expect(f.audio.lookup(active.prepared.url)).toBeNull();
});

it('rechecks a failed paused hold on seven new-song attempts and recovers the same lease without provider exit', async () => {
  const f = create(), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8, 9)); await active.next;
  const native = f.host.request.getMockImplementation()!;
  let rejectHold = true, holdAttempts = 0;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'suspendPaused') {
      holdAttempts++;
      if (rejectHold) throw Object.assign(new Error('native pause incomplete'), { code: 'PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED' });
    }
    return native(command, payload);
  });
  const close = vi.spyOn(f.control, 'close');
  await expect(active.source.revoke()).rejects.toMatchObject({ code: 'PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED' });
  const retiredSession = (f.controlPrepare.mock.calls[0][0] as any).session;
  const ids = [trackId, oldTrack, '5P4EQaoX8QEyL59fUhLeR9', '0qUId2i13vDDWsQejz8Vrb'];
  for (let i = 0; i < 7; i++) {
    const before = holdAttempts;
    await expect(f.audio.prepare(ids[i % ids.length], `22345678-1234-1234-1234-${String(i).padStart(12, '0')}`))
      .rejects.toMatchObject({ nativeCode: 'PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED' });
    expect(holdAttempts).toBeGreaterThan(before);
  }
  expect(close.mock.calls.some(call => call[0] === retiredSession)).toBe(false);
  expect(f.captures).toHaveLength(1); expect(f.events).not.toContain('route:release');
  rejectHold = false;
  const prepared = await f.audio.prepare(oldTrack, '32345678-1234-1234-1234-123456789abc');
  expect(prepared.url).toBeTruthy(); expect(close).toHaveBeenCalledWith(retiredSession);
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const next = opened.stream[Symbol.asyncIterator]().next(); await tick();
  f.captures.at(-1).queue.push(Buffer.alloc(8, 3)); expect((await next).value).toEqual(Buffer.alloc(8, 3));
  expect(f.events.filter(event => event === 'route:acquire')).toHaveLength(1);
  expect(f.events).not.toContain('route:release');
  await source.stop(); await f.audio.leaveProvider(); expect(f.lease().state).toBe('restored');
});
it('parks the old source and retains its route across a new-song authorization failure', async () => {
  const f = create(), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8)); await active.next;
  f.events.length = 0;
  f.intercept(operation => operation === 'metadata' ? new Response(null, { status: 401 }) : undefined);
  await expect(f.audio.prepare(oldTrack, '22345678-1234-1234-1234-123456789abc')).rejects.toMatchObject({ code: 'auth-required' });
  const held = f.events.indexOf('route:suspendPaused'), metadata = f.events.indexOf('control:metadata');
  expect(held).toBeGreaterThan(-1); expect(metadata).toBeGreaterThan(held); expect(f.events).not.toContain('route:release');
  expect(f.events.indexOf('capture:stop-verified')).toBeGreaterThan(-1);
  expect(f.events.indexOf('capture:stop-verified')).toBeLessThan(held);
  expect(f.events.indexOf('observed:paused')).toBeGreaterThan(-1); expect(f.events.indexOf('observed:paused')).toBeLessThan(held);
  expect(f.state.is_playing).toBe(false); expect(f.lease().state).toBe('pausedHeld');
  expect(f.events).not.toContain('route:acquire'); expect(f.events).not.toContain('control:volume');
  expect(f.events).not.toContain('capture:open'); expect(f.events).not.toContain('media:publish');
  expect(f.audio.lookup(active.prepared.url)).toBeNull();
});

for (const failureCode of ['PLAYBACK_STATE_UNCONFIRMED', 'CAPTURE_STOP_TIMEOUT', 'UNRECOGNIZED_CLEANUP_FAILURE']) it('retries retained cleanup by state, not error allowlist: ' + failureCode, async () => {
  const f = create(), active = await start(f); f.captures[0].queue.push(Buffer.alloc(8, 9)); await active.next;
  const native = f.host.request.getMockImplementation()!;
  let rejectHold = true, holdAttempts = 0;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'suspendPaused') {
      holdAttempts++;
      if (rejectHold) throw Object.assign(new Error('native pause incomplete'), { code: failureCode });
    }
    return native(command, payload);
  });
  const close = vi.spyOn(f.control, 'close');
  await expect(active.source.revoke()).rejects.toMatchObject({ code: failureCode });
  const retiredSession = (f.controlPrepare.mock.calls[0][0] as any).session;
  const ids = [trackId, oldTrack, '5P4EQaoX8QEyL59fUhLeR9', '0qUId2i13vDDWsQejz8Vrb'];
  for (let i = 0; i < 7; i++) {
    const before = holdAttempts;
    await expect(f.audio.prepare(ids[i % ids.length], `22345678-1234-1234-1234-${String(i).padStart(12, '0')}`))
      .rejects.toMatchObject({ nativeCode: failureCode });
    expect(holdAttempts).toBeGreaterThan(before);
  }
  expect(close.mock.calls.some(call => call[0] === retiredSession)).toBe(false);
  expect(f.captures).toHaveLength(1); expect(f.events).not.toContain('route:release');
  rejectHold = false;
  const prepared = await f.audio.prepare(oldTrack, '32345678-1234-1234-1234-123456789abc');
  expect(prepared.url).toBeTruthy(); expect(close).toHaveBeenCalledWith(retiredSession);
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const next = opened.stream[Symbol.asyncIterator]().next(); await tick();
  f.captures.at(-1).queue.push(Buffer.alloc(8, 3)); expect((await next).value).toEqual(Buffer.alloc(8, 3));
  expect(f.events.filter(event => event === 'route:acquire')).toHaveLength(1);
  expect(f.events).not.toContain('route:release');
  await source.pause();
  const replacement = await source.openReadable(); const resumed = replacement.stream[Symbol.asyncIterator]().next(); await tick();
  f.captures.at(-1).queue.push(Buffer.alloc(8, 4)); expect((await resumed).value).toEqual(Buffer.alloc(8, 4));
  await source.stop(); await f.audio.leaveProvider(); expect(f.lease().state).toBe('restored');
});

it('recovers actual source Pause rejection across retries, a new track, and output replacement', async () => {
 const f=create(), active=await start(f); f.captures[0].queue.push(Buffer.alloc(8));await active.next;
 let refused=true, attempts=0;
 f.intercept(operation=>{if(operation==='pause'){attempts++;if(refused)return new Response(null,{status:503});}});
 await expect(active.source.pause()).rejects.toThrow();await tick();
 const failedSession=(f.controlPrepare.mock.calls[0][0] as any).session;
 await expect(f.control.play(failedSession)).rejects.toMatchObject({code:'PLAYBACK_STATE_UNCONFIRMED',stage:'cleanup-required'});
 await expect(f.control.seek(failedSession,1000)).rejects.toMatchObject({code:'PLAYBACK_STATE_UNCONFIRMED',stage:'cleanup-required'});
 for(let i=0;i<3;i++){const before=attempts;await expect(f.audio.prepare(oldTrack,'42345678-1234-1234-1234-'+String(i).padStart(12,'0'))).rejects.toThrow();expect(attempts).toBeGreaterThan(before);}
 refused=false;
 const prepared=await f.audio.prepare(oldTrack,'52345678-1234-1234-1234-123456789abc');const source=f.audio.lookup(prepared.url);
 let opened=await source.openReadable();let next=opened.stream[Symbol.asyncIterator]().next();await tick();f.captures.at(-1).queue.push(Buffer.alloc(8,5));await next;
 await source.pause();opened=await source.openReadable();next=opened.stream[Symbol.asyncIterator]().next();await tick();f.captures.at(-1).queue.push(Buffer.alloc(8,6));await next;
 await source.stop();await f.audio.leaveProvider();expect(f.lease().state).toBe('restored');
});

it('three silent preparation retries actually retire the old route owner before publishing replacement PCM', async () => {
 const {retryPlayback}=createRequire(import.meta.url)('../../../electron/spotify/playbackRetry.cjs');
 const f=create(), active=await start(f);f.captures[0].queue.push(Buffer.alloc(8,1));await active.next;
 const native=f.host.request.getMockImplementation()!;let attempts=0;
 f.host.request.mockImplementation(async(command:string,payload:any)=>{
   if(command==='suspendPaused'&&++attempts<=3)throw Object.assign(Error('temporary hold'),{code:'PLAYBACK_STATE_UNCONFIRMED'});
   return native(command,payload);
 });
 const reports:any[]=[];
 const prepared=await retryPlayback(()=>f.audio.prepare(oldTrack,'62345678-1234-1234-1234-123456789abc'),{wait:async()=>{},report:(v:any)=>reports.push(v)});
 expect(reports.filter(v=>v.phase==='retry')).toHaveLength(3);
 expect(attempts).toBe(4);expect(f.captures).toHaveLength(1);expect(f.events).not.toContain('route:release');
 const source=f.audio.lookup(prepared.url),opened=await source.openReadable();const next=opened.stream[Symbol.asyncIterator]().next();await tick();
 f.captures.at(-1).queue.push(Buffer.alloc(8,7));expect((await next).value).toEqual(Buffer.alloc(8,7));
 await source.stop();await f.audio.leaveProvider();expect(f.lease().state).toBe('restored');
});
