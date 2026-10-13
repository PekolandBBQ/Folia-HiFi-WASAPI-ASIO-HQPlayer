import { afterEach, expect, it, vi } from 'vitest';
import { audioFixture, deferred, oldTrack, tick, trackId } from './ownedRouteFixture';

// test/unit/onlineMusic/terminalCleanupRetirement.test.ts: production owner/controller fences with synthetic native and HTTP boundaries.
const fixtures: ReturnType<typeof audioFixture>[] = [];
const create = () => { const f = audioFixture(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const session = (f: ReturnType<typeof audioFixture>) => (f.controlPrepare.mock.calls[0][0] as { session: string }).session;
async function start(f: ReturnType<typeof audioFixture>) {
  const prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
  const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator](), next = reader.next();
  await tick(); f.captures[0].queue.push(Buffer.alloc(8, 7)); await next;
  return { source, reader, prepared };
}

it.each([trackId, oldTrack])('does not observe or pause an external playing source after exact Stop (%s)', async externalTrack => {
  const f = create(), active = await start(f); await active.source.stop();
  expect(f.lease().state).toBe('pausedHeld'); expect(f.captures[0].stopVerified).toHaveBeenCalled();
  f.state.item.uri = `spotify:track:${externalTrack}`; f.state.is_playing = true;
  const calls = f.fetcher.mock.calls.length, pause = vi.spyOn(f.control, 'pause');
  await active.source.revoke();
  expect(f.fetcher.mock.calls).toHaveLength(calls); expect(pause).not.toHaveBeenCalled();
  expect(f.state.is_playing).toBe(true); await active.reader.return();
});

it.each([trackId, oldTrack])('joins repeated completed Stop before creating a new intent (%s)', async externalTrack => {
  const f = create(), active = await start(f); await active.source.stop({ positionMs: 17000 });
  f.state.item.uri = `spotify:track:${externalTrack}`; f.state.is_playing = true;
  const calls = f.fetcher.mock.calls.length;
  expect(await active.source.stop({ positionMs: 17000 })).toEqual({ positionMs: 17000 });
  await active.source.revoke(); expect(f.fetcher.mock.calls).toHaveLength(calls);
  expect(f.state.is_playing).toBe(true); await active.reader.return();
});

it('keeps Stop fenced while provider exit performs independent native restoration reads', async () => {
  const f = create(), active = await start(f), checkpoint = f.control.terminalCleanupCheckpoint.bind(f.control);
  const fences: any[] = [];
  vi.spyOn(f.control, 'terminalCleanupCheckpoint').mockImplementation((id: unknown) => {
    f.events.push('terminal:checkpoint'); const value = checkpoint(id); fences.push(value); return value;
  });
  f.events.length = 0; await active.source.stop();
  const begin = f.events.indexOf('terminal:checkpoint');
  expect(begin).toBeGreaterThan(-1); expect(f.events).not.toContain('native:release-proof');
  expect(fences[0].isCurrent()).toBe(true);
  const calls = f.fetcher.mock.calls.length; await active.source.revoke();
  expect(f.fetcher.mock.calls).toHaveLength(calls); expect(fences[0].isCurrent()).toBe(false);
  await f.audio.leaveProvider(); const proof = f.events.indexOf('native:release-proof');
  expect(proof).toBeGreaterThan(begin); expect(f.events.slice(proof)).toContain('control:state');
  expect(f.lease().state).toBe('restored'); await active.reader.return();
});

it('revokes the old controller synchronously before yielding from completed disposal', async () => {
  const f = create(), active = await start(f); await active.source.stop();
  const originalClose = f.control.close.bind(f.control); let latePlay: Promise<any> | undefined;
  vi.spyOn(f.control, 'close').mockImplementation((id: unknown) => {
    const closing = originalClose(id);
    latePlay ||= Promise.resolve().then(() => f.control.play(id)).then(() => 'unexpected-play', (error: any) => error.code);
    return closing;
  });
  const calls = f.fetcher.mock.calls.length; await active.source.revoke();
  expect(await latePlay).toBe('STALE_SESSION'); expect(f.fetcher.mock.calls).toHaveLength(calls);
  await active.reader.return();
});

it('invalidates a checkpoint as soon as source work is queued, before its HTTP dispatch', async () => {
  const f = create(), prepared = await f.prepare(), source = f.audio.lookup(prepared.url); await source.stop();
  const id = session(f), checkpoint = f.control.terminalCleanupCheckpoint(id);
  expect(checkpoint.isCurrent()).toBe(true);
  const playing = f.control.play(id);
  expect(checkpoint.isCurrent()).toBe(false); expect(f.control.terminalCleanupCheckpoint(id)).toBeNull();
  await playing; expect(f.state.is_playing).toBe(true);
  await source.revoke(); expect(f.state.is_playing).toBe(false);
});

it('does not use a completed Stop across a grant change or contact the new account', async () => {
  const f = create(), active = await start(f); await active.source.stop();
  const pause = vi.spyOn(f.control, 'pause'), calls = f.fetcher.mock.calls.length;
  f.changeGrant(); await expect(active.source.revoke()).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(pause).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls).toHaveLength(calls);
  await active.reader.return();
});

