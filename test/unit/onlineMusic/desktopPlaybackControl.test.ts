import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/desktopPlaybackControl.test.ts: explicit official-device control, without real accounts or captured audio.
const { createDesktopPlaybackControl } = createRequire(import.meta.url)('../../../electron/spotify/desktopPlaybackControl.cjs');
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp', otherId = '4n4Qqam7vgaVa1iaRUc9Lp';
const session = '12345678-1234-1234-1234-123456789abc', nextSession = '12345678-1234-1234-1234-123456789abd';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture({ settleIntervalMs = 100, settleTimeoutMs = 400, selectionTimeoutMs = settleTimeoutMs }: {
  settleIntervalMs?: number; settleTimeoutMs?: number; selectionTimeoutMs?: number;
} = {}) {
  let clock = 10000, retryAt = 0, revision = 0;
  const state: any = { device: { id: 'desktop-1', name: 'Same name', type: 'Computer', is_active: true, is_restricted: false },
    item: { type: 'track', uri: `spotify:track:${otherId}`, duration_ms: 120000 },
    currently_playing_type: 'track', progress_ms: 2000, is_playing: false, actions: { disallows: {} } };
  let devices: any[] = [state.device, { id: 'desktop-2', name: 'Same name', type: 'Computer', is_active: false, is_restricted: false }];
  let scopes: string[] | null = ['user-read-playback-state', 'user-modify-playback-state'];
  let override: ((url: URL, init: any) => Promise<Response | undefined> | Response | undefined) | undefined;
  const vault = { stamp: () => ({ epoch: 0, revision }), token: vi.fn(async () => 'synthetic-token'),
    grantedScopes: vi.fn(async () => ({ epoch: 0, revision, scopes })), clear: vi.fn() };
  const cooldown = { load: vi.fn(async () => retryAt), defer: vi.fn(async (_value: string) => { retryAt = clock + 60000; return retryAt; }) };
  const fetcher = vi.fn(async (address: string, init: any) => {
    const url = new URL(address), custom = await override?.(url, init);
    if (custom) return custom;
    if (init.method === 'GET') return new Response(JSON.stringify(url.pathname.endsWith('/devices') ? { devices } : state));
    if (url.pathname === '/v1/me/player') {
      const body = JSON.parse(init.body), target = devices.find(device => device.id === body.device_ids[0]);
      for (const device of devices) device.is_active = device === target;
      state.device = { ...target };
      // play:false preserves the existing play/pause state; it does not force pause.
      if (body.play === true) state.is_playing = true;
    } else if (url.pathname.endsWith('/play')) {
      const target = devices.find(device => device.id === url.searchParams.get('device_id'));
      if (target) { for (const device of devices) device.is_active = device === target; state.device = { ...target }; }
      if (init.body) { const body = JSON.parse(init.body); if (body.uris) state.item.uri = body.uris[0]; if (body.position_ms != null) state.progress_ms = body.position_ms; }
      state.is_playing = true;
    } else if (url.pathname.endsWith('/pause')) state.is_playing = false;
    else if (url.pathname.endsWith('/seek')) state.progress_ms = Number(url.searchParams.get('position_ms'));
    return new Response(null, { status: 204 });
  });
  const onFailureDiagnostic=vi.fn(), onStateDiagnostic=vi.fn();
  const onRevoke = vi.fn(), wait = vi.fn(async (ms: number) => { clock += ms; });
  const control = createDesktopPlaybackControl({ vault, cooldown, fetcher, now: () => clock, wait, onRevoke, onFailureDiagnostic, onStateDiagnostic,
    settleIntervalMs, settleTimeoutMs, selectionTimeoutMs });
  cleanups.push(() => control.dispose());
  const prepare = (extra: any = {}) => control.prepare({ session, deviceId: 'desktop-1', trackId, durationMs: 120000, ...extra });
  const writes = () => fetcher.mock.calls.filter(([, init]) => init.method === 'PUT');
  return { control, prepare, state, vault, cooldown, fetcher, onRevoke, onFailureDiagnostic, onStateDiagnostic, wait, writes,
    inactiveTarget() {
      devices = [{ ...state.device, id: 'desktop-1', is_active: false },
        { id: 'phone-1', name: 'Phone', type: 'Smartphone', is_active: true, is_restricted: false }];
      state.device = { ...devices[1] };
    },
    setDevices: (value: any[]) => { devices = value; }, setScopes: (value: string[] | null) => { scopes = value; },
    intercept: (value: typeof override) => { override = value; }, changeGrant: () => { revision++; },
    now: () => clock, advanceClock: (ms: number) => { clock += ms; } };
}

it('lists public device choices without inferring a local owner or selecting by duplicate names', async () => {
  const f = fixture(), result = await f.control.listDevices();
  expect(result).toEqual([
    { id: 'desktop-1', name: 'Same name', type: 'computer', isActive: true, restricted: false, selectable: true },
    { id: 'desktop-2', name: 'Same name', type: 'computer', isActive: false, restricted: false, selectable: true },
  ]);
  expect(f.writes()).toHaveLength(0);
});

it('prepares an exact URI on the selected desktop and confirms a paused position', async () => {
  const f = fixture(), result = await f.prepare();
  expect(result).toMatchObject({ deviceId: 'desktop-1', trackId, positionMs: 0, isPlaying: false, durationMs: 120000 });
  expect(f.writes().map(([url]) => new URL(url).pathname)).toEqual(['/v1/me/player/play', '/v1/me/player/pause']);
  for (const [url, init] of f.writes()) {
    expect(new URL(url).searchParams.get('device_id')).toBe('desktop-1');
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  expect(JSON.parse(f.writes()[0][1].body)).toEqual({ uris: [`spotify:track:${trackId}`], position_ms: 0 });
  expect(JSON.stringify(result)).not.toContain('synthetic-token');
});

it('waits for one delayed selection without extending ordinary pause confirmation', async () => {
  const f = fixture({ selectionTimeoutMs: 1500 });
  let selectedAt: number | undefined;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) {
      selectedAt = f.now(); return new Response('Invocation returned');
    }
    if (init.method === 'GET' && selectedAt != null && f.now() - selectedAt >= 800) {
      f.state.item.uri = `spotify:track:${trackId}`; f.state.is_playing = true; f.state.progress_ms = 0;
    }
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      selectedAt = undefined; return new Response('Invocation returned');
    }
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes().map(([url]) => new URL(url).pathname)).toEqual(['/v1/me/player/play', '/v1/me/player/pause']);
  expect(f.now()).toBe(11200);
});

