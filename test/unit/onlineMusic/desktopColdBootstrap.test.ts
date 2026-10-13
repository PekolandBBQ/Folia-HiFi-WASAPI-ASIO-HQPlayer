import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// test/unit/onlineMusic/desktopColdBootstrap.test.ts: serial official-control bootstrap with synthetic Spotify and observer data only.
const { createDesktopPlaybackControl } = createRequire(import.meta.url)('../../../electron/spotify/desktopPlaybackControl.cjs');
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp', otherId = '4n4Qqam7vgaVa1iaRUc9Lp';
const session = '12345678-1234-1234-1234-123456789abc';
const nextSession = '12345678-1234-1234-1234-123456789abd';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0)) await action(); });

function fixture(directory?: string) {
  let clock = 1000, revision = 0, state: any = null;
  const device: any = { id: 'desktop-1', type: 'Computer', is_active: false, is_restricted: false,
    supports_volume: true, volume_percent: 42 };
  const log: string[] = [];
  let intercept: ((url: URL, init: any) => Response | undefined | Promise<Response | undefined>) | undefined;
  const vault = { token: vi.fn(async () => 'synthetic-token'), stamp: () => ({ epoch: 0, revision }),
    grantedScopes: async () => ({ epoch: 0, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const fetcher = vi.fn(async (address: string, init: any) => {
    const url = new URL(address), operation = url.pathname.split('/').at(-1);
    log.push(`${init.method}:${operation}${operation === 'volume' ? `:${url.searchParams.get('volume_percent')}` : ''}`);
    const overridden = await intercept?.(url, init); if (overridden) return overridden;
    if (init.method === 'GET') return operation === 'devices' ? Response.json({ devices: [device] })
      : state ? Response.json(state) : new Response(null, { status: 204 });
    if (operation === 'player') {
      expect(JSON.parse(init.body)).toEqual({ device_ids: [device.id], play: false });
      expect(device.volume_percent).toBe(0);
      device.is_active = true;
      if (state) state.device = { ...device };
    } else expect(url.searchParams.get('device_id')).toBe(device.id);
    if (operation === 'volume') device.volume_percent = Number(url.searchParams.get('volume_percent'));
    if (operation === 'play') {
      const body = init.body && JSON.parse(init.body); device.is_active = true;
      state = { device: { ...device }, item: { type: 'track', uri: body?.uris[0] || state.item.uri, duration_ms: 120000 },
        currently_playing_type: 'track', progress_ms: body ? 50 : state.progress_ms, is_playing: true, actions: { disallows: {} } };
    }
    if (operation === 'pause') state.is_playing = false;
    if (operation === 'seek') state.progress_ms = Number(url.searchParams.get('position_ms'));
    return new Response(null, { status: 204 });
  });
  const control = createDesktopPlaybackControl({ vault, fetcher, coldBootstrapDirectory: directory,
    cooldown: { load: async () => 0, defer: async () => 100000 }, now: () => clock,
    wait: async (ms: number) => { clock += ms; }, settleTimeoutMs: 400, settleIntervalMs: 100 });
  cleanup.push(() => control.dispose());
  const beforeSelect = vi.fn(async (_paused: any) => { log.push('route:acquire'); });
  const coldBootstrap = vi.fn(async () => {
    log.push('observer:identity');
    expect(device.volume_percent).toBe(0); expect(state.is_playing).toBe(true);
  });
  const prepare = (extra: any = {}) => control.prepare({ session, deviceId: device.id, trackId, durationMs: 120000,
    restoreSavedTarget: true, beforeSelect, coldBootstrap, ...extra });
  return { control, prepare, device, beforeSelect, coldBootstrap, fetcher, log, state: () => state,
    override: (action: typeof intercept) => { intercept = action; }, changeGrant: () => { revision++; },
    setState: (value: any) => { state = value; },
    writes: () => log.filter(item => item.startsWith('PUT:')) };
}

it('creates a cold exact session only after volume0 readback, then restores while paused before normal route acquisition', async () => {
  const f = fixture();
  await expect(f.prepare()).resolves.toMatchObject({ deviceId: 'desktop-1', trackId, isPlaying: false, positionMs: 0 });
  expect(f.writes()).toEqual(['PUT:volume:0', 'PUT:player', 'PUT:play', 'PUT:pause', 'PUT:seek', 'PUT:volume:42', 'PUT:play', 'PUT:pause', 'PUT:seek']);
  expect(f.log.indexOf('observer:identity')).toBeGreaterThan(f.log.indexOf('PUT:play'));
  expect(f.log.indexOf('route:acquire')).toBeGreaterThan(f.log.indexOf('PUT:volume:42'));
  expect(f.beforeSelect.mock.calls[0][0]).toMatchObject({ isPlaying: false, trackId, positionMs: 0 });
  expect(f.device.volume_percent).toBe(42);
  expect(f.fetcher.mock.calls.filter(([url, init]) => init.method === 'PUT' && new URL(url).pathname === '/v1/me/player')).toHaveLength(1);
  expect(f.log.slice(f.log.indexOf('PUT:volume:0'), f.log.indexOf('PUT:player')).filter(item => item === 'GET:devices')).toHaveLength(3);
});

it.each([{ supports_volume: false }, { supports_volume: undefined }, { volume_percent: null }, { volume_percent: undefined }, { volume_percent: 101 }])(
  'does not mutate without supported, known original volume: %j', async change => {
    const f = fixture(); Object.assign(f.device, change);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_UNAVAILABLE' });
    expect(f.writes()).toEqual([]); expect(f.coldBootstrap).not.toHaveBeenCalled();
  });

it('restores the saved local target from initial remote playback only after target mute, then selects the user track', async () => {
  const f = fixture(); f.setState({ device: { ...f.device, id: 'phone-1', type: 'Smartphone', is_active: true }, is_playing: true,
    item: { type: 'track', uri: `spotify:track:${otherId}`, duration_ms: 120000 }, progress_ms: 27000 });
  await f.prepare({ coldBootstrapRequired: false });
  expect(f.writes().slice(0, 3)).toEqual(['PUT:volume:0', 'PUT:player', 'PUT:play']);
  expect(f.state()).toMatchObject({ device: { id: 'desktop-1' }, is_playing: false, progress_ms: 0 });
  expect(f.device.volume_percent).toBe(42); expect(f.beforeSelect).toHaveBeenCalledOnce();
});

it('does not select or restore volume when transfer never confirms the exact target', async () => {
  const f = fixture(); f.setState({ device: { ...f.device, id: 'phone-1', is_active: true }, is_playing: true,
    item: { type: 'track', uri: `spotify:track:${otherId}`, duration_ms: 120000 }, progress_ms: 27000 });
  f.override((url, init) => init.method === 'PUT' && url.pathname.endsWith('/player')
    ? new Response(null, { status: 204 }) : undefined);
  await expect(f.prepare({ coldBootstrapRequired: false })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0', 'PUT:player']);
  expect(f.device.volume_percent).toBe(0); expect(f.state().device.id).toBe('phone-1');
});

it('stops without selecting when the transferred track differs from the frozen remote baseline', async () => {
  const f = fixture(); f.setState({ device: { ...f.device, id: 'phone-1', is_active: true }, is_playing: true,
    item: { type: 'track', uri: `spotify:track:${otherId}`, duration_ms: 120000 }, progress_ms: 27000 });
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.device.is_active = true; f.state().device = { ...f.device };
      f.state().item.uri = 'spotify:track:5n5Rram7vgaVa1iaRUc9Lp';
      return new Response(null, { status: 204 });
    }
  });
  await expect(f.prepare({ coldBootstrapRequired: false })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0', 'PUT:player']); expect(f.device.volume_percent).toBe(0);
});

it('stops and pauses the transferred baseline if mute no longer reads back after activation', async () => {
  const f = fixture(); f.setState({ device: { ...f.device, id: 'phone-1', is_active: true }, is_playing: true,
    item: { type: 'track', uri: `spotify:track:${otherId}`, duration_ms: 120000 }, progress_ms: 27000 });
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.device.is_active = true; f.device.volume_percent = 11; f.state().device = { ...f.device };
      return new Response(null, { status: 204 });
    }
  });
  await expect(f.prepare({ coldBootstrapRequired: false })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0', 'PUT:player', 'PUT:pause']);
  expect(f.state().is_playing).toBe(false); expect(f.device.volume_percent).toBe(11);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it('never falls back to legacy transfer before an automatic route when cold bootstrap is absent', async () => {
  const f = fixture();
  await expect(f.prepare({ coldBootstrap: undefined })).rejects.toMatchObject({ code: 'DEVICE_INACTIVE' });
  expect(f.writes()).toEqual([]); expect(f.beforeSelect).not.toHaveBeenCalled();
});

it('uses the same muted bootstrap for inactive saved desktop without requiring a missing native session', async () => {
  const f = fixture();
  await f.prepare({ coldBootstrapRequired: false });
  expect(f.coldBootstrap).toHaveBeenCalledOnce();
  expect(f.writes()[0]).toBe('PUT:volume:0');
  expect(f.writes()[1]).toBe('PUT:player');
});

it('accepts an inactive non-playing exact GET200 only as a cold baseline and obtains actual selected pause proof afterward', async () => {
  const f = fixture();
  f.setState({ device: { ...f.device }, is_playing: false,
    item: { type: 'track', uri: `spotify:track:${otherId}`, duration_ms: 120000 }, progress_ms: 0 });
  await f.prepare({ coldBootstrapRequired: false });
  expect(f.coldBootstrap).toHaveBeenCalledOnce(); expect(f.writes()[0]).toBe('PUT:volume:0');
  expect(f.beforeSelect.mock.calls[0][0]).toMatchObject({ isPlaying: false, trackId, positionMs: 0 });
});

it('rejects an inactive yet reportedly playing player before muting or transferring', async () => {
  const f = fixture(); f.setState({ device: { ...f.device }, is_playing: true });
  await expect(f.prepare({ coldBootstrapRequired: false })).rejects.toMatchObject({ code: 'DEVICE_INACTIVE' });
  expect(f.writes()).toEqual([]);
});

it('uses the same muted bootstrap for active desktop with an empty official player state', async () => {
  const f = fixture(); f.device.is_active = true;
  await f.prepare({ coldBootstrapRequired: false });
  expect(f.coldBootstrap).toHaveBeenCalledOnce(); expect(f.writes()[0]).toBe('PUT:volume:0');
});

it('keeps the existing warm automatic path without changing volume', async () => {
  const f = fixture(); f.device.is_active = true;
  f.setState({ device: { ...f.device }, is_playing: false,
    item: { type: 'track', uri: `spotify:track:${otherId}`, duration_ms: 120000 }, progress_ms: 0 });
  await f.prepare({ coldBootstrapRequired: false });
  expect(f.coldBootstrap).not.toHaveBeenCalled(); expect(f.beforeSelect).toHaveBeenCalledOnce();
  expect(f.writes().some(item => item.startsWith('PUT:volume'))).toBe(false);
});

it.each([0, 100])('restores the exact original volume %s without inventing a gain', async originalVolume => {
  const f = fixture(); f.device.volume_percent = originalVolume;
  await f.prepare(); expect(f.device.volume_percent).toBe(originalVolume);
  expect(f.writes().filter(item => item.startsWith('PUT:volume'))).toEqual(['PUT:volume:0', `PUT:volume:${originalVolume}`]);
});

it('still confirms two fresh volume observations for an opaque HTTP200 acknowledgment', async () => {
  const f = fixture();
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/volume')) {
      f.device.volume_percent = Number(url.searchParams.get('volume_percent'));
      return new Response('Synthetic acknowledgment');
    }
  });
  await f.prepare(); expect(f.device.volume_percent).toBe(42);
  expect(f.log.slice(f.log.indexOf('PUT:volume:0'), f.log.indexOf('PUT:player')).filter(item => item === 'GET:devices')).toHaveLength(3);
});

