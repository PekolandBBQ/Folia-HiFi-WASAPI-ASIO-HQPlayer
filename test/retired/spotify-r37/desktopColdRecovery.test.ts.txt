import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// test/unit/onlineMusic/desktopColdRecovery.test.ts: fresh read-only recovery of an unchanged, bounded interruption receipt.
const { createDesktopPlaybackControl } = createRequire(import.meta.url)('../../../electron/spotify/desktopPlaybackControl.cjs');
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp', otherId = '4n4Qqam7vgaVa1iaRUc9Lp';
const session = '12345678-1234-1234-1234-123456789abc';
const receipt = { version: 1, session, deviceId: 'saved-desktop', trackId, originalVolume: 73 };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanups.splice(0)) await action(); });
async function fixture(contents = JSON.stringify(receipt)) {
  const directory = await mkdtemp(join(tmpdir(), 'folia-cold-recovery-')), filename = join(directory, 'cold-volume-recovery.json');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  if (contents) await writeFile(filename, contents);
  let revision = 17, clock = 1000;
  const device: any = { id: receipt.deviceId, type: 'Computer', is_active: true, is_restricted: false, supports_volume: true, volume_percent: 73 };
  const state: any = { device, item: { uri: `spotify:track:${trackId}`, type: 'track', duration_ms: 120000 },
    currently_playing_type: 'track', is_playing: false, progress_ms: 1500, timestamp: 10000, actions: { disallows: {} } };
  let intercept: ((operation: string) => Promise<Response | undefined> | Response | undefined) | undefined;
  const fetcher = vi.fn(async (address: string, init: any) => {
    expect(init.method).toBe('GET');
    const operation = new URL(address).pathname.endsWith('/devices') ? 'devices' : 'state';
    const overridden = await intercept?.(operation); if (overridden) return overridden;
    return Response.json(operation === 'devices' ? { devices: [device] } : state);
  });
  const vault = { token: vi.fn(async () => 'synthetic-new-grant'), stamp: () => ({ epoch: 5, revision }),
    grantedScopes: vi.fn(async () => ({ epoch: 5, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] })) };
  const control = createDesktopPlaybackControl({ coldBootstrapDirectory: directory, vault, fetcher,
    cooldown: { load: async () => 0, defer: async () => 999999 }, now: () => clock,
    wait: async (ms: number) => { clock += ms; }, settleTimeoutMs: 500, settleIntervalMs: 50 });
  cleanups.push(() => control.dispose());
  return { control, filename, directory, state, device, vault, fetcher,
    check: () => control.checkColdRecovery({ deviceId: receipt.deviceId }),
    intercept: (action: typeof intercept) => { intercept = action; }, changeGrant: () => { revision++; } };
}

it('projects only safe original volume/device and clears a restarted receipt after two exact paused readback pairs', async () => {
  const f = await fixture();
  expect(await f.control.inspectColdRecovery()).toEqual({ required: true, recoverable: true, deviceId: receipt.deviceId, originalVolume: 73 });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.vault.token).not.toHaveBeenCalled();
  await expect(f.check()).resolves.toEqual({ required: false, recoverable: false });
  expect(f.vault.grantedScopes).toHaveBeenCalledOnce();
  expect(f.fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/v1/me/player', '/v1/me/player/devices', '/v1/me/player', '/v1/me/player/devices']);
  await expect(readFile(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.control.inspectColdRecovery()).toEqual({ required: false, recoverable: false });
});

it('does nothing when no exceptional receipt exists', async () => {
  const f = await fixture('');
  await expect(f.check()).resolves.toEqual({ required: false, recoverable: false });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.vault.token).not.toHaveBeenCalled();
});

it('uses current authority and stable current paused track, without treating the saved track as old-grant authority', async () => {
  const f = await fixture(); f.state.item.uri = `spotify:track:${otherId}`;
  await expect(f.check()).resolves.toMatchObject({ required: false });
  expect(f.fetcher.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});

it('requires the current saved association to match before reading Spotify', async () => {
  const f = await fixture();
  await expect(f.control.checkColdRecovery({ deviceId: 'other-saved-target' })).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await readFile(f.filename, 'utf8')).toBe(JSON.stringify(receipt));
});

