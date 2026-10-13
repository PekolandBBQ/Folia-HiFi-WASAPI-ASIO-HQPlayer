import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { audioFixture, requestId, trackId, oldTrack, tick } from './ownedRouteFixture';

// test/unit/onlineMusic/spicetifySource.integration.test.ts: actual shared control/audio/route/service, synthetic desktop authority and native boundaries.
const require = createRequire(import.meta.url);
const { createSharedRouteHarness } = require('../../fixtures/sharedRouteHarness.cjs');
const { createCableSpotifyService } = require('../../../electron/spotify/cableService.cjs');
const { registerSpicetify } = require('../../../electron/spotify/spicetifyRegistration.cjs');
const { assembleSourceService, bindSourceControl } = require('../../../electron/spotify/spicetify/runtime/createSpicetifyService.cjs');
const fixtures: any[] = [];
const create = () => { const fixture: any = audioFixture({ createSourceHarness: createSharedRouteHarness }); fixtures.push(fixture); return fixture; };
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function open(f: any, source: any, positionMs = 0) {
  const opened = await source.openReadable({ positionMs }), reader = opened.stream[Symbol.asyncIterator](), next = reader.next();
  await tick(); const bytes = Buffer.from([7, 0, 0, 0, 8, 0, 0, 0]); f.captures.at(-1).queue.push(bytes);
  expect((await next).value).toEqual(bytes); return { opened, reader };
}
it('desktop commands drive actual PCM owner; Pause/Stop/new-track retain one provider route', async () => {
  const f = create(); await f.sourceHarness.ready;
  const first = await f.prepare(), old = f.audio.lookup(first.url); await open(f, old);
  await old.pause(); expect(f.lease().state).toBe('pausedHeld');
  expect(f.events.filter((x: string) => x === 'route:release')).toHaveLength(0);
  await open(f, old); await old.stop();
  expect(f.events.filter((x: string) => x === 'route:release')).toHaveLength(0);
  const next = await f.audio.prepare(oldTrack, '23456789-1234-1234-1234-123456789abc');
  expect(f.events.filter((x: string) => x === 'route:acquire')).toHaveLength(1);
  expect(f.events.filter((x: string) => x === 'route:rebindPreparedSelection')).toHaveLength(1);
  expect(f.audio.lookup(first.url)).toBeNull();
  await old.stop(); await expect(old.pause()).rejects.toThrow('request-cancelled');
  await open(f, f.audio.lookup(next.url));
  expect(f.sourceHarness.calls.some((x: any) => x.operation === 'select' && x.args[0].uri === `spotify:track:${oldTrack}`)).toBe(true);
  expect(f.fetcher.mock.calls.every((x: any) => new URL(x[0]).pathname.startsWith('/v1/tracks/'))).toBe(true);
  await f.audio.leaveProvider('provider-exit');
  expect(f.events.filter((x: string) => x === 'route:release')).toHaveLength(1);
  expect(f.lease().state).toBe('restored');
  expect(f.sourceHarness.calls.every((x: any) => ['select', 'play', 'pause', 'seek'].includes(x.operation))).toBe(true);
});
it('desktop seeks use fresh PCM readers and cannot revive a retired reader or route', async () => {
  const f = create(); await f.sourceHarness.ready;
  const prepared = await f.prepare(), source = f.audio.lookup(prepared.url), initial = await open(f, source);
  await source.pause(); await source.seek(14000);
  const resumed = await open(f, source, 14000); expect(resumed.opened.positionMs).toBe(14000);
  await expect(initial.reader.next()).rejects.toThrow('request-cancelled');
  expect(f.events.filter((x: string) => x === 'route:acquire')).toHaveLength(1);
  await source.stop(); await f.audio.leaveProvider();
  expect(f.events.filter((x: string) => x === 'route:release')).toHaveLength(1);
});
it('sourceExit restores before reentry and reentry receives a new provider/native session', async () => {
  const f = create(); await f.sourceHarness.ready;
  const first = await f.prepare(), old = f.audio.lookup(first.url), before = f.lease().session;
  await open(f, old); await f.audio.leaveProvider('provider-exit');
  expect(f.lease().state).toBe('restored');
  const second = await f.audio.prepare(trackId, '23456789-1234-1234-1234-123456789abc');
  expect(f.lease().session).not.toBe(before); await old.stop();
  expect(f.lease().state).not.toBe('restored');
  await open(f, f.audio.lookup(second.url)); await f.audio.leaveProvider();
  expect(f.events.filter((x: string) => x === 'route:acquire')).toHaveLength(2);
  expect(f.events.filter((x: string) => x === 'route:release')).toHaveLength(2);
});
it('actual cable service Quit restores the shared source route before desktop transport disposal', async () => {
  const f = create(); await f.sourceHarness.ready;
  const prepared = await f.prepare(); await open(f, f.audio.lookup(prepared.url));
  const directory = mkdtempSync(join(tmpdir(), 'folia-desktop-source-service-'));
  const order: string[] = [], originalDispose = f.control.dispose.bind(f.control);
  const control = { ...f.control, async dispose() { order.push('control:dispose');
    expect(f.lease().state).toBe('restored'); await originalDispose(); f.sourceHarness.close(); } };
  const service = createCableSpotifyService({ directory, platform: 'win32',
    safeStorage: { isEncryptionAvailable: () => false },
    fetcher: async () => { throw new Error('External requests forbidden'); },
    createCaptureHost: () => f.captureHost, createRouteHost: () => f.host, createRouteLifecycle: () => f.route,
    createControl: () => control, createAudio: () => f.audio,
    createSetup: () => ({ getSelection: async () => null, clear() {}, close() {}, request() {} }),
    beforeLeaveProvider: async () => { order.push('output:release'); return { complete: async () => order.push('output:complete') }; },
  });
  try {
    await service.close();
    expect(f.lease().state).toBe('restored'); expect(f.sourceHarness.inspect().closed).toBe(true);
    expect(order).toEqual(['output:release', 'control:dispose', 'output:complete']);
    expect(f.events.filter((x: string) => x === 'route:release')).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('candidate main registration and real runtime route audio to injected private desktop source; Quit restores before disposal', async () => {
  const f = create(); await f.sourceHarness.ready;
  const directory = mkdtempSync(join(tmpdir(), 'folia-desktop-main-')), app: any = new EventEmitter(), handlers = new Map();
  const sender = { isDestroyed: () => false, send() {} }; let exited = false, constructions = 0;
  app.getPath = () => directory;
  app.quit = () => { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); if (!prevented) exited = true; };
  registerSpicetify({ app, platform: 'win32', isTrustedSender: (value: any) => value === sender,
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
    electron: { safeStorage: { isEncryptionAvailable: () => false }, shell: {}, net: { fetch() { throw new Error('No external network'); } } },
    createService: (options: any) => {
      constructions++;
      return assembleSourceService({ ...options,
        createCaptureHost: () => f.captureHost, createRouteHost: () => f.host, createRouteLifecycle: () => f.route,
        createControl: () => bindSourceControl({ source: f.sourceHarness.source, createController: () => f.control, dependencies: {} }),
        createAudio: () => f.audio, createSetup: () => ({ getSelection: async () => null, clear() {}, close() {}, request() {} }),
      });
    } });
  try {
    const prepared = await handlers.get('spotify:request')({ sender }, { action: 'audio', id: trackId, requestId });
    expect(prepared.spotifyError).toBeUndefined(); expect(constructions).toBe(1);
    await open(f, f.audio.lookup(prepared.url)); expect(f.sourceHarness.calls.some((x: any) => x.operation === 'play')).toBe(true);
    app.quit();
    for (let i = 0; i < 100 && !exited; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(exited).toBe(true); expect(f.lease().state).toBe('restored'); expect(f.sourceHarness.inspect().closed).toBe(true);
    expect(f.events.filter((x: string) => x === 'route:release')).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('registered Quit with unconfirmed restoration stays open and retains the desktop source transport', async () => {
  const f = create(); await f.sourceHarness.ready;
  const directory = mkdtempSync(join(tmpdir(), 'folia-desktop-main-failed-')), app: any = new EventEmitter(), handlers = new Map();
  const sender = { isDestroyed: () => false, send() {} }; let exited = false, cleanupFailure: any;
  const request = f.host.request.getMockImplementation();
  f.host.request.mockImplementation(async (command: string, payload: any) => {
    if (command === 'release') throw Object.assign(new Error('Unconfirmed route restoration'), { code: 'ROUTE_RESTORE_UNCONFIRMED' });
    return request(command, payload);
  });
  app.getPath = () => directory;
  app.quit = () => { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); if (!prevented) exited = true; };
  app.on('spotify-route-cleanup-failed', (value: any) => { cleanupFailure = value; });
  registerSpicetify({ app, platform: 'win32', isTrustedSender: (value: any) => value === sender,
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
    electron: { safeStorage: { isEncryptionAvailable: () => false }, shell: {}, net: { fetch() { throw new Error('No external network'); } }, dialog: { showMessageBox: async () => {} } },
    createService: (options: any) => assembleSourceService({ ...options,
      createCaptureHost: () => f.captureHost, createRouteHost: () => f.host, createRouteLifecycle: () => f.route,
      createControl: () => bindSourceControl({ source: f.sourceHarness.source, createController: () => f.control, dependencies: {} }),
      createAudio: () => f.audio, createSetup: () => ({ getSelection: async () => null, clear() {}, close() {}, request() {} }),
    }) });
  try {
    const prepared = await handlers.get('spotify:request')({ sender }, { action: 'audio', id: trackId, requestId });
    expect(prepared.spotifyError).toBeUndefined(); await open(f, f.audio.lookup(prepared.url));
    app.quit();
    for (let i = 0; i < 100 && !cleanupFailure; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(cleanupFailure).toEqual({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
    expect(exited).toBe(false); expect(f.lease().state).not.toBe('restored'); expect(f.sourceHarness.inspect().closed).toBe(false);
    // Unqualified restoration cannot turn into a successful shutdown on a second Quit.
    cleanupFailure = undefined; app.quit();
    for (let i = 0; i < 100 && !cleanupFailure; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(cleanupFailure).toEqual({ code: 'ROUTE_RESTORE_UNCONFIRMED' });
    expect(exited).toBe(false); expect(f.sourceHarness.inspect().closed).toBe(false);
  } finally { f.host.request.mockImplementation(request); rmSync(directory, { recursive: true, force: true }); }
});