it('serializes play, pause and seek, checking state before and after each mutation', async () => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear();
  const playing = f.control.play(session), pausing = f.control.pause(session), seeking = f.control.seek(session, 25000);
  expect(await playing).toMatchObject({ isPlaying: true });
  expect(await pausing).toMatchObject({ isPlaying: false });
  expect(await seeking).toMatchObject({ positionMs: 25000, isPlaying: false });
  expect(f.fetcher.mock.calls.map(([url, init]) => `${init.method} ${new URL(url).pathname}`)).toEqual([
    'GET /v1/me/player', 'PUT /v1/me/player/play', 'GET /v1/me/player',
    'GET /v1/me/player', 'PUT /v1/me/player/pause', 'GET /v1/me/player',
    'GET /v1/me/player', 'PUT /v1/me/player/seek', 'GET /v1/me/player',
  ]);
  expect(new URL(f.writes()[2][0]).searchParams.get('position_ms')).toBe('25000');
});

it('confirms plain-text pause 200 with one exact fresh paused observation', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); f.fetcher.mockClear(); f.wait.mockClear();
  let pauseSeen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      pauseSeen = true; f.state.is_playing = false; return new Response('Synthetic plain reply');
    }
    if (pauseSeen && init.method === 'GET') reads++;
  });
  await expect(f.control.pause(session)).resolves.toMatchObject({ isPlaying: false, positionMs: 0 });
  expect(reads).toBe(1); expect(f.wait).not.toHaveBeenCalled(); expect(f.writes()).toHaveLength(1);
});

it('does not claim temporal stability from a single paused observation', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); f.fetcher.mockClear();
  let pauseSeen = false;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      pauseSeen = true; f.state.is_playing = false; return new Response('Synthetic plain reply');
    }
    if (pauseSeen && init.method === 'GET') f.state.progress_ms += 400;
  });
  await expect(f.control.pause(session)).resolves.toMatchObject({ isPlaying: false, positionMs: 400 });
  expect(f.writes()).toHaveLength(1);
  // A later independent observation must see the changed position; no frozen multi-read claim.
  await expect(f.control.readState(session)).resolves.toMatchObject({ positionMs: 800 });
});

it('fresh reading detects an external resume after the one confirmed paused state', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); let pauseSeen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) { pauseSeen = true; return new Response('Synthetic plain reply'); }
    if (pauseSeen && init.method === 'GET') return Response.json({ ...f.state, is_playing: ++reads !== 1 });
  });
  await expect(f.control.pause(session)).resolves.toMatchObject({ isPlaying: false });
  expect(reads).toBe(1);
  await expect(f.control.readState(session)).resolves.toMatchObject({ isPlaying: true });
});

it('rejects apparently paused snapshots whose known timestamp predates the pre-pause state', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); f.state.timestamp = 2000;
  let pauseSeen = false;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      pauseSeen = true; f.state.is_playing = false; return new Response('Synthetic plain reply');
    }
    if (pauseSeen && init.method === 'GET') return Response.json({ ...f.state, timestamp: 1999 });
  });
  await expect(f.control.pause(session)).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
});

it('permits a nonregressing timestamp on the single actual paused observation', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); f.state.timestamp = 10;
  let pauseSeen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      pauseSeen = true; f.state.is_playing = false; return new Response('Synthetic plain reply');
    }
    if (pauseSeen && init.method === 'GET') return Response.json({ ...f.state, timestamp: ++reads === 2 ? 10 : 11 });
  });
  await expect(f.control.pause(session)).resolves.toMatchObject({ isPlaying: false, serverTimestamp: 11 });
  expect(reads).toBe(1);
});

it.each([undefined, null, 'old', -1, 1.5])('does not require an optional valid server timestamp: %s', async timestamp => {
  const f = fixture(); await f.prepare(); await f.control.play(session); f.state.timestamp = timestamp;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      f.state.is_playing = false; return new Response('Synthetic plain reply');
    }
  });
  await expect(f.control.pause(session)).resolves.toMatchObject({ isPlaying: false });
});

it('confirms one actual post-seek state within the existing one-second target tolerance', async () => {
  const f = fixture(); let phase = '', pauseReads = 0, seekReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      phase = 'pause'; f.state.is_playing = false; f.state.progress_ms = 25000; return new Response('Synthetic plain reply');
    }
    if (init.method === 'PUT' && url.pathname.endsWith('/seek')) {
      phase = 'seek'; f.state.progress_ms = 750; return new Response(null, { status: 204 });
    }
    if (init.method === 'GET' && phase === 'pause') pauseReads++;
    if (init.method === 'GET' && phase === 'seek') seekReads++;
  });
  await expect(f.prepare()).resolves.toMatchObject({ isPlaying: false, positionMs: 750 });
  expect(pauseReads).toBe(1); expect(seekReads).toBe(1);
});

it('allows one bounded seek phase after a slow paused-state confirmation', async () => {
  const f = fixture(); let phase = '', pauseReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      phase = 'pause'; f.state.progress_ms = 25000; return new Response('Synthetic plain reply');
    }
    if (init.method === 'PUT' && url.pathname.endsWith('/seek')) phase = 'seek';
    if (init.method === 'GET' && phase === 'pause') f.state.is_playing = ++pauseReads < 3;
  });
  await expect(f.prepare()).resolves.toMatchObject({ isPlaying: false, positionMs: 0 });
  expect(pauseReads).toBe(3); expect(f.now()).toBe(10200);
  expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith('/seek'))).toHaveLength(1);
});