it('does not play when fresh volume readback fails, and retains the unresolved original volume', async () => {
  const f = fixture();
  f.override((url, init) => init.method === 'PUT' && url.pathname.endsWith('/volume') ? new Response(null, { status: 204 }) : undefined);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0']); expect(f.beforeSelect).not.toHaveBeenCalled();
  await expect(f.prepare({ session: nextSession })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0']);
});

it('stops before selection if another device becomes active during muted readback', async () => {
  const f = fixture();
  f.override((url, init) => {
    if (init.method === 'GET' && url.pathname.endsWith('/player') && f.device.volume_percent === 0)
      return Response.json({ device: { ...f.device, id: 'phone-1', is_active: true }, is_playing: true });
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0']); expect(f.coldBootstrap).not.toHaveBeenCalled();
});

it('keeps an unconfirmed select muted even if an exact paused source becomes observable during cleanup', async () => {
  const f = fixture(); let selecting = false, reads = 0;
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/play')) selecting = true;
    if (init.method === 'GET' && url.pathname.endsWith('/player') && selecting && ++reads < 6)
      return new Response(null, { status: 204 });
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.device.volume_percent).toBe(0); expect(f.writes()).not.toContain('PUT:volume:42');
  expect(f.beforeSelect).not.toHaveBeenCalled();
});

it('safely parks and restores the exact source after native identity inspection rejects', async () => {
  const f = fixture();
  await expect(f.prepare({ coldBootstrap: async () => { throw Object.assign(new Error(), { code: 'CONTROL_REJECTED' }); } }))
    .rejects.toMatchObject({ code: 'BOOTSTRAP_IDENTITY_UNCONFIRMED' });
  expect(f.state()).toMatchObject({ is_playing: false, progress_ms: 0 });
  expect(f.device.volume_percent).toBe(42); expect(f.beforeSelect).not.toHaveBeenCalled();
});

it.each(['CANCELLED', 'SUPERSEDED', 'STALE_SESSION'])('preserves callback %s after bounded safe recovery', async code => {
  const f = fixture();
  await expect(f.prepare({ coldBootstrap: async () => { throw Object.assign(new Error(), { code }); } })).rejects.toMatchObject({ code });
  expect(f.device.volume_percent).toBe(42); expect(f.state().is_playing).toBe(false);
});

it('does not restore original volume using a paused observation older than the selected-track confirmation', async () => {
  const f = fixture(); let stale = false;
  f.override((url, init) => {
    if (init.method === 'GET' && url.pathname.endsWith('/player') && f.state())
      return Response.json({ ...f.state(), timestamp: stale ? 99 : 100 });
  });
  await expect(f.prepare({ coldBootstrap: async () => { stale = true; } })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.device.volume_percent).toBe(0); expect(f.writes()).not.toContain('PUT:volume:42');
});

it('recognizes an already restored original volume during same-lease cleanup without replaying the volume command', async () => {
  const f = fixture();
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/volume') && url.searchParams.get('volume_percent') === '42') {
      f.device.volume_percent = 42;
      return Response.json({ error: { status: 500 } });
    }
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.writes().filter(item => item === 'PUT:volume:42')).toHaveLength(1);
  expect(f.state().is_playing).toBe(false); expect(f.device.volume_percent).toBe(42);
  await expect(f.prepare({ session: nextSession, coldBootstrapRequired: false })).resolves.toMatchObject({ isPlaying: false });
});