it('retiring ordinary Pause keeps the provider route held', async () => {
  const f = create(), active = await start(f); await active.source.pause();
  expect(f.lease().state).toBe('pausedHeld'); const calls = f.fetcher.mock.calls.length;
  await active.source.revoke(); expect(f.lease().state).toBe('pausedHeld');
  expect(f.fetcher.mock.calls.length).toBeGreaterThan(calls); await active.reader.return();
});

it('keeps guarded disposal when the controller cannot attest an unchanged completed cleanup', async () => {
  const f = create(), active = await start(f); delete f.control.terminalCleanupCheckpoint;
  await active.source.stop(); const calls = f.fetcher.mock.calls.length;
  await active.source.revoke(); expect(f.fetcher.mock.calls.length).toBeGreaterThan(calls);
  expect(f.lease().state).toBe('pausedHeld'); await active.reader.return();
});

it('joins provider exit while its first exact native restore remains pending', async () => {
  const f = create(), active = await start(f), gate = deferred();
  const native = f.host.request.getMockImplementation()!; let entered = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'release') { entered = true; await gate.promise; }
    return native(command, payload);
  });
  const leaving = f.audio.leaveProvider();
  await vi.waitFor(() => expect(entered).toBe(true));
  let disposed = false; const joined = f.audio.leaveProvider(); expect(joined).toBe(leaving);
  void joined.then(() => { disposed = true; });
  await tick(); expect(disposed).toBe(false); expect(f.lease().state).not.toBe('restored');
  gate.resolve(null); await leaving;
  expect(f.lease().state).toBe('restored'); await active.reader.return();
});

it('joins pending Stop until exact paused hold completes and preserves the latest heard position', async () => {
  const f = create(), active = await start(f), gate = deferred();
  const native = f.host.request.getMockImplementation()!; let entered = false;
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'suspendPaused') { entered = true; await gate.promise; }
    const result = await native(command, payload);
    if (command === 'suspendPaused') f.state.is_playing = true;
    return result;
  });
  let completed = false;
  const first = active.source.stop({ positionMs: 17000 });
  await vi.waitFor(() => expect(entered).toBe(true));
  const second = active.source.stop({ positionMs: 18000 });
  expect(second).toBe(first); void second.then(() => { completed = true; });
  await tick(); expect(completed).toBe(false);
  const writes = f.events.filter(event => event === 'control:pause').length;
  gate.resolve(null);
  expect(await first).toEqual({ positionMs: 18000 }); expect(await second).toEqual({ positionMs: 18000 });
  await active.source.revoke();
  expect(f.events.filter(event => event === 'control:pause')).toHaveLength(writes);
  expect(f.state.is_playing).toBe(true); await active.reader.return();
});