it.each(['volume', 'playing', 'other-device', 'empty204', 'inactive', 'unknown-volume'])('keeps the receipt blocked for %s', async mismatch => {
  const f = await fixture();
  if (mismatch === 'volume') f.device.volume_percent = 72;
  if (mismatch === 'unknown-volume') f.device.volume_percent = null;
  if (mismatch === 'playing') f.state.is_playing = true;
  if (mismatch === 'other-device') f.state.device = { ...f.device, id: 'phone' };
  if (mismatch === 'inactive') f.device.is_active = false;
  if (mismatch === 'empty204') f.intercept(operation => operation === 'state' ? new Response(null, { status: 204 }) : undefined);
  await expect(f.check()).rejects.toThrow();
  expect(await readFile(f.filename, 'utf8')).toBe(JSON.stringify(receipt));
  expect((await f.control.inspectColdRecovery()).required).toBe(true);
});

it.each(['track', 'position', 'playing', 'timestamp', 'grant'])('rejects %s changing between the two observations', async change => {
  const f = await fixture(); let states = 0;
  f.intercept(operation => {
    if (operation === 'state' && ++states === 2) {
      if (change === 'track') f.state.item.uri = `spotify:track:${otherId}`;
      if (change === 'position') f.state.progress_ms++;
      if (change === 'playing') f.state.is_playing = true;
      if (change === 'timestamp') f.state.timestamp--;
      if (change === 'grant') f.changeGrant();
    }
  });
  await expect(f.check()).rejects.toThrow();
  expect(await readFile(f.filename, 'utf8')).toBe(JSON.stringify(receipt));
});

it.each(['bytes', 'identity'])('does not delete a receipt whose %s changed while checking', async change => {
  const f = await fixture(); let states = 0;
  f.intercept(async operation => {
    if (operation === 'state' && ++states === 2) {
      if (change === 'bytes') await writeFile(f.filename, JSON.stringify({ ...receipt, originalVolume: 74 }));
      else {
        await writeFile(f.filename + '.replacement', JSON.stringify(receipt));
        await rename(f.filename + '.replacement', f.filename);
      }
    }
  });
  await expect(f.check()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(JSON.parse(await readFile(f.filename, 'utf8')).originalVolume).toBe(change === 'bytes' ? 74 : 73);
});

it('rechecks file identity after the final asynchronous close before deleting the receipt', async () => {
  const f = await fixture(), io = createRequire(import.meta.url)('node:fs/promises');
  const originalOpen = io.open.bind(io); let reads = 0;
  const opened = vi.spyOn(io, 'open').mockImplementation(async (...args: any[]) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.filename && args[1] === 'r' && ++reads === 2) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); await writeFile(f.filename, JSON.stringify({ ...receipt, originalVolume: 74 })); };
    }
    return handle;
  });
  try {
    await expect(f.check()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    expect(JSON.parse(await readFile(f.filename, 'utf8')).originalVolume).toBe(74);
  } finally { opened.mockRestore(); }
});

it.each(['{invalid', 'x'.repeat(4097), JSON.stringify({ ...receipt, originalVolume: 101 }),
  JSON.stringify({ ...receipt, token: 'not-a-receipt-field' })])('does not inspect or clear an invalid/unbounded receipt case %#', async contents => {
  const f = await fixture(contents);
  expect(await f.control.inspectColdRecovery()).toEqual({ required: true, recoverable: false });
  await expect(f.check()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await readFile(f.filename, 'utf8')).toBe(contents);
});

it('does not follow a symlink as this tool’s recovery receipt', async () => {
  const f = await fixture(''), other = join(f.directory, 'unrelated.json');
  await writeFile(other, JSON.stringify(receipt)); await symlink(other, f.filename);
  expect(await f.control.inspectColdRecovery()).toEqual({ required: true, recoverable: false });
  await expect(f.check()).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await readFile(other, 'utf8')).toBe(JSON.stringify(receipt));
});

it('serializes with concurrent prepare and retains the receipt when the newer intent invalidates a check', async () => {
  const f = await fixture(); let entered!: () => void, resolve!: () => void;
  const reading = new Promise<void>(done => { entered = done; }), pending = new Promise<void>(done => { resolve = done; });
  f.intercept(async operation => { if (operation === 'state') { entered(); await pending; } });
  const check = f.check(), rejectedCheck = expect(check).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await reading;
  const prepare = f.control.prepare({ session, deviceId: receipt.deviceId, trackId, durationMs: 120000 });
  const rejectedPrepare = expect(prepare).rejects.toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
  resolve(); await rejectedCheck; await rejectedPrepare;
  expect(await readFile(f.filename, 'utf8')).toBe(JSON.stringify(receipt));
  expect(f.fetcher).toHaveBeenCalledOnce();
});