it('does not extend either confirmation phase by retrying state reads after a corrective seek', async () => {
  const f = fixture(); let phase = '', pauseReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      phase = 'pause'; f.state.progress_ms = 25000; return new Response('Synthetic plain reply');
    }
    if (init.method === 'PUT' && url.pathname.endsWith('/seek')) { phase = 'seek'; return new Response(null, { status: 204 }); }
    if (init.method === 'GET' && phase === 'pause') f.state.is_playing = ++pauseReads < 3;
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'SEEK_UNCONFIRMED' });
  expect(pauseReads).toBe(3); expect(f.now()).toBe(10600);
  expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith('/seek'))).toHaveLength(1);
});

it('rejects a matching state response delivered after the fixed confirmation deadline', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); let pauseSeen = false;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      pauseSeen = true; f.state.is_playing = false; return new Response('Synthetic plain reply');
    }
    if (pauseSeen && init.method === 'GET') f.advanceClock(401);
  });
  await expect(f.control.pause(session)).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
});

it('bounds a confirmation transport that ignores AbortSignal and rejects its eventual late result', async () => {
  const f = fixture({ settleTimeoutMs: 20, settleIntervalMs: 5 }); await f.prepare(); await f.control.play(session);
  let pauseSeen = false, finish!: (response: Response) => void;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      pauseSeen = true; f.state.is_playing = false; return new Response('Synthetic plain reply');
    }
    if (pauseSeen && init.method === 'GET') return new Promise<Response>(resolve => { finish = resolve; });
  });
  await expect(f.control.pause(session)).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  finish(Response.json(f.state)); await Promise.resolve();
  await expect(f.control.readState(session)).rejects.toMatchObject({ code: 'STALE_SESSION' });
});

it('keeps an already-paused request idempotent while validating the exact target', async () => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear();
  await expect(f.control.pause(session)).resolves.toMatchObject({ isPlaying: false, trackId });
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.writes()).toHaveLength(0);
  f.state.item.uri = `spotify:track:${otherId}`;
  await expect(f.control.pause(session)).rejects.toMatchObject({ code: 'TRACK_NOT_CURRENT' });
  expect(f.writes()).toHaveLength(0);
});

it.each([
  [[], 'DEVICE_NOT_LISTED'],
  [[{ id: 'desktop-1', type: 'Computer', is_restricted: true }], 'DEVICE_RESTRICTED'],
  [[{ id: 'desktop-1', type: 'Speaker', is_restricted: false }], 'DEVICE_NOT_COMPUTER'],
  [[{ id: 'desktop-1', type: 'Computer', is_restricted: false }, { id: 'desktop-1' }], 'DUPLICATE_DEVICE_ID'],
])('rejects unavailable or ambiguous selected device %j', async (devices, code) => {
  const f = fixture(); f.setDevices(devices as any[]);
  await expect(f.prepare()).rejects.toMatchObject({ code });
  expect(f.writes()).toHaveLength(0); expect(f.onRevoke).toHaveBeenCalledWith({ session, code });
});

it('does not automatically move playback from another active device', async () => {
  const f = fixture(); f.state.device = { ...f.state.device, id: 'phone-1' };
  await expect(f.prepare()).rejects.toMatchObject({ code: 'DEVICE_ID_MISMATCH' });
  expect(f.writes()).toHaveLength(0);
});

it('activates only the exact saved inactive desktop through targeted Select, then observes and parks', async () => {
  const f = fixture(); f.inactiveTarget(); f.state.is_playing = true;
  await expect(f.prepare({ restoreSavedTarget: true })).resolves.toMatchObject({ deviceId: 'desktop-1', trackId, positionMs: 0, isPlaying: false });
  expect(f.writes().map(([url]) => new URL(url).pathname)).toEqual(['/v1/me/player/play', '/v1/me/player/pause']);
  const [url, init] = f.writes()[0];
  expect(new URL(url).searchParams.get('device_id')).toBe('desktop-1');
  expect(JSON.parse(init.body)).toEqual({ uris: [`spotify:track:${trackId}`], position_ms: 0 });
  expect(init.headers['Content-Type']).toBe('application/json');
  expect(f.writes().some(([url]) => new URL(url).pathname === '/v1/me/player')).toBe(false);
});

it('does not transfer from device listing or a preparation that lacks explicit saved-target recovery intent', async () => {
  const f = fixture(); f.inactiveTarget();
  expect((await f.control.listDevices())[0]).toMatchObject({ id: 'desktop-1', isActive: false, selectable: true });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'DEVICE_INACTIVE' });
  expect(f.writes()).toHaveLength(0);
});

it('avoids a redundant transfer when the saved desktop is already active', async () => {
  const f = fixture(); await f.prepare({ restoreSavedTarget: true });
  expect(f.writes().some(([url]) => new URL(url).pathname === '/v1/me/player')).toBe(false);
});

it.each([
  [[], 'DEVICE_NOT_LISTED'],
  [[{ id: 'desktop-1', type: 'Computer', is_restricted: true }], 'DEVICE_RESTRICTED'],
  [[{ id: 'desktop-1', type: 'Smartphone', is_restricted: false }], 'DEVICE_NOT_COMPUTER'],
  [[{ id: 'desktop-1', type: 'Computer', is_restricted: false }, { id: 'desktop-1' }], 'DUPLICATE_DEVICE_ID'],
])('never restores an unavailable or ambiguous saved target %j', async (devices, code) => {
  const f = fixture(); f.setDevices(devices as any[]);
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code });
  expect(f.writes()).toHaveLength(0);
});

