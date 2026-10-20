import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { audioFixture, deferred, oldTrack, tick, trackId } from './ownedRouteFixture';

// test/unit/onlineMusic/spotifyNaturalCaptureEnd.integration.test.ts — real source/control queues; mocked OS and Spotify boundaries.
const fixtures: ReturnType<typeof audioFixture>[] = [];
const create = () => {
  const handoff = vi.fn(), diagnostic = vi.fn();
  const f = audioFixture({ onExternalSelection: handoff, onDiagnostic: diagnostic }); fixtures.push(f);
  return { ...f, handoff, diagnostic };
};
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function nearEnd(f: ReturnType<typeof create>) {
  const prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable({ positionMs: 119990 });
  const reader = opened.stream[Symbol.asyncIterator](), first = reader.next(); await tick();
  const session = (f.controlPrepare.mock.calls[0][0] as any).session;
  // The confirmed Play itself must seed the boundary: no poll has run yet.
  f.captures[0].queue.push(Buffer.alloc(441 * 8, 19)); await first;
  return { source, reader, opened, session };
}
it('gracefully completes PCM when Spotify advances before EOF cleanup, preserving the output reader for drain', async () => {
  const f = create(), active = await nearEnd(f);
  f.state.item.uri = `spotify:track:${oldTrack}`; f.state.progress_ms = 0; f.state.is_playing = true;
  await expect(active.reader.next()).resolves.toMatchObject({ done: true }); await tick();
  expect(f.handoff).toHaveBeenCalledOnce();
  expect(f.handoff.mock.calls[0][0]).toMatchObject({ naturalEnd: true, previousTrackId: trackId, trackId: oldTrack });
  // No cancellation of the old output generation: it can continue status/drain.
  expect(() => active.source.assertReader(active.opened)).not.toThrow();
  expect(f.events).not.toContain('control:revoked'); expect(f.captures[0].stopVerified).toHaveBeenCalledOnce();
  expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({phase:'capture-complete-awaiting-output',nextTrackId:oldTrack}));
  const pauses = f.events.filter(e => e === 'control:pause').length;
  await active.source.stop(); expect(f.events.filter(e => e === 'control:pause')).toHaveLength(pauses);
  // Next selection remains possible on the same route; an old completion cannot pause it.
  const prepared = await f.audio.prepare(oldTrack, randomUUID()), next = f.audio.lookup(prepared.url);
  const read = await next.openReadable(), iterator = read.stream[Symbol.asyncIterator](), first = iterator.next(); await tick();
  f.captures[1].queue.push(Buffer.alloc(8)); await first;
  const before = f.events.length; await active.source.stop(); await active.source.revoke();
  expect(f.events.length).toBe(before); expect(f.state.is_playing).toBe(true);
  await next.stop(); await iterator.return();
});
it('an exact-track read racing normal advance does not enter cleanup-only before the handoff', async () => {
  const f = create(), active = await nearEnd(f);
  f.state.item.uri = `spotify:track:${oldTrack}`; f.state.progress_ms = 0; f.state.is_playing = true;
  const pauses = f.events.filter(e => e === 'control:pause').length;
  await expect(f.control.readState(active.session)).rejects.toMatchObject({code:'TRACK_NOT_CURRENT'});
  expect(f.events.filter(e => e === 'control:pause')).toHaveLength(pauses);
  expect(f.events).not.toContain('control:revoked');
  await expect(active.reader.next()).resolves.toMatchObject({done:true});
  expect(f.lease().state).toBe('pausedHeld');
});
it('single-song repeat reopens a fresh capture after the held same-track natural rewind', async () => {
  const f = create(), active = await nearEnd(f);
  f.state.progress_ms = 0; f.state.is_playing = true;
  await expect(active.reader.next()).resolves.toMatchObject({done:true});
  expect(f.handoff).toHaveBeenCalledWith(expect.objectContaining({naturalEnd:true,trackId}),expect.any(Function));
  const repeated = await active.source.openReadable({positionMs:0}), reader = repeated.stream[Symbol.asyncIterator]();
  const first = reader.next(); await tick(); f.captures[1].queue.push(Buffer.alloc(8,11));
  expect((await first).value).toEqual(Buffer.alloc(8,11)); expect(f.state.is_playing).toBe(true);
  expect(() => active.source.assertReader(active.opened)).toThrow();
  expect(() => active.source.assertReader(repeated)).not.toThrow();
  await active.source.stop(); await reader.return();
});
it('EOF cleanup does not pause an unrelated new selection under the old identity', async () => {
  const f = create(), active = await nearEnd(f);
  f.state.item.uri = `spotify:track:${oldTrack}`; f.state.progress_ms = 40000; f.state.is_playing = true;
  // The old cleanup Pause rejects without writes; explicit handoff remains a distinct operation.
  const pauses = f.events.filter(e => e === 'control:pause').length;
  await expect(f.control.pause(active.session)).rejects.toMatchObject({code:'TRACK_NOT_CURRENT'});
  expect(f.events.filter(e => e === 'control:pause')).toHaveLength(pauses);
  expect(f.state.is_playing).toBe(true);
  await active.reader.return();
});
it('re-observes an advance between EOF inspection and Pause instead of poisoning the session', async () => {
  const f = create(), active = await nearEnd(f); let switched = false;
  f.intercept(operation => {
    if (operation === 'state' && !switched) {
      switched = true; const old = structuredClone(f.state);
      f.state.item.uri = `spotify:track:${oldTrack}`; f.state.progress_ms = 0; f.state.is_playing = true;
      return Response.json(old);
    }
  });
  await expect(active.reader.next()).resolves.toMatchObject({done:true});
  expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({phase:'capture-end-identity-race',attempt:1}));
  expect(f.events).not.toContain('control:revoked'); expect(f.lease().state).toBe('pausedHeld');
  expect(() => active.source.assertReader(active.opened)).not.toThrow();
});
it('a natural transition discovered by the running poll ends capture gracefully without cancelling output', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable({positionMs:119990}), reader = opened.stream[Symbol.asyncIterator]();
  const first = reader.next(); await tick(); f.captures[0].queue.push(Buffer.alloc(8,7)); await first;
  f.state.item.uri = `spotify:track:${oldTrack}`; f.state.progress_ms = 0;
  const end = reader.next(); await expect(end).resolves.toMatchObject({done:true}); await tick();
  expect(f.handoff).toHaveBeenCalledWith(expect.objectContaining({naturalEnd:true}),expect.any(Function));
  expect(f.captures[0].stopVerified).toHaveBeenCalledOnce();
  expect(() => source.assertReader(opened)).not.toThrow(); expect(f.events).not.toContain('control:revoked');
},7000);
it('does not publish the next song while its deliberate handoff Pause is still settling', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable({positionMs:119990}), reader = opened.stream[Symbol.asyncIterator]();
  const first = reader.next(); await tick(); f.captures[0].queue.push(Buffer.alloc(8,7)); await first;
  f.state.item.uri = `spotify:track:${oldTrack}`; f.state.progress_ms = 0;
  const entered = deferred(), release = deferred();
  f.intercept(async operation => { if (operation==='pause') {entered.resolve(null);await release.promise;} });
  let settled = false; const end = reader.next().then((value:any)=>{settled=true;return value;});
  await entered.promise; f.captures[0].queue.push(Buffer.alloc(8,99)); await tick();
  expect(settled).toBe(false);release.resolve(null);await expect(end).resolves.toMatchObject({done:true});
  expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({phase:'capture-complete-awaiting-output',deliveredBytes:8}));
},7000);