it.each(['device', 'track', 'grant', 'volume'])('does not commandeer a changed %s during cold identity inspection', async change => {
  const f = fixture();
  await expect(f.prepare({ coldBootstrap: async () => {
    if (change === 'device') f.state().device.id = 'phone-1';
    if (change === 'track') f.state().item.uri = `spotify:track:${otherId}`;
    if (change === 'grant') f.changeGrant();
    if (change === 'volume') f.device.volume_percent = 11;
  } })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).not.toContain('PUT:volume:42'); expect(f.beforeSelect).not.toHaveBeenCalled();
  if (change !== 'volume') expect(f.writes()).not.toContain('PUT:pause');
});

it('retains narrow same-grant cleanup through caller cancellation before releasing the mutation queue', async () => {
  const f = fixture(), abort = new AbortController();
  await expect(f.prepare({ signal: abort.signal, coldBootstrap: async () => { abort.abort(); } }))
    .rejects.toMatchObject({ code: 'STALE_SESSION' });
  expect(f.state()).toMatchObject({ is_playing: false, progress_ms: 0 });
  expect(f.device.volume_percent).toBe(42); expect(f.beforeSelect).not.toHaveBeenCalled();
});

it('bounds a stuck native identity observer, restores the paused source and never acquires a route', async () => {
  const f = fixture();
  await expect(f.prepare({ coldBootstrap: () => new Promise(() => {}) })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.state()).toMatchObject({ is_playing: false, progress_ms: 0 });
  expect(f.device.volume_percent).toBe(42); expect(f.beforeSelect).not.toHaveBeenCalled();
});