it('does not trust listed-target availability when fresh selected-state reports another device', async () => {
  const f = fixture(); f.inactiveTarget(); let selected = false;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) selected = true;
    if (selected && init.method === 'GET' && url.pathname.endsWith('/player')) return Response.json({ ...f.state, device: { ...f.state.device, id: 'phone-1' } });
  });
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes()).toHaveLength(1);
});

it.each([undefined, null, 0, 'false'])('does not infer inactivity from a malformed is_active value: %s', async is_active => {
  const f = fixture(); f.setDevices([{ ...f.state.device, is_active }]);
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.writes()).toHaveLength(0);
});

it('waits for targeted activation and matching selected state before pausing', async () => {
  const f = fixture(); f.inactiveTarget(); let transferred = false, reads = 0;
  const oldState = JSON.parse(JSON.stringify(f.state));
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) transferred = true;
    if (transferred && init.method === 'GET' && url.pathname === '/v1/me/player' && reads++ < 2) return Response.json(oldState);
  });
  await expect(f.prepare({ restoreSavedTarget: true })).resolves.toMatchObject({ isPlaying: false, trackId });
  expect(f.wait).toHaveBeenCalledTimes(2);
  expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith('/play'))).toHaveLength(1);
});

it.each([false, true])('allows an active desktop with no current item to receive the selected track (transfer=%s)', async transfer => {
  const f = fixture(); if (transfer) f.inactiveTarget(); let selected = false;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) selected = true;
    if (!selected && init.method === 'GET' && url.pathname === '/v1/me/player') return new Response(null, { status: 204 });
  });
  await expect(f.prepare({ restoreSavedTarget: true })).resolves.toMatchObject({ isPlaying: false, trackId });
});

it('bounds an acknowledged targeted selection that never activates the saved desktop and never selects or replays it', async () => {
  const f = fixture(); f.inactiveTarget();
  f.intercept((url, init) => init.method === 'PUT' && url.pathname.endsWith('/play') ? new Response(null, { status: 204 }) : undefined);
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes()).toHaveLength(1); expect(f.wait).toHaveBeenCalledTimes(4);
  expect(f.onRevoke).toHaveBeenCalledWith({ session, code: 'PLAYBACK_STATE_UNCONFIRMED' });
});

it.each([401, 403, 429])('does not retry a targeted selection rejected with HTTP %s', async status => {
  const f = fixture(); f.inactiveTarget();
  f.intercept((url, init) => init.method === 'PUT' && url.pathname.endsWith('/play')
    ? new Response(null, { status, headers: { 'retry-after': '60' } }) : undefined);
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: status === 401 ? 'AUTH_REQUIRED'
    : status === 403 ? 'API_FORBIDDEN' : 'RATE_LIMITED' });
  expect(f.writes()).toHaveLength(1); expect(f.wait).not.toHaveBeenCalled();
});

it.each(['close', 'abort', 'clear', 'dispose'])('does not select a track after %s cancels an in-flight targeted selection', async action => {
  const f = fixture(); f.inactiveTarget(); const abort = new AbortController(); let finish!: (value: Response) => void;
  f.intercept((url, init) => init.method === 'PUT' && url.pathname.endsWith('/play')
    ? new Promise<Response>(resolve => { finish = resolve; }) : undefined);
  const preparing = f.prepare({ restoreSavedTarget: true, signal: abort.signal });
  const rejected = expect(preparing).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await vi.waitFor(() => expect(f.writes()).toHaveLength(1));
  if (action === 'abort') abort.abort(); else await f.control[action](session);
  finish(new Response(null, { status: 204 })); await rejected;
  expect(f.writes()).toHaveLength(1);
});

it('does not mutate after cancellation while waiting for targeted-device propagation', async () => {
  const f = fixture(); f.inactiveTarget(); const abort = new AbortController();
  f.intercept((url, init) => init.method === 'PUT' && url.pathname.endsWith('/play') ? new Response(null, { status: 204 }) : undefined);
  f.wait.mockImplementationOnce(async () => { abort.abort(); });
  await expect(f.prepare({ restoreSavedTarget: true, signal: abort.signal })).rejects.toMatchObject({ code: 'STALE_SESSION' });
  expect(f.writes()).toHaveLength(1);
});

it('keeps a completed superseded activation behind the mutation barrier before a new targeted selection', async () => {
  const f = fixture(); f.inactiveTarget(); let finish!: (value: Response) => void;
  f.intercept((url, init) => init.method === 'PUT' && url.pathname.endsWith('/play')
    ? new Promise<Response>(resolve => { finish = resolve; }) : undefined);
  const old = f.prepare({ restoreSavedTarget: true }), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await vi.waitFor(() => expect(f.writes()).toHaveLength(1));
  const replacement = f.prepare({ restoreSavedTarget: true, session: nextSession });
  await Promise.resolve(); await Promise.resolve(); expect(f.writes()).toHaveLength(1);
  f.intercept(undefined); finish(new Response(null, { status: 204 })); await rejected;
  await expect(replacement).resolves.toMatchObject({ deviceId: 'desktop-1', isPlaying: false });
  const calls = f.fetcher.mock.calls, transfers = calls.map(([url, init], i) => init.method === 'PUT'
    && new URL(url).pathname.endsWith('/play') ? i : -1).filter(i => i >= 0);
  expect(transfers).toHaveLength(2);
  expect(calls.slice(transfers[0] + 1, transfers[1]).filter(([url, init]) => init.method === 'GET'
    && new URL(url).pathname === '/v1/me/player')).toHaveLength(3); // Two uncertain-write observations plus the new selection baseline.
  expect(f.wait).toHaveBeenCalledOnce();
});

it('does not issue a replacement targeted selection when state is still changing after a timed-out targeted selection', async () => {
  const f = fixture(); f.inactiveTarget();
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) throw new DOMException('uncertain write', 'TimeoutError');
  });
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' });
  f.intercept(undefined); f.fetcher.mockClear();
  f.wait.mockImplementationOnce(async () => { f.state.is_playing = !f.state.is_playing; });
  await expect(f.prepare({ restoreSavedTarget: true, session: nextSession })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes()).toHaveLength(0);
});

