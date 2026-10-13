import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Client replacement must finish cancelling the previous service before new playback can start.
const { createSpotifyRuntime } = createRequire(import.meta.url)('../../../electron/spotify/runtime.cjs');
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const settings = { mode: 'custom', clientId: 'a'.repeat(32), redirectUri: 'http://127.0.0.1:43821/callback' };
async function fixture(environment = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'folia-spotify-runtime-')); folders.push(directory);
    const services: { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
    const createService = vi.fn(config => {
        const service = { request: vi.fn(async () => config.catalogClientId), close: vi.fn(async () => {}) };
        services.push(service); return service;
    });
    return { directory, services, createService, runtime: createSpotifyRuntime({ directory, environment, createService }) };
}
describe('Spotify configuration lifecycle', () => {
    it('a main PCM lookup never constructs a second service and closes with the existing runtime', async () => {
        const { runtime, services, createService } = await fixture();
        expect(runtime.lookupSoloistPcmSource('http://127.0.0.1/opaque')).toBeNull(); expect(createService).not.toHaveBeenCalled();
        await runtime.request({ action: 'status' });
        const lease = { openReadable: () => {} };
        Object.assign(services[0], { lookupSoloistPcmSource: (url: string) => url === 'http://127.0.0.1/opaque' ? lease : null });
        expect(runtime.lookupSoloistPcmSource('http://127.0.0.1/opaque')).toBe(lease); expect(createService).toHaveBeenCalledOnce();
        await runtime.close(); expect(runtime.lookupSoloistPcmSource('http://127.0.0.1/opaque')).toBeNull();
    });
    it('persists only public fields and waits for old playback cleanup before accepting new requests', async () => {
        const { runtime, services, directory, createService } = await fixture();
        const old = await runtime.request({ action: 'status' });
        let release!: () => void;
        services[0].close.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
        const change = runtime.request({ action: 'configure', settings: { ...settings, clientSecret: 'discard' } });
        await vi.waitFor(() => expect(services[0].close).toHaveBeenCalledOnce());
        const next = runtime.request({ action: 'audio' });
        expect(createService).toHaveBeenCalledOnce();
        release();
        expect(await change).toMatchObject({ changed: true, settings });
        expect(await next).toBe(settings.clientId);
        expect(old).not.toBe(settings.clientId);
        expect(JSON.parse(await readFile(path.join(directory, 'client.json'), 'utf8'))).toEqual({ clientId: settings.clientId, redirectUri: settings.redirectUri });
        await runtime.close();
    });
    it('keeps the active service on identical or invalid edits and recovers its request queue', async () => {
        const { runtime, services } = await fixture();
        await runtime.request({ action: 'configure', settings });
        await runtime.request({ action: 'status' });
        expect(await runtime.request({ action: 'configure', settings })).toMatchObject({ changed: false });
        await expect(runtime.request({ action: 'configure', settings: { ...settings, mode: 'unexpected' } })).rejects.toThrow('invalid-client-mode');
        await expect(runtime.request({ action: 'configure', settings: { ...settings, redirectUri: 'https://example.com' } })).rejects.toThrow('invalid-redirect-uri');
        expect(await runtime.request({ action: 'status' })).toBe(settings.clientId);
        expect(services[0].close).not.toHaveBeenCalled();
        await runtime.close();
        await expect(runtime.request({ action: 'status' })).rejects.toThrow('runtime-closed');
    });
    it('reports environment-managed settings as read-only without saving changes', async () => {
        const { runtime } = await fixture({ FOLIA_SPOTIFY_CLIENT_ID: settings.clientId, FOLIA_SPOTIFY_REDIRECT_URI: settings.redirectUri });
        expect(await runtime.request({ action: 'configuration' })).toMatchObject({ ...settings, readOnly: true });
        await expect(runtime.request({ action: 'configure', settings })).rejects.toThrow('client-settings-managed');
        await runtime.close();
    });
});