it('finishes cancelled bootstrap cleanup before a newer selection can run', async () => {
  const f = fixture(); let enter!: () => void;
  const inspecting = new Promise<void>(resolve => { enter = resolve; });
  const first = f.prepare({ coldBootstrap: () => { enter(); return new Promise(() => {}); } });
  const rejected = expect(first).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await inspecting;
  const newer = f.prepare({ session: nextSession, coldBootstrap: undefined });
  await rejected; await newer;
  const selects = f.log.map((item, index) => item === 'PUT:play' ? index : -1).filter(index => index >= 0);
  expect(selects).toHaveLength(2);
  expect(selects[1]).toBeGreaterThan(f.log.indexOf('PUT:volume:42'));
  expect(f.device.volume_percent).toBe(42);
});

it('stores original volume before the first mutation and removes the receipt only after confirmed recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folia-cold-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(directory);
  f.override(async (url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/volume')) {
      const receipt = JSON.parse(await readFile(join(directory, 'cold-volume-recovery.json'), 'utf8'));
      expect(receipt).toMatchObject({ session, deviceId: 'desktop-1', trackId, originalVolume: 42 });
      if (url.searchParams.get('volume_percent') === '42') expect(f.state().is_playing).toBe(false);
    }
  });
  await f.prepare();
  await expect(readFile(join(directory, 'cold-volume-recovery.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('blocks restart on any interrupted receipt without replaying old device/grant authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folia-cold-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'cold-volume-recovery.json'), '{interrupted');
  const f = fixture(directory);
  await expect(f.prepare({ coldBootstrap: undefined })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});