it('revokes a targeted selection if its grant revision changes and does not select afterward', async () => {
  const f = fixture(); f.inactiveTarget();
  f.intercept((url, init) => { if (init.method === 'PUT' && url.pathname.endsWith('/play')) f.changeGrant(); });
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(f.writes()).toHaveLength(1); expect(f.vault.clear).not.toHaveBeenCalled();
});

it.each([null, ['user-read-playback-state'], ['user-modify-playback-state']])('does not restore without known actual grants: %j', async scopes => {
  const f = fixture(); f.inactiveTarget(); f.setScopes(scopes);
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: scopes === null ? 'SCOPES_UNKNOWN' : 'SCOPE_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each(['readState', 'play', 'pause'])('never restores a target during ordinary session %s after an external switch', async action => {
  const f = fixture(); await f.prepare({ restoreSavedTarget: true }); f.inactiveTarget(); f.fetcher.mockClear();
  await expect(f.control[action](session)).rejects.toMatchObject({ code: 'DEVICE_ID_MISMATCH' });
  expect(f.writes()).toHaveLength(0);
});

it.each([null, ['user-read-playback-state'], ['user-modify-playback-state']])('requires actual known read and modify grants: %j', async scopes => {
  const f = fixture(); f.setScopes(scopes);
  await expect(f.prepare()).rejects.toMatchObject({ code: scopes === null ? 'SCOPES_UNKNOWN' : 'SCOPE_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('revokes a lease when the authorization revision changes without clearing credentials', async () => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear(); f.changeGrant();
  await expect(f.control.play(session)).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.vault.clear).not.toHaveBeenCalled();
  expect(f.onRevoke).toHaveBeenCalledWith({ session, code: 'SESSION_CHANGED' });
});

it('does not pause a different externally chosen track', async () => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear();
  f.state.item.uri = `spotify:track:${otherId}`; f.state.is_playing = true;
  await expect(f.control.pause(session)).rejects.toMatchObject({ code: 'TRACK_NOT_CURRENT' });
  expect(f.writes()).toHaveLength(0); expect(f.state.is_playing).toBe(true);
  expect(f.onRevoke).not.toHaveBeenCalled();
  // This no-write mismatch preserves the controller for an explicit handoff.
  await expect(f.control.readState(session)).rejects.toMatchObject({code:'TRACK_NOT_CURRENT'});
  expect(f.writes()).toHaveLength(0);
  const before = vi.fn(), after = vi.fn();
  await expect(f.control.observeExternalSelection(session, before, after)).rejects.toMatchObject({code:'TRACK_NOT_CURRENT'});
});

it('rejects an external device switch observed after an accepted seek', async () => {
  const f = fixture(); await f.prepare();
  f.intercept((url, init) => { if (init.method === 'PUT' && url.pathname.endsWith('/seek')) f.state.device.id = 'phone-1'; });
  await expect(f.control.seek(session, 10000)).rejects.toMatchObject({ code: 'DEVICE_ID_MISMATCH' });
  expect(f.onRevoke).toHaveBeenCalledWith({ session, code: 'DEVICE_ID_MISMATCH' });
});

it.each(['pausing', 'resuming', 'seeking'])('honors Spotify action restriction %s', async action => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear();
  f.state.actions.disallows[action] = true; f.state.is_playing = action === 'pausing';
  const operation = action === 'seeking' ? () => f.control.seek(session, 10000)
    : action === 'pausing' ? () => f.control.pause(session) : () => f.control.play(session);
  await expect(operation()).rejects.toMatchObject({ code: 'CONTROL_REJECTED' });
  expect(f.writes()).toHaveLength(0);
});

it('allows bounded propagation delay when selecting a new track, then requires observed state', async () => {
  const f = fixture(); let delayedReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'GET' && url.pathname.endsWith('/player') && f.state.item.uri.endsWith(trackId) && delayedReads++ < 2)
      return new Response(JSON.stringify({ ...f.state, item: { ...f.state.item, uri: `spotify:track:${otherId}` } }));
  });
  await expect(f.prepare()).resolves.toMatchObject({ positionMs: 0, isPlaying: false });
  expect(f.wait).toHaveBeenCalledTimes(2);
});

it('does not equate an accepted play command with successful playback', async () => {
  const f = fixture(); await f.prepare();
  f.intercept((url, init) => init.method === 'PUT' && url.pathname.endsWith('/play') ? new Response(null, { status: 204 }) : undefined);
  await expect(f.control.play(session)).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.wait).toHaveBeenCalledTimes(4); expect(f.onRevoke).toHaveBeenCalledTimes(1);
});

it.each([-1, 120000, 120001, 1.5, NaN])('never seeks past duration or to invalid position %s', async value => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear();
  await expect(f.control.seek(session, value)).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.onRevoke).not.toHaveBeenCalled();
  await expect(f.control.readState(session)).resolves.toMatchObject({ trackId });
});

it('ignores a late response after close and never sends the pending playback mutation', async () => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear();
  let finish!: (value: Response) => void;
  const deferred = new Promise<Response>(resolve => { finish = resolve; });
  f.intercept(() => deferred);
  const playing = f.control.play(session), rejected = expect(playing).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  await f.control.close(session); finish(new Response(JSON.stringify(f.state)));
  await rejected;
  expect(f.writes()).toHaveLength(0); expect(f.onRevoke).toHaveBeenCalledTimes(1);
});

it('old cleanup cannot close a newly prepared session', async () => {
  const f = fixture(); await f.prepare(); await f.prepare({ session: nextSession });
  await f.control.close(session);
  await expect(f.control.play(nextSession)).resolves.toMatchObject({ isPlaying: true });
  expect(f.onRevoke).toHaveBeenCalledWith({ session, code: 'SUPERSEDED' });
});

