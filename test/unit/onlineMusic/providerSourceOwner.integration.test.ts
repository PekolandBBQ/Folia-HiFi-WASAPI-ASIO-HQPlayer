import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { audioFixture, deferred, oldTrack, tick, trackId } from './ownedRouteFixture';

// test/unit/onlineMusic/providerSourceOwner.integration.test.ts: real HTTP controller, source and route orchestration; no live services or native actions.
const fixtures: ReturnType<typeof audioFixture>[] = [];
const create = (options: any = {}) => { const f = audioFixture(options); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const count = (f: ReturnType<typeof audioFixture>, event: string) => f.events.filter(value => value === event).length;
async function play(f: ReturnType<typeof audioFixture>, id = trackId) {
  const prepared = await f.audio.prepare(id, randomUUID());
  const source = f.audio.lookup(prepared.url), opened = await source.openReadable();
  const reader = opened.stream[Symbol.asyncIterator](), next = reader.next();
  await tick(); const capture = f.captures.at(-1), marker = f.captures.length;
  capture.queue.push(Buffer.alloc(8, marker));
  expect((await next).value).toEqual(Buffer.alloc(8, marker));
  return { prepared, source, opened, reader, capture };
}
it('keeps one owner through next, previous and same-track repeat, with fresh capture generations', async () => {
  const f = create(); let previous: Awaited<ReturnType<typeof play>> | undefined;
  for (const id of [trackId, oldTrack, trackId, trackId]) {
    const active = await play(f, id);
    expect(f.state.item.uri).toBe(`spotify:track:${id}`);
    if (previous) {
      const before = f.events.length;
      await previous.source.stop(); await previous.source.revoke(); await previous.reader.return();
      expect(f.events.length).toBe(before);
      expect(active.capture.stopVerified).not.toHaveBeenCalled();
    }
    previous = active;
  }
  expect(count(f, 'route:acquire')).toBe(1); expect(count(f, 'route:rebindPreparedSelection')).toBe(3);
  expect(count(f, 'route:release')).toBe(0);
  expect(f.captures.map(c => c.generation)).toEqual([1, 2, 3, 4]);
  expect(f.events).not.toContain('control:volume');
  await f.audio.leaveProvider(); expect(count(f, 'route:release')).toBe(1);
});
it('Pause and repeated Stop close capture, retain route indefinitely and preserve heard position', async () => {
  const f = create(), active = await play(f);
  await active.source.pause({ positionMs: 12345 });
  expect(active.capture.stopVerified).toHaveBeenCalledOnce(); expect(f.lease().state).toBe('pausedHeld');
  await active.source.stop({ positionMs: 12345 }); const before = f.events.length;
  await active.source.stop({ positionMs: 12346 }); expect(f.events.length).toBe(before);
  expect(count(f, 'route:release')).toBe(0);
  const opened = await active.source.openReadable({ positionMs: 12346 });
  expect(opened.positionMs).toBe(12346); expect(count(f, 'route:acquire')).toBe(1);
  await active.source.stop(); await f.audio.leaveProvider(); expect(count(f, 'route:release')).toBe(1);
});
it('a track cancellation retains owner and a newer track can adopt it', async () => {
  const f = create(), request = randomUUID(), prepared = await f.audio.prepare(trackId, request);
  f.audio.cancel(request); await tick();
  expect(f.audio.lookup(prepared.url)).toBeNull(); expect(count(f, 'route:release')).toBe(0);
  await play(f, oldTrack); expect(count(f, 'route:acquire')).toBe(1);
  expect(f.audio.isSourceUrl(prepared.url)).toBe(true);
  expect(f.audio.isSourceUrl(prepared.url.replace('127.0.0.1', 'localhost') + '?old=1#fragment')).toBe(true);
  expect(f.audio.lookup(prepared.url + '?old=1')).toBeNull();
});
it('provider exit restores once, joins concurrent exits and blocks entry during restoration', async () => {
  const f = create(); await play(f); const real = f.host.request.getMockImplementation()!, hold = deferred();
  f.host.request.mockImplementation(async (command: string, payload: any) => { if (command === 'release') await hold.promise; return real(command, payload); });
  const a = f.audio.leaveProvider(), b = f.audio.leaveProvider(); expect(a).toBe(b);
  await expect(f.audio.prepare(oldTrack, randomUUID())).rejects.toThrow('request-cancelled');
  hold.resolve(null); await a; expect(count(f, 'route:release')).toBe(1);
  await play(f, oldTrack); expect(count(f, 'route:acquire')).toBe(2);
});
it('an invalidation with unchanged account can retry after confirmed hold without replacing the owner', async () => {
  const f = create(), active = await play(f);
  await f.audio.invalidate('SESSION_CHANGED');
  expect(active.capture.stopVerified).toHaveBeenCalledOnce(); expect(count(f, 'route:release')).toBe(0);
  await play(f, oldTrack);
  expect(count(f, 'route:validateHeld')).toBeGreaterThan(0);
  expect(count(f, 'route:acquire')).toBe(1); await f.audio.leaveProvider(); expect(count(f, 'route:release')).toBe(1);
});
it('a changed external track is rejected before a retained-owner request sends Pause or Select', async () => {
  const f = create(), active = await play(f); await active.source.stop();
  f.state.item.uri = 'spotify:track:5n5Qqam7vgaVa1iaRUc9Lp'; f.state.is_playing = true;
  const pauses = count(f, 'control:pause'), selects = count(f, 'control:select');
  await expect(f.audio.prepare(oldTrack, randomUUID())).rejects.toThrow();
  expect(count(f, 'control:pause')).toBe(pauses); expect(count(f, 'control:select')).toBe(selects);
  expect(count(f, 'route:release')).toBe(0); expect(count(f, 'route:acquire')).toBe(1);
  f.state.item.uri = `spotify:track:${trackId}`; f.state.is_playing = false;
});
it('a late old track revoke callback cannot cancel the new track control session', async () => {
  const f = create(), a = await play(f), oldSession = f.control;
  const b = await play(f, oldTrack); const before = f.events.length;
  await a.source.revoke(); await a.source.stop();
  expect(f.audio.lookup(b.prepared.url)).not.toBeNull(); expect(f.events.length).toBe(before);
  expect(oldSession).toBe(f.control); expect(f.state.is_playing).toBe(true);
});
it('serializes a superseded in-flight selected track through park before the next selection', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!, hold = deferred(); let entered = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'verifyPreparedTargetActive' && !entered) { entered = true; await hold.promise; }
    return real(command, payload);
  });
  const first = f.audio.prepare(trackId, randomUUID()); const rejected = expect(first).rejects.toThrow('request-cancelled');
  await tick(); expect(entered).toBe(true);
  const second = f.audio.prepare(oldTrack, randomUUID()); hold.resolve(null);
  await rejected; const prepared = await second; expect(f.audio.lookup(prepared.url).trackId).toBe(oldTrack);
  expect(count(f, 'route:release')).toBe(0); expect(count(f, 'route:acquire')).toBe(1);
});
it('natural EOF retires only capture and retains the same owner for the next track', async () => {
  const f = create(); f.state.item.duration_ms = 1;
  f.intercept(operation => operation === 'metadata' ? Response.json({ id: trackId, type: 'track', uri: `spotify:track:${trackId}`, duration_ms: 1, is_local: false, is_playable: true, name: 'Short fixture', album: { id: '6n6Rram7vgaVa1iaRUc9Lp', name: 'Fixture album' }, artists: [{ id: '7n7Rram7vgaVa1iaRUc9Lp', name: 'Fixture artist' }] }) : undefined);
  const prepared = await f.audio.prepare(trackId, randomUUID()), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator](), first = reader.next();
  await tick(); f.captures[0].queue.push(Buffer.alloc(360, 7)); expect((await first).value.length).toBe(360);
  f.state.progress_ms = 1; f.state.is_playing = false;
  expect((await reader.next()).done).toBe(true); expect(f.lease().state).toBe('pausedHeld');
  expect(f.captures[0].stopVerified).toHaveBeenCalledOnce(); expect(count(f, 'route:release')).toBe(0);
  f.intercept(operation => { if (operation === 'select') f.state.item.duration_ms = 120000; }); await play(f, oldTrack);
  expect(count(f, 'route:acquire')).toBe(1);
});
it('held identity validation failure blocks commands until a new request obtains a fresh valid proof', async () => {
  const f = create(), active = await play(f); await active.source.stop();
  const real = f.host.request.getMockImplementation()!, selects = count(f, 'control:select');
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'validateHeld') throw Object.assign(new Error('process changed'), { code: 'SPOTIFY_PROCESS_CHANGED' });
    return real(command, payload);
  });
  await expect(f.audio.prepare(oldTrack, randomUUID())).rejects.toThrow();
  expect(count(f, 'control:select')).toBe(selects);
  f.host.request.mockImplementation(real);
  await play(f, oldTrack);
  expect(count(f, 'route:validateHeld')).toBeGreaterThan(0);
  expect(count(f, 'control:select')).toBe(selects + 1); expect(count(f, 'route:release')).toBe(0);
  expect(count(f, 'route:acquire')).toBe(1);
});
it('a failed old Stop becomes harmless after native-authoritative provider exit recovery', async () => {
  const f = create({ recoverOnRelease: true }), active = await play(f); let failures = 0;
  f.intercept(operation => operation === 'pause' && failures++ < 2 ? new Response(null, { status: 503 }) : undefined);
  await expect(active.source.stop()).rejects.toThrow();
  await f.audio.leaveProvider(); expect(count(f, 'route:release')).toBe(1);
  const before = f.events.length; await active.source.stop(); await active.source.revoke();
  expect(f.events.length).toBe(before);
});
it('explicit exit clears a failed acquisition only after lifecycle proves no retained native owner', async () => {
  const f = create(), real = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'acquire') throw Object.assign(new Error('no native writes'), {
      code: 'NO_POLICY_WRITES', noPolicyWrites: true, failureCode: 'ORIGINAL_POLICY_UNSAFE' });
    return real(command, payload);
  });
  await expect(f.audio.prepare(trackId, randomUUID())).rejects.toThrow();
  f.host.request.mockImplementation(real);
  await f.audio.leaveProvider();
  await play(f); expect(count(f, 'route:acquire')).toBe(1);
});
it('Next during a cancelled capture Open verifies stop while preserving the reusable capture host', async () => {
  const f = create(), gate = deferred(), original = f.captureHost.open.getMockImplementation()!;
  const verifyStopped = vi.fn(async () => {}); Object.assign(f.captureHost, { verifyStopped });
  let entered = false;
  f.captureHost.open.mockImplementationOnce(async (input: any) => {
    entered = true; await gate.promise;
    if (input.signal.aborted) throw Object.assign(new Error('cancelled open'), { code: 'CANCELLED' });
    return original(input);
  });
  const prepared = await f.audio.prepare(trackId, randomUUID()), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable(), reading = opened.stream[Symbol.asyncIterator]().next();
  const rejected = expect(reading).rejects.toThrow(); await tick(); expect(entered).toBe(true);
  const next = f.audio.prepare(oldTrack, randomUUID()); gate.resolve(null); await rejected;
  const replacement = await next; expect(f.audio.lookup(replacement.url).trackId).toBe(oldTrack);
  expect(verifyStopped).toHaveBeenCalledOnce(); expect(f.captureHost.close).not.toHaveBeenCalled();
  expect(count(f, 'route:acquire')).toBe(1); expect(count(f, 'route:release')).toBe(0);
});
