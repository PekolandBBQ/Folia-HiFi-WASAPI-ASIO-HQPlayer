import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/providerLifecycleRegistration.test.ts: actual IPC lifecycle gates, no external services.
const { registerCableSpotify, createCableSpotifyService } = createRequire(import.meta.url)('../../../electron/spotify/cableService.cjs');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function directory() { const value = await mkdtemp(path.join(tmpdir(), 'folia-provider-exit-')); directories.push(value); return value; }
async function fixture() {
  const handlers = new Map<string, Function>();
  const app = Object.assign(new EventEmitter(), { getPath: () => root, quit: vi.fn() });
  const root = await directory();
  const sender = { isDestroyed: () => false, send: vi.fn() };
  const request = vi.fn(async (input: any) => input.action === 'audio' ? { url: 'http://127.0.0.1/owned' } : null);
  const close = vi.fn(async () => {}), prepareSourceOutput = vi.fn(async (_url?: string) => {});
  const createService = vi.fn(() => ({ request, close, prepareSourceOutput }));
  const runtime = registerCableSpotify({ app, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    isTrustedSender: (value: unknown) => value === sender, createService,
    electron: { safeStorage: {}, net: { fetch: vi.fn(() => { throw new Error('Network forbidden'); }) }, shell: {}, dialog: { showMessageBox: vi.fn(async () => {}) } } });
  const invoke = (input: any) => handlers.get('spotify:request')!({ sender }, input);
  return { root, app, request, close, createService, prepareSourceOutput, runtime, invoke };
}
it('leaving an unused provider never creates a Spotify account, helper or service', async () => {
  const f = await fixture();
  const { revision } = await f.invoke({ action: 'sourceRevision' });
  await f.invoke({ action: 'leaveProvider', expectedSourceRevision: revision });
  await f.runtime.prepareSourceOutput('https://example.invalid/music.flac');
  expect(f.createService).not.toHaveBeenCalled();
});
it('old exit revision cannot release a newer Spotify choice, and cancelAudio never exits a provider', async () => {
  const f = await fixture(); await f.invoke({ action: 'audio', id: 'one' });
  const first = await f.invoke({ action: 'sourceRevision' });
  await f.invoke({ action: 'audio', id: 'two' });
  expect(await f.invoke({ action: 'leaveProvider', expectedSourceRevision: first.revision }))
    .toMatchObject({ spotifyError: { message: 'Spotify: request-cancelled' } });
  await f.invoke({ action: 'cancelAudio', requestId: 'old-request' });
  expect(f.request.mock.calls.map(([input]) => input.action)).toEqual(['audio', 'audio', 'cancelAudio']);
});
it('a pending exact exit fences inverse transition until restore settles', async () => {
  const f = await fixture(); await f.invoke({ action: 'audio', id: 'one' });
  const { revision } = await f.invoke({ action: 'sourceRevision' }), gate = deferred();
  f.request.mockImplementation(async input => { if (input.action === 'leaveProvider') await gate.promise; return null; });
  const leave = f.invoke({ action: 'leaveProvider', expectedSourceRevision: revision });
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  const next = f.invoke({ action: 'audio', id: 'two' });
  await Promise.resolve(); expect(f.request).toHaveBeenCalledTimes(2);
  gate.resolve(); await leave; await next;
  expect(f.request.mock.calls.map(([input]) => input.action)).toEqual(['audio', 'leaveProvider', 'audio']);
});
it('concurrent Quit joins the pending provider exit and reports failed restoration honestly', async () => {
  const f = await fixture(); await f.invoke({ action: 'audio', id: 'one' });
  const { revision } = await f.invoke({ action: 'sourceRevision' }), gate = deferred();
  f.request.mockImplementation(async input => { if (input.action === 'leaveProvider') await gate.promise; return null; });
  const leave = f.invoke({ action: 'leaveProvider', expectedSourceRevision: revision });
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  const preventDefault = vi.fn(); f.app.emit('before-quit', { preventDefault }); f.app.emit('before-quit', { preventDefault });
  expect(f.close).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
  gate.resolve(); await leave; await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce());
  expect(f.close).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledTimes(2);
});
it('source-output backstop waits for main-owned cleanup and never interprets a stale Spotify URL as a provider exit', async () => {
  const output = deferred(), restore = deferred(), order: string[] = [];
  const source = {}, audio = { lookup: vi.fn((url: string) => url === 'owned' ? source : null),
    isSourceUrl: (url: string) => ['owned', 'retired'].includes(url), invalidate: vi.fn(async () => {}),
    leaveProvider: vi.fn(async () => { order.push('restore'); await restore.promise; }), clear: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const service = createCableSpotifyService({ directory: await directory(), safeStorage: {},
    fetcher: () => { throw new Error('Network forbidden'); }, platform: 'linux',
    createAudio: () => audio, createControl: () => ({ dispose: vi.fn() }), createCaptureHost: () => ({ close: vi.fn() }),
    createSetup: () => ({ getSelection: vi.fn(), clear: vi.fn(), close: vi.fn() }),
    createRouteHost: () => ({}), createRouteLifecycle: () => ({ releaseBeforeClose: vi.fn(), captureHelperExited: vi.fn(), close: vi.fn() }),
    beforeLeaveProvider: async () => { order.push('output'); await output.promise; } });
  await service.prepareSourceOutput('owned'); expect(order).toEqual([]);
  await expect(service.prepareSourceOutput('retired')).rejects.toThrow('request-cancelled'); expect(order).toEqual([]);
  let settled = false; const leaving = service.prepareSourceOutput('https://example.invalid/other.flac').then(() => { settled = true; });
  await Promise.resolve(); expect(order).toEqual(['output']); expect(settled).toBe(false);
  output.resolve(); await vi.waitFor(() => expect(order).toEqual(['output', 'restore'])); expect(settled).toBe(false);
  restore.resolve(); await leaving; expect(settled).toBe(true); await service.close();
});
it('route cleanup errors remain actionable public errors and block new native output', async () => {
  const f = await fixture(); await f.invoke({ action: 'audio', id: 'one' });
  const error = Object.assign(new Error('private diagnostic'), { code: 'ROUTE_RESTORE_UNCONFIRMED' });
  f.request.mockRejectedValueOnce(error);
  const { revision } = await f.invoke({ action: 'sourceRevision' });
  expect(await f.invoke({ action: 'leaveProvider', expectedSourceRevision: revision }))
    .toMatchObject({ spotifyError: { code: 'unavailable', message: 'Spotify: automatic-route-restore-unconfirmed',
      nativeCode: 'ROUTE_RESTORE_UNCONFIRMED', stage: 'leaveProvider', detail: 'Spotify 原输出路由尚未确认恢复；已保留原路由记录以供继续恢复。' } });
  f.prepareSourceOutput.mockRejectedValue(error);
  await expect(f.runtime.prepareSourceOutput()).rejects.toBe(error);
});

it('Quit retries an exact output-cleanup failure before touching the provider route or capture helper', async () => {
  const beforeLeaveProvider = vi.fn(async () => {});
  beforeLeaveProvider.mockRejectedValueOnce({ code: 'HQPLAYER_COMMAND_REJECTED' });
  const audio = { clear: vi.fn(async () => {}), close: vi.fn(async () => {}) }, capture = { close: vi.fn(async () => {}) };
  const service = createCableSpotifyService({ directory: await directory(), safeStorage: {},
    fetcher: () => { throw new Error('Network forbidden'); }, platform: 'linux', beforeLeaveProvider,
    createAudio: () => audio, createControl: () => ({ dispose: vi.fn() }), createCaptureHost: () => capture,
    createSetup: () => ({ getSelection: vi.fn(), clear: vi.fn(), close: vi.fn() }),
    createRouteHost: () => ({}), createRouteLifecycle: () => ({ releaseBeforeClose: vi.fn(), captureHelperExited: vi.fn(), close: vi.fn() }) });
  await expect(service.close()).rejects.toMatchObject({ code: 'ROUTE_SOURCE_PAUSE_UNCONFIRMED' });
  expect(audio.clear).not.toHaveBeenCalled(); expect(capture.close).not.toHaveBeenCalled();
  await service.close(); expect(beforeLeaveProvider).toHaveBeenCalledTimes(2); expect(capture.close).toHaveBeenCalledOnce();
});