it('keeps a retired in-flight mutation behind the global barrier when close clears the current lease', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); f.fetcher.mockClear();
  let finish!: (value: Response) => void;
  const deferred = new Promise<Response>(resolve => { finish = resolve; });
  f.intercept((url, init) => init.method === 'PUT' && url.pathname.endsWith('/pause') ? deferred : undefined);
  const pausing = f.control.pause(session), rejected = expect(pausing).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await vi.waitFor(() => expect(f.writes()).toHaveLength(1));
  await f.control.close(session);
  const next = f.prepare({ session: nextSession });
  await Promise.resolve(); await Promise.resolve();
  expect(f.writes()).toHaveLength(1);
  f.state.is_playing = false; f.intercept(undefined); finish(new Response(null, { status: 204 }));
  await rejected;
  await next;
  await expect(f.control.play(nextSession)).resolves.toMatchObject({ isPlaying: true });
});

it('aborts the session when the audio preparation signal is cancelled', async () => {
  const f = fixture(), abort = new AbortController(); await f.prepare({ signal: abort.signal }); abort.abort();
  await expect(f.control.play(session)).rejects.toMatchObject({ code: 'STALE_SESSION' });
  expect(f.onRevoke).toHaveBeenCalledWith({ session, code: 'CANCELLED' });
});

it('respects a service Retry-After across the next preparation, with no extra requests', async () => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear();
  f.intercept(() => new Response(null, { status: 429, headers: { 'retry-after': '60' } }));
  await expect(f.control.play(session)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(f.cooldown.defer).toHaveBeenCalledWith('60'); expect(f.fetcher).toHaveBeenCalledOnce();
  await expect(f.prepare({ session: nextSession })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each([[401, 'AUTH_REQUIRED'], [403, 'API_FORBIDDEN'], [404, 'PLAYBACK_UNAVAILABLE'], [500, 'API_UNAVAILABLE']])('sanitizes HTTP %s as %s', async (status, code) => {
  const f = fixture(); f.intercept(() => new Response('private upstream body', { status: status as number }));
  await expect(f.prepare()).rejects.toMatchObject({ message: code, code }); expect(f.writes()).toHaveLength(0);
});

it('rejects an oversized official response', async () => {
  const f = fixture(); f.intercept(() => new Response(' '.repeat(262145)));
  await expect(f.prepare()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
});

it('revokes on a bounded transport timeout', async () => {
  const f = fixture(); f.intercept(() => { throw new DOMException('untrusted detail', 'TimeoutError'); });
  await expect(f.prepare()).rejects.toMatchObject({ message: 'CONTROL_TIMEOUT', code: 'CONTROL_TIMEOUT' });
});

it('keeps an unknown sent mutation as a barrier even when later GETs appear stable', async () => {
  const f = fixture(); await f.prepare();
  f.intercept((_url, init) => { if (init.method === 'PUT') throw new DOMException('uncertain remote write', 'TimeoutError'); });
  await expect(f.control.play(session)).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' });
  f.intercept(undefined); f.fetcher.mockClear(); f.wait.mockClear();
  await expect(f.prepare({ session: nextSession })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes()).toHaveLength(0); // A paused GET cannot settle a late unknown Play producer.
});

it('does not return an unrecognized transport error code or raw message', async () => {
  const f = fixture(); f.intercept(() => { throw Object.assign(new Error('private upstream detail'), { code: 'UNEXPECTED_PRIVATE_DETAIL' }); });
  await expect(f.prepare()).rejects.toMatchObject({ message: 'API_UNAVAILABLE', code: 'API_UNAVAILABLE' });
});

it('close/dispose do not send commands to an independently owned client or clear any vault', async () => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear(); await f.control.close(session); await f.control.dispose();
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.vault.clear).not.toHaveBeenCalled();
});

it.each(['', 'null', '{}'])('also requires an actual paused observation for inert 200 form %j', async body => {
  const f = fixture(); await f.prepare(); await f.control.play(session); let seen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) { seen = true; f.state.is_playing = false; return new Response(body); }
    if (seen && init.method === 'GET') reads++;
  });
  await expect(f.control.pause(session)).resolves.toMatchObject({ isPlaying: false }); expect(reads).toBe(1);
});

it.each([200, 204, 'already-paused'])('confirms corrective seek 200 after pause %s without requiring a preceding pending pause', async pauseStatus => {
  const f = fixture(); let selected = false, selectingReads = 0, seekSeen = false, seekReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) selected = true;
    if (selected && !seekSeen && init.method === 'GET' && url.pathname.endsWith('/player')
      && ++selectingReads === 2 && pauseStatus === 'already-paused') { f.state.is_playing = false; f.state.progress_ms = 25000; }
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      f.state.is_playing = false; f.state.progress_ms = 25000; return new Response(null, { status: pauseStatus as number });
    }
    if (init.method === 'PUT' && url.pathname.endsWith('/seek')) {
      seekSeen = true; f.state.progress_ms = 750; return new Response('Opaque seek acknowledgment');
    }
    if (seekSeen && init.method === 'GET') seekReads++;
  });
  await expect(f.prepare()).resolves.toMatchObject({ isPlaying: false, positionMs: 750 });
  expect(seekReads).toBe(1); expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith('/seek'))).toHaveLength(1);
  if (pauseStatus === 'already-paused') expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith('/pause'))).toHaveLength(0);
});

it.each([999, 1000, 1001])('applies paused public seek 200 target tolerance at offset %s', async offset => {
  const f = fixture(); await f.prepare(); f.fetcher.mockClear(); let seen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT') { seen = true; f.state.progress_ms = 10000 + offset; return new Response('{}'); }
    if (seen && init.method === 'GET') reads++;
  });
  if (offset <= 1000) { await expect(f.control.seek(session, 10000)).resolves.toMatchObject({ positionMs: 10000 + offset }); expect(reads).toBe(1); }
  else await expect(f.control.seek(session, 10000)).rejects.toMatchObject({ code: 'SEEK_UNCONFIRMED' });
  expect(f.writes()).toHaveLength(1);
});