it('retains a failed old service across changed and identical settings, without undoing the saved settings', async () => {
  const { runtime, services, createService, directory } = await fixture(); await runtime.request({ action: 'status' });
  const error = Object.assign(new Error('CAPTURE_HELPER_EXIT_UNCONFIRMED'), { code: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  services[0].close.mockRejectedValue(error);
  Object.assign(services[0], { lookupSoloistPcmSource: vi.fn(() => ({})), requestBrowserPcm: vi.fn() });
  await expect(runtime.request({ action: 'configure', settings })).rejects.toBe(error);
  await expect(runtime.request({ action: 'configure', settings })).rejects.toBe(error);
  await expect(runtime.request({ action: 'configure', settings: { mode: 'shared' } })).rejects.toBe(error);
  await expect(runtime.request({ action: 'audio' })).rejects.toBe(error);
  expect(runtime.lookupSoloistPcmSource('opaque')).toBeNull(); expect(() => runtime.requestBrowserPcm({})).toThrow(error);
  expect(await runtime.request({ action: 'configuration' })).toMatchObject(settings);
  expect(JSON.parse(await readFile(path.join(directory, 'client.json'), 'utf8'))).toEqual({ clientId: settings.clientId, redirectUri: settings.redirectUri });
  expect(createService).toHaveBeenCalledOnce(); expect(services[0].request).toHaveBeenCalledOnce();
  const closed = runtime.close(); expect(runtime.close()).toBe(closed); await expect(closed).rejects.toBe(error);
  await expect(runtime.close()).rejects.toBe(error); expect(services[0].close).toHaveBeenCalledTimes(2);
});

it.each([undefined, null, false])('keeps the cleanup barrier after a falsy close rejection: %s', async error => {
  const { runtime, services, createService, directory } = await fixture(); await runtime.request({ action: 'status' });
  const lookup = vi.fn(() => ({})), browser = vi.fn();
  Object.assign(services[0], { lookupSoloistPcmSource: lookup, requestBrowserPcm: browser });
  services[0].close.mockRejectedValue(error);
  await expect(runtime.request({ action: 'configure', settings })).rejects.toBe(error);
  await expect(runtime.request({ action: 'configure', settings })).rejects.toBe(error);
  // A later successful close implementation cannot bypass the latched failure through reconfiguration.
  services[0].close.mockResolvedValue(undefined);
  await expect(runtime.request({ action: 'configure', settings: { mode: 'shared' } })).rejects.toBe(error);
  await expect(runtime.request({ action: 'audio' })).rejects.toBe(error);
  expect(runtime.lookupSoloistPcmSource('opaque')).toBeNull();
  let browserThrew = false, browserError;
  try { runtime.requestBrowserPcm({}); } catch (failure) { browserThrew = true; browserError = failure; }
  expect(browserThrew).toBe(true); expect(browserError).toBe(error);
  expect(lookup).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
  expect(createService).toHaveBeenCalledOnce(); expect(services[0].request).toHaveBeenCalledOnce();
  expect(services[0].close).toHaveBeenCalledOnce();
  expect(await runtime.request({ action: 'configuration' })).toMatchObject(settings);
  expect(JSON.parse(await readFile(path.join(directory, 'client.json'), 'utf8'))).toEqual({ clientId: settings.clientId, redirectUri: settings.redirectUri });
  await runtime.close();
});

it('catalog reconfiguration invalidates the held owner without restoration and replaces it only after a real provider exit', async () => {
    const { runtime, services, createService } = await fixture(); await runtime.request({ action: 'status' });
    const invalidatePlayback = vi.fn(async () => {}), lookup = vi.fn(() => ({}));
    Object.assign(services[0], { invalidatePlayback, lookupSoloistPcmSource: lookup });
    await runtime.request({ action: 'configure', settings });
    expect(invalidatePlayback).toHaveBeenCalledWith('SESSION_CHANGED'); expect(services[0].close).not.toHaveBeenCalled();
    expect(runtime.lookupSoloistPcmSource('owned')).toBeNull();
    await expect(runtime.request({ action: 'audio' })).rejects.toThrow('source-configuration-changed');
    await runtime.leaveProvider();
    expect(services[0].request).toHaveBeenLastCalledWith({ action: 'leaveProvider' });
    expect(services[0].close).toHaveBeenCalledOnce();
    await runtime.request({ action: 'status' }); expect(createService).toHaveBeenCalledTimes(2); await runtime.close();
});