function materializedPausedState(f: ReturnType<typeof fixture>, id = trackId) {
  f.device.is_active = true;
  return { device: { ...f.device }, item: { type: 'track', uri: `spotify:track:${id}`, duration_ms: 120000 },
    currently_playing_type: 'track', progress_ms: 9000, is_playing: false, timestamp: 100, actions: { disallows: {} } };
}

it.each([trackId, otherId])('accepts null to stable, complete muted local paused source %s before selecting the requested track', async id => {
  const f = fixture();
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.setState(materializedPausedState(f, id)); return new Response(null, { status: 204 });
    }
  });
  await expect(f.prepare()).resolves.toMatchObject({ trackId, isPlaying: false, positionMs: 0 });
  expect(f.coldBootstrap).toHaveBeenCalledOnce(); expect(f.beforeSelect).toHaveBeenCalledOnce();
  expect(f.device.volume_percent).toBe(42);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: false });
  const between = f.log.slice(f.log.indexOf('PUT:player') + 1, f.log.indexOf('PUT:play'));
  expect(between.filter(item => item === 'GET:player')).toHaveLength(3);
  expect(between.filter(item => item === 'GET:devices')).toHaveLength(4);
});

it.each(['playing', 'wrong-device', 'invalid-track', 'invalid-duration', 'invalid-position', 'third-volume',
  'position-changed', 'track-changed', 'stale-timestamp', 'missing-timestamp', 'grant-changed'])