it('confirms the observed plausible public seek position without claiming a future sample', async () => {
  const f = fixture(); await f.prepare(); await f.control.play(session); let seen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT') { seen = true; f.state.progress_ms = 10000; return new Response('Opaque'); }
    if (seen && init.method === 'GET') { f.state.progress_ms = 10000 + reads++ * 100; }
  });
  await expect(f.control.seek(session, 10000)).resolves.toMatchObject({ isPlaying: true, positionMs: 10000 }); expect(reads).toBe(1);
});

it.each(['behind-target', 'far-ahead', 'old-target', 'timestamp'])('rejects %s playing seek 200 observations', async mode => {
  const f = fixture(); await f.prepare(); await f.control.play(session); f.state.timestamp = 10; let seen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT') { seen = true; return new Response('Opaque'); }
    if (seen && init.method === 'GET') {
      f.state.progress_ms = mode === 'behind-target' ? 8000 : mode === 'far-ahead' ? 30000 : mode === 'old-target' ? 0 : 10000;
      if (mode === 'timestamp') f.state.timestamp = 9;
    }
  });
  await expect(f.control.seek(session, 10000)).rejects.toMatchObject({ code: 'SEEK_UNCONFIRMED' });
});

it('accepts resume 200 on one immediate fresh GET and a delayed remote start within its absolute budget', async () => {
  const f = fixture({ settleTimeoutMs: 4000 }); await f.prepare(); f.wait.mockClear(); f.fetcher.mockClear(); f.state.progress_ms = 5000;
  let seen = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT') { seen = true; f.advanceClock(1500); f.state.is_playing = true; return new Response('Opaque'); }
    if (seen && init.method === 'GET') reads++;
  });
  await expect(f.control.play(session)).resolves.toMatchObject({ isPlaying: true, positionMs: 5000 });
  expect(reads).toBe(1); expect(f.wait).not.toHaveBeenCalled(); expect(f.writes()).toHaveLength(1);
});

it.each(['position-before', 'position-ahead', 'timestamp', 'paused'])('rejects resume 200 with %s state', async mode => {
  const f = fixture(); await f.prepare(); f.state.progress_ms = 5000; f.state.timestamp = 20; let seen = false;
  f.intercept((url, init) => {
    if (init.method === 'PUT') { seen = true; f.state.is_playing = true; return new Response('{}'); }
    if (seen && init.method === 'GET') {
      if (mode === 'position-before') f.state.progress_ms = 0;
      if (mode === 'position-ahead') f.state.progress_ms = 10000;
      if (mode === 'timestamp') f.state.timestamp = 19;
      if (mode === 'paused') f.state.is_playing = false;
    }
  });
  await expect(f.control.play(session)).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
});

it('requires one actual playing select 200 observation before the independent pause action', async () => {
  const f = fixture(); let selected = false, selectedReads = 0, pauseReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) {
      selected = true; f.state.item.uri = `spotify:track:${trackId}`; f.state.progress_ms = 10000; f.state.is_playing = true;
      return new Response('Opaque');
    }
    if (selected && init.method === 'GET') { f.state.progress_ms = 10000 + selectedReads++ * 100; }
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) { pauseReads = selectedReads; selected = false; }
  });
  await expect(f.prepare({ positionMs: 10000 })).resolves.toMatchObject({ isPlaying: false, positionMs: 10000 });
  expect(pauseReads).toBe(2); // One select confirmation, then the independent pre-pause read.
});

it.each(['behind-target', 'wrong-track', 'paused', 'ahead', 'timestamp'])('blocks select 200 with %s facts before further mutation', async mode => {
  const f = fixture(); f.state.timestamp = 10; let selected = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT') { selected = true; return new Response('Opaque'); }
    if (selected && init.method === 'GET') {
      f.state.is_playing = mode !== 'paused';
      f.state.item.uri = `spotify:track:${mode === 'wrong-track' ? otherId : trackId}`;
      f.state.progress_ms = mode === 'ahead' ? 30000 : mode === 'behind-target' ? 8000 : 10000;
      if (mode === 'timestamp') f.state.timestamp = 9;
    }
  });
  await expect(f.prepare({ positionMs: 10000 })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes()).toHaveLength(1);
});

it.each([false, true])('confirms direct activation 200 through an actual matching target state (empty=%s)', async empty => {
  const f = fixture(); f.inactiveTarget(); let selected = false, stateReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) {
      selected = true; f.state.device = { id: 'desktop-1', type: 'Computer', is_active: true, is_restricted: false };
      f.setDevices([f.state.device]); f.state.item.uri = `spotify:track:${trackId}`; f.state.progress_ms = 0; f.state.is_playing = true;
      return new Response('{}');
    }
    if (init.method === 'GET' && url.pathname === '/v1/me/player') {
      if (!selected && empty) return new Response(null, { status: 204 });
      if (selected) stateReads++;
    }
  });
  await expect(f.prepare({ restoreSavedTarget: true })).resolves.toMatchObject({ trackId, deviceId: 'desktop-1', isPlaying: false });
  expect(stateReads).toBeGreaterThanOrEqual(2); // Actual playing then actual paused, not repeated polling proof.
  expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith('/play'))).toHaveLength(1);
  expect(f.writes().some(([url]) => new URL(url).pathname === '/v1/me/player')).toBe(false);
});

it('never selects after inconsistent targeted Select 200 state observations', async () => {
  const f = fixture(); f.inactiveTarget(); let transferred = false, reads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) {
      transferred = true; f.state.device = { id: 'desktop-1', type: 'Computer', is_active: true, is_restricted: false };
      f.setDevices([f.state.device]); return new Response('Opaque');
    }
    if (transferred && init.method === 'GET' && url.pathname === '/v1/me/player') f.state.is_playing = ++reads % 2 === 0;
  });
  await expect(f.prepare({ restoreSavedTarget: true })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes()).toHaveLength(1);
});

