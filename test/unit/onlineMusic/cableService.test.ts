import { join } from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Service composition keeps existing Web API grants and isolates the Windows capture lifecycle.
const require = createRequire(import.meta.url);
const { createCableSpotifyService, registerCableSpotify } = require('../../../electron/spotify/cableService.cjs');
const { nativeComponentPath } = require('../../../electron/spotify/nativeComponentPath.cjs');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(file => rm(file, { recursive: true, force: true }))); });
it('uses unpacked executable resources for ASAR builds and preserves the private unpacked app layout', () => {
  expect(nativeComponentPath('spotify-route', '/Folia/resources/app.asar')).toBe(join('/Folia/resources', 'app.asar.unpacked/native/spotify-route'));
  expect(nativeComponentPath('spotify-cable', '/Folia/resources/app')).toBe(join('/Folia/resources', 'app/native/spotify-cable'));
  expect(() => nativeComponentPath('../foreign', '/Folia/resources/app')).toThrow();
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-cable-service-')); directories.push(directory);
  const capture = { close: vi.fn(async () => {}), devices: vi.fn() };
  const control = { dispose: vi.fn(async () => {}) };
  const audio = { prepare: vi.fn(async () => ({ playbackTransport: 'cable-pcm' })), lookup: vi.fn(() => null),
    cancel: vi.fn(), invalidate: vi.fn(async () => {}), leaveProvider: vi.fn(async () => {}), isSourceUrl: vi.fn(() => false), clear: vi.fn(async () => {}), close: vi.fn(async () => {}), revokeSession: vi.fn() };
  const setup = { request: vi.fn(async () => ({ backend: 'vb-cable', state: 'stopped' })), clear: vi.fn(),
    close: vi.fn(async () => {}), getSelection: vi.fn() };
  const createCaptureHost = vi.fn((_options: any) => capture), createControl = vi.fn((_options: any) => control),
    createAudio = vi.fn((_options: any) => audio), createSetup = vi.fn((_options: any) => setup);
  const fetcher = vi.fn(async () => { throw new Error('Unexpected external request'); });
  const service = createCableSpotifyService({ directory, safeStorage: {}, fetcher, platform: 'win32',
    helperPath: '/owned/folia-capture.exe', driverDirectory: '/owned/vendor', openPath: vi.fn(), openAuthorization: vi.fn(),
    createCaptureHost, createControl, createAudio, createSetup });
  return { service, directory, capture, control, audio, setup, fetcher, createCaptureHost, createControl, createAudio, createSetup };
}
describe('Windows Spotify cable service composition', () => {
  it('allows catalog account status before driver setup without launching helper or legacy device login', async () => {
    const f = await fixture(); expect(await f.service.request({ action: 'status' })).toBeNull();
    expect(f.capture.devices).not.toHaveBeenCalled(); expect(f.audio.prepare).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.createCaptureHost).toHaveBeenCalledWith(expect.objectContaining({ helperPath: '/owned/folia-capture.exe', platform: 'win32', onDiagnostic: expect.any(Function) }));
    await f.service.close();
  });
  it('routes the real preparation contract to desktop capture and preserves live resolver identity', async () => {
    const f = await fixture(), progress = vi.fn();
    const value = await f.service.request({ action: 'audio', id: 'track', requestId: 'request', quality: 'high' }, progress);
    expect(value.playbackTransport).toBe('cable-pcm'); expect(f.audio.prepare).toHaveBeenCalledWith('track', 'request', progress, 'high');
    f.service.lookupSoloistPcmSource('opaque'); expect(f.audio.lookup).toHaveBeenCalledWith('opaque');
    await f.service.request({ action: 'cancelAudio', requestId: 'request' }); expect(f.audio.cancel).toHaveBeenCalledWith('request');
    await f.service.close();
  });
  it('passes only matching session revocation to the source owner', async () => {
    const f = await fixture(); const callback = f.createControl.mock.calls[0][0].onRevoke;
    callback({ session: 'retired-session', code: 'SUPERSEDED' });
    expect(f.audio.revokeSession).toHaveBeenCalledWith('retired-session', 'SUPERSEDED'); await f.service.close();
  });
  it('setup invalidation revokes current PCM while keeping catalog credentials and hardware untouched', async () => {
    const f = await fixture(); await f.createSetup.mock.calls[0][0].revokePlayback();
    expect(f.audio.invalidate).toHaveBeenCalledWith('SETUP_CHANGED', undefined); expect(f.audio.clear).not.toHaveBeenCalled(); expect(f.capture.close).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled(); await f.service.close();
  });
  it('closes the native helper even if control disposal fails', async () => {
    const f = await fixture(); f.control.dispose.mockRejectedValue(new Error('CONTROL_CLOSE_TEST'));
    await expect(f.service.close()).rejects.toThrow('CONTROL_CLOSE_TEST'); expect(f.capture.close).toHaveBeenCalledTimes(1);
    await expect(f.service.request({ action: 'status' })).rejects.toThrow('runtime-closed');
  });
  it('does not let stale browser/input access create a fresh service for an untrusted sender', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'folia-cable-register-')); directories.push(directory);
    const handlers = new Map<string, Function>(); const createService = vi.fn();
    const app = { getPath: () => directory, on: vi.fn(), emit: vi.fn(), quit: vi.fn() };
    registerCableSpotify({ app, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
      isTrustedSender: () => false, createService, electron: { safeStorage: {}, net: { fetch: vi.fn() }, shell: {} }, platform: 'win32' });
    expect((await handlers.get('spotify:request')!({ sender: {} }, { action: 'playbackSetup', operation: 'openDriver' })).spotifyError.message).toBe('Spotify: untrusted-sender');
    expect((await handlers.get('spotify:browser-pcm')!({ sender: {} }, { action: 'begin' })).spotifyError).toBeTruthy();
    expect(createService).not.toHaveBeenCalled();
  });
});