('does not select or compensate through materialized-source conflict: %s', async change => {
  const f = fixture(); let transferred = false, observations = 0;
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      const state = materializedPausedState(f); transferred = true;
      if (change === 'playing') state.is_playing = true;
      if (change === 'wrong-device') state.device.id = 'different-desktop';
      if (change === 'invalid-track') state.item.uri = 'spotify:episode:invalid';
      if (change === 'invalid-duration') state.item.duration_ms = 0;
      if (change === 'invalid-position') state.progress_ms = -1;
      if (change === 'third-volume') f.device.volume_percent = 11;
      f.setState(state); return new Response(null, { status: 204 });
    }
    if (transferred && init.method === 'GET' && url.pathname.endsWith('/player') && ++observations === 3) {
      if (change === 'position-changed') f.state().progress_ms++;
      if (change === 'track-changed') f.state().item.uri = `spotify:track:${otherId}`;
      if (change === 'stale-timestamp') f.state().timestamp--;
      if (change === 'missing-timestamp') delete f.state().timestamp;
      if (change === 'grant-changed') f.changeGrant();
    }
  });
  await expect(f.prepare()).rejects.toThrow();
  expect(f.writes()).not.toContain('PUT:play'); expect(f.writes()).not.toContain('PUT:volume:42');
  expect(f.coldBootstrap).not.toHaveBeenCalled(); expect(f.beforeSelect).not.toHaveBeenCalled();
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it('restores a confirmed paused materialized source after a pre-select read failure, without seeking or selecting it', async () => {
  const f = fixture(); let transferred = false, devices = 0;
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.setState(materializedPausedState(f, otherId)); transferred = true; return new Response(null, { status: 204 });
    }
    if (transferred && init.method === 'GET' && url.pathname.endsWith('/devices') && ++devices === 4)
      return new Response(null, { status: 500 });
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'API_UNAVAILABLE' });
  expect(f.writes()).toEqual(['PUT:volume:0', 'PUT:player', 'PUT:volume:42']);
  expect(f.state()).toMatchObject({ progress_ms: 9000, is_playing: false, item: { uri: `spotify:track:${otherId}` } });
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: false });
  expect(f.beforeSelect).not.toHaveBeenCalled();
});

it('clears a failed mute with no transfer only after stable exact original-volume and actual paused-source proof', async () => {
  const f = fixture(); f.setState(materializedPausedState(f, otherId));
  f.override((url, init) => init.method === 'PUT' && url.pathname.endsWith('/volume')
    ? new Response(null, { status: 204 }) : undefined);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_UNCONFIRMED' });
  expect(f.writes()).toEqual(['PUT:volume:0']);
  expect(f.device.volume_percent).toBe(42); expect(f.state().progress_ms).toBe(9000);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: false });
});