it('does not let corrective seek 200 reset the inherited pause/seek phase or total deadline', async () => {
  const f = fixture(); let phase = '', pauseReads = 0, seekReads = 0;
  f.intercept((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/pause')) {
      phase = 'pause'; f.state.progress_ms = 25000; return new Response('Opaque pause');
    }
    if (init.method === 'PUT' && url.pathname.endsWith('/seek')) {
      phase = 'seek'; f.advanceClock(401); return new Response('Opaque seek');
    }
    if (init.method === 'GET' && phase === 'pause') f.state.is_playing = ++pauseReads < 3;
    if (init.method === 'GET' && phase === 'seek') { seekReads++; f.state.progress_ms = 0; }
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'SEEK_UNCONFIRMED' });
  expect(f.now()).toBe(10601); expect(seekReads).toBe(0);
  expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith('/seek'))).toHaveLength(1);
});

it.each(['select', 'play', 'pause', 'seek', 'activation'])('does not confirm %s 200 after grant invalidation', async operation => {
  const f = fixture();
  if (operation === 'play' || operation === 'pause' || operation === 'seek') { await f.prepare(); if (operation === 'pause') await f.control.play(session); }
  if (operation === 'activation') f.inactiveTarget();
  f.fetcher.mockClear();
  f.intercept((_url, init) => { if (init.method === 'PUT') { f.changeGrant(); return new Response('Opaque'); } });
  const result = operation === 'select' || operation === 'activation' ? f.prepare({ restoreSavedTarget: true })
    : operation === 'seek' ? f.control.seek(session, 10000) : f.control[operation](session);
  await expect(result).rejects.toMatchObject({ code: 'SESSION_CHANGED' }); expect(f.writes()).toHaveLength(1);
});

it.each(['select', 'play', 'pause', 'seek', 'activation'])('ignores %s 200 observations from a superseded generation', async operation => {
  const f = fixture();
  if (operation === 'play' || operation === 'pause' || operation === 'seek') { await f.prepare(); if (operation === 'pause') await f.control.play(session); }
  if (operation === 'activation') f.inactiveTarget();
  let seen = false, finish!: (value: Response) => void;
  f.intercept((url, init) => {
    if (init.method === 'PUT') {
      const actual = operation === 'activation' && url.pathname.endsWith('/play') ? 'activation' : url.pathname.endsWith('/play') ? init.body ? 'select' : 'play'
        : url.pathname.endsWith('/pause') ? 'pause' : 'seek';
      if (actual !== operation) return;
      seen = true;
      if (operation === 'select') { f.state.item.uri = `spotify:track:${trackId}`; f.state.is_playing = true; }
      if (operation === 'play' || operation === 'pause') f.state.is_playing = operation === 'play';
      if (operation === 'seek') f.state.progress_ms = 10000;
      if (operation === 'activation') {
        f.state.device = { id: 'desktop-1', type: 'Computer', is_active: true, is_restricted: false }; f.setDevices([f.state.device]);
      }
      return new Response('Opaque');
    }
    if (seen && init.method === 'GET') return new Promise<Response>(resolve => { finish = resolve; });
  });
  const result = operation === 'select' || operation === 'activation' ? f.prepare({ restoreSavedTarget: true })
    : operation === 'seek' ? f.control.seek(session, 10000) : f.control[operation](session);
  const rejected = expect(result).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.intercept(undefined);
  const replacement = f.prepare({ session: nextSession, restoreSavedTarget: true });
  finish(Response.json({ ...f.state, device: { ...f.state.device, id: 'stale-device' } })); await rejected;
  await expect(replacement).resolves.toMatchObject({ deviceId: 'desktop-1', trackId, isPlaying: false });
  await expect(f.control.readState(nextSession)).resolves.toMatchObject({ deviceId: 'desktop-1', trackId });
});


it.each(['play', 'seek', 'pause'])('silently rereads a transient state failure before %s without duplicating control writes', async operation => {
  const f = fixture({ settleTimeoutMs: 4000 }); await f.prepare();
  if (operation === 'pause') await f.control.play(session);
  f.fetcher.mockClear(); let reads = 0;
  f.intercept((_url, init) => {
    if (init.method === 'GET' && ++reads <= 3) return new Response(null, { status: 503 });
  });
  if (operation === 'seek') await f.control.seek(session, 5000);
  else await f.control[operation](session);
  expect(reads).toBeGreaterThanOrEqual(4);
  expect(f.onRevoke).not.toHaveBeenCalled();
  const target = '/' + operation;
  expect(f.writes().filter(([url]) => new URL(url).pathname.endsWith(target))).toHaveLength(1);
});

it('a transient playing-state lag does not immediately revoke an active source', async () => {
  const f = fixture({ settleTimeoutMs: 4000 }); await f.prepare(); await f.control.play(session);
  let reads = 0;
  f.intercept((_url, init) => {
    if (init.method === 'GET' && ++reads <= 3) return new Response(JSON.stringify({ ...f.state, is_playing: false }));
  });
  const state = await f.control.readState(session, { expectedPlaying: true });
  expect(state.isPlaying).toBe(true); expect(reads).toBe(4); expect(f.onRevoke).not.toHaveBeenCalled();
});

it('records the original rejected state without exposing credentials', async()=>{
 const f=fixture(); f.state.actions.disallows={pausing:true};
 await expect(f.prepare()).rejects.toBeDefined();
 expect(f.onFailureDiagnostic).toHaveBeenCalled();
 expect(f.onFailureDiagnostic.mock.calls[0][1]).toMatchObject({phase:'original',trackId});
 expect(JSON.stringify(f.onFailureDiagnostic.mock.calls)).not.toContain('synthetic-token');
});