it('shares pending and failed close results, prioritizing exact helper cleanup uncertainty', async () => {
  const f = await fixture(), error = Object.assign(new Error('CAPTURE_HELPER_EXIT_UNCONFIRMED'), { code: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  let reject!: (error: Error) => void;
  f.capture.close.mockImplementation(() => new Promise<void>((_resolve, failed) => { reject = failed; }));
  f.control.dispose.mockRejectedValue(new Error('CONTROL_CLOSE_TEST'));
  f.audio.close.mockRejectedValue(new Error('AUDIO_CLOSE_TEST'));
  const closed = f.service.close(), duplicate = f.service.close();
  expect(duplicate).toBe(closed); const observed = closed.catch((failure: any) => failure);
  await vi.waitFor(() => expect(f.capture.close).toHaveBeenCalledOnce()); reject(error);
  expect(await observed).toBe(error); await expect(f.service.close()).rejects.toBe(error);
  expect(f.capture.close).toHaveBeenCalledOnce(); expect(f.audio.close).not.toHaveBeenCalled(); expect(f.control.dispose).not.toHaveBeenCalled();
});

it('still attempts helper close after synchronous cleanup exceptions and never reports release on its failure', async () => {
  const f = await fixture(), events: any[] = [];
  const { installPreviewDiagnosticSink } = require('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
  const remove = installPreviewDiagnosticSink({ enabled: () => true,
    record: (type: string, fields: any) => { events.push({ type, fields }); return true; } });
  const error = Object.assign(new Error('CAPTURE_HELPER_EXIT_UNCONFIRMED'), { code: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  f.setup.clear.mockImplementation(() => { throw new Error('PRIVATE_SETUP'); });
  f.audio.close.mockImplementation(() => { throw new Error('PRIVATE_AUDIO'); });
  f.control.dispose.mockImplementation(() => { throw new Error('PRIVATE_CONTROL'); });
  f.capture.close.mockImplementation(() => { throw error; });
  try {
    await expect(f.service.close()).rejects.toBe(error); await expect(f.service.close()).rejects.toBe(error);
    expect(f.capture.close).toHaveBeenCalledOnce(); expect(f.control.dispose).not.toHaveBeenCalled();
    expect(events.some(value => value.fields.errorCode === error.code)).toBe(true);
    expect(events.some(value => value.fields.releaseAcknowledged === true)).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE/);
  } finally { remove(); }
});

it('keeps quit blocked and explains unconfirmed route restoration instead of reporting a successful exit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-route-quit-')); directories.push(directory);
  const handlers = new Map<string, Function>(), lifecycle = new Map<string, Function>();
  const close = vi.fn(async () => { throw Object.assign(new Error(), { code: 'ROUTE_RESTORE_UNCONFIRMED' }); });
  const showMessageBox = vi.fn(async () => ({ response: 0 }));
  const app = { getPath: () => directory, on: (name: string, callback: Function) => lifecycle.set(name, callback), emit: vi.fn(), quit: vi.fn() };
  registerCableSpotify({ app, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    isTrustedSender: () => true, createService: () => ({ request: async () => null, close }),
    electron: { safeStorage: {}, net: { fetch: vi.fn() }, shell: {}, dialog: { showMessageBox } }, platform: 'win32' });
  await handlers.get('spotify:request')!({ sender: {} }, { action: 'status' });
  const preventDefault = vi.fn(); lifecycle.get('before-quit')!({ preventDefault });
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
  expect(preventDefault).toHaveBeenCalledOnce(); expect(app.quit).not.toHaveBeenCalled();
  expect(app.emit).toHaveBeenCalledWith('spotify-route-cleanup-failed', { code: 'ROUTE_RESTORE_UNCONFIRMED' });
});