it.each(['transfer', 'volume'])('never restores while an unconfirmed %s request could still arrive', async operation => {
  const f = fixture();
  if (operation === 'volume') f.setState(materializedPausedState(f));
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith(operation === 'transfer' ? '/player' : '/volume')) {
      f.setState(materializedPausedState(f)); f.device.volume_percent = 0;
      return new Promise<Response>(() => {});
    }
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).not.toContain('PUT:volume:42'); expect(f.writes()).not.toContain('PUT:play');
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it.each(['third-volume', 'unknown-volume', 'missing-device', 'inactive-device'])
('retains a witnessed final mute/device conflict even if cleanup reads become clean: %s', async conflict => {
  const f = fixture(); let transferred = false, devices = 0;
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.setState(materializedPausedState(f)); transferred = true; return new Response(null, { status: 204 });
    }
    if (transferred && init.method === 'GET' && url.pathname.endsWith('/devices') && ++devices === 4) {
      const device = { ...f.device };
      if (conflict === 'third-volume') device.volume_percent = 11;
      if (conflict === 'unknown-volume') device.volume_percent = null;
      if (conflict === 'inactive-device') device.is_active = false;
      return Response.json({ devices: conflict === 'missing-device' ? [] : [device] });
    }
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).not.toContain('PUT:volume:42'); expect(f.writes()).not.toContain('PUT:play');
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it('retains an invalid device observation inside the paired proof even if cleanup sees a normal device again', async () => {
  const f = fixture(); let transferred = false, devices = 0;
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.setState(materializedPausedState(f)); transferred = true; return new Response(null, { status: 204 });
    }
    if (transferred && init.method === 'GET' && url.pathname.endsWith('/devices') && ++devices === 2)
      return Response.json({ devices: [{ ...f.device, supports_volume: false }] });
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).not.toContain('PUT:volume:42'); expect(f.writes()).not.toContain('PUT:play');
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it('retains a witnessed baseline play conflict rather than clearing it after a later paused read', async () => {
  const f = fixture(); f.setState(materializedPausedState(f)); let conflictSeen = false;
  f.override((url, init) => {
    if (!conflictSeen && f.device.volume_percent === 0 && init.method === 'GET' && url.pathname.endsWith('/player')) {
      conflictSeen = true; return Response.json({ ...f.state(), is_playing: true });
    }
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0']);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it('rechecks the paused source after the final cleanup device read and before restoring audible volume', async () => {
  const f = fixture(); let transferred = false, devices = 0;
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.setState(materializedPausedState(f)); transferred = true; return new Response(null, { status: 204 });
    }
    if (transferred && init.method === 'GET' && url.pathname.endsWith('/devices')) {
      devices++;
      if (devices === 4) return new Response(null, { status: 500 });
      if (devices === 6) f.state().is_playing = true;
    }
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0', 'PUT:player']);
  expect(f.state().is_playing).toBe(true); expect(f.device.volume_percent).toBe(0);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it('clears only the new unchanged receipt when a source change occurs before any mutation was invoked', async () => {
  const f = fixture(); f.setState(materializedPausedState(f)); let states = 0;
  f.override((url, init) => {
    if (init.method === 'GET' && url.pathname.endsWith('/player') && ++states === 3) f.state().is_playing = true;
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
  expect(f.writes()).toEqual([]); expect(f.device.volume_percent).toBe(42); expect(f.state().is_playing).toBe(true);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: false });
});

it('does not pause a newer requested track during cleanup of a different frozen playing transfer', async () => {
  const f = fixture(); let transferred = false, states = 0;
  f.setState({ ...materializedPausedState(f, otherId), device: { ...f.device, id: 'phone-1', type: 'Smartphone' }, is_playing: true });
  f.device.is_active = false;
  f.override((url, init) => {
    if (init.method === 'PUT' && url.pathname.endsWith('/player')) {
      f.device.is_active = true; f.device.volume_percent = 11; f.state().device = { ...f.device };
      transferred = true; return new Response(null, { status: 204 });
    }
    if (transferred && init.method === 'GET' && url.pathname.endsWith('/player') && ++states === 2)
      f.state().item.uri = `spotify:track:${trackId}`;
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0', 'PUT:player']);
  expect(f.state().is_playing).toBe(true); expect(f.device.volume_percent).toBe(11);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});

it('does not pause an originally paused source that externally resumes after mute', async () => {
  const f = fixture(); f.setState(materializedPausedState(f));
  f.override((url, init) => {
    if (f.device.volume_percent === 0 && init.method === 'GET' && url.pathname.endsWith('/player')) f.state().is_playing = true;
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.writes()).toEqual(['PUT:volume:0']);
  expect(f.state().is_playing).toBe(true); expect(f.device.volume_percent).toBe(0);
  expect(await f.control.inspectColdRecovery()).toMatchObject({ required: true });
});
