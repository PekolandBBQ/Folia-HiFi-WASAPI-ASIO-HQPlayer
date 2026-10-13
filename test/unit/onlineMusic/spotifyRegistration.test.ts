import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/spotifyRegistration.test.ts: actual host registration keeps a single service and private PCM boundary.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(withAppliance = false) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-spotify-registration-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const source = new URL('../../../electron/spotify/service.cjs', import.meta.url), originalRequire = createRequire(source);
    const module = { exports: {} as any };
    vm.runInNewContext(readFileSync(source, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(source.pathname),
        require: (name: string) => name === 'electron' ? { safeStorage: {}, net: { fetch: vi.fn() }, shell: { openExternal: vi.fn() } }
            : name === 'qrcode' ? { toDataURL: vi.fn() } : originalRequire(name), process, Promise, console });
    const handlers = new Map<string, (...args: any[]) => any>(), appHandlers = new Map<string, (...args: any[]) => any>();
    const ipcMain = { handle: vi.fn((name: string, callback: (...args: any[]) => any) => handlers.set(name, callback)) };
    const app = { isPackaged: false, getPath: () => directory, emit: vi.fn(), quit: vi.fn(),
        on: vi.fn((name: string, callback: (...args: any[]) => any) => appHandlers.set(name, callback)) };
    const trusted = { isDestroyed: () => false, send: vi.fn() }, foreign = { isDestroyed: () => false, send: vi.fn() };
    const request = vi.fn(async (input: any) => ({ action: input.action })), close = vi.fn(async () => {}), browserPcm = vi.fn(async () => ({ data: new Uint8Array(8) }));
    const lease = {}; const ownedSoloist = { readFresh: vi.fn(), seekOwnedPaused: vi.fn() }, soloistPcmClient = { dispose: vi.fn() };
    const createService = vi.fn((_parameters: any) => ({ request, close, lookupSoloistPcmSource: () => lease, requestBrowserPcm: browserPcm }));
    const configuration = { ownedSoloist };
    const soloists: any[] = [], createSoloist = vi.fn(() => {
        const value = { getServiceOptions: vi.fn(() => ({ ownedSoloist, soloistPcmClient })), close: vi.fn(async () => {}) };
        soloists.push(value); return value;
    });
    const publicStatus = { hasKey: true, state: 'stopped' };
    const appliance = { getSoloistConfiguration: () => configuration, publicStatus: vi.fn(async () => ({ ...publicStatus })),
        saveKey: vi.fn(async (_value: string) => ({ ...publicStatus })), startSetup: vi.fn(async () => ({ hasKey: true, state: 'pairing-required' })),
        stopSetup: vi.fn(async () => {}), logout: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const runtime = module.exports.registerSpotify({ app, ipcMain, createService, createSoloist,
        ...(withAppliance ? { applianceComposition: appliance } : { soloistConfiguration: configuration }),
        isTrustedSender: (value: any) => value === trusted });
    return { handlers, appHandlers, app, createService, createSoloist, soloist: soloists[0], soloists, appliance, request, close, browserPcm, runtime, trusted, foreign, configuration, ownedSoloist };
}
it('the normal host route uses the one existing service for directory and PCM instead of constructing another account runtime', async () => {
    const f = await fixture(); expect(f.createService).not.toHaveBeenCalled();
    await f.handlers.get('spotify:request')!({ sender: f.trusted }, { action: 'status' });
    await f.handlers.get('spotify:request')!({ sender: f.trusted }, { action: 'search', query: 'test' });
    const pcm = await f.handlers.get('spotify:browser-pcm')!({ sender: f.trusted }, { action: 'pull', session: 'opaque' });
    expect(pcm.data).toHaveLength(8); expect(f.createService).toHaveBeenCalledTimes(1);
    expect(f.createSoloist).toHaveBeenCalledWith({ configuration: f.configuration });
    expect(f.soloist.getServiceOptions).toHaveBeenCalledTimes(1); expect(f.createService.mock.calls[0][0]).toMatchObject({ ownedSoloist: f.ownedSoloist });
    expect(f.request).toHaveBeenCalledTimes(2); expect(f.browserPcm).toHaveBeenCalledOnce();
});

it('playback setup status remains separate from catalog login and rejects foreign or malformed requests before revocation', async () => {
    const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
    expect(await handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'status' })).toEqual({ hasKey: true, state: 'stopped' });
    expect(f.createService).not.toHaveBeenCalled(); expect(f.appliance.startSetup).not.toHaveBeenCalled();
    expect(await handle({ sender: f.foreign }, { action: 'playbackSetup', operation: 'start' })).toHaveProperty('spotifyError');
    expect(await handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'saveKey', keyValue: 'spak_' + 'A'.repeat(129) })).toHaveProperty('spotifyError');
    expect(f.app.emit).not.toHaveBeenCalled(); expect(f.createSoloist).toHaveBeenCalledTimes(1); expect(f.appliance.saveKey).not.toHaveBeenCalled();
});

it('stopping fences new requests until the previous PCM runtime and appliance have stopped, then reconstructs connection state', async () => {
    const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
    await handle({ sender: f.trusted }, { action: 'status' });
    let release!: () => void;
    f.appliance.stopSetup.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'stop' });
    await vi.waitFor(() => expect(f.appliance.stopSetup).toHaveBeenCalledOnce());
    expect(f.close).toHaveBeenCalledOnce(); expect(f.soloist.close).toHaveBeenCalledOnce();
    expect(f.runtime.lookupSoloistPcmSource('old')).toBeNull();
    const search = handle({ sender: f.trusted }, { action: 'search', query: 'after-stop' });
    await Promise.resolve(); expect(f.createService).toHaveBeenCalledTimes(1);
    release(); await stop; await search;
    expect(f.createSoloist).toHaveBeenCalledTimes(2); expect(f.createService).toHaveBeenCalledTimes(2);
    expect(f.soloists[1].getServiceOptions).toHaveBeenCalledOnce();
    expect(f.appliance.logout).not.toHaveBeenCalled();
});

it('key rotation closes the old runtime without logging out the catalog grant and does not echo the key', async () => {
    const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
    await handle({ sender: f.trusted }, { action: 'status' });
    const key = 'spak_' + 'A'.repeat(32);
    const result = await handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'saveKey', keyValue: key });
    expect(f.appliance.saveKey).toHaveBeenCalledWith(key); expect(f.close).toHaveBeenCalledOnce(); expect(f.soloist.close).toHaveBeenCalledOnce();
    expect(f.appliance.logout).not.toHaveBeenCalled(); expect(f.request.mock.calls.map(call => call[0].action)).toEqual(['status']);
    expect(JSON.stringify(result)).not.toContain(key);
});

it('catalog logout disposes cached control ports and logs out the playback appliance before accepting new requests', async () => {
    const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
    await handle({ sender: f.trusted }, { action: 'logout' });
    expect(f.appliance.logout).toHaveBeenCalledOnce(); expect(f.soloist.close).toHaveBeenCalledOnce(); expect(f.createSoloist).toHaveBeenCalledTimes(2);
    await handle({ sender: f.trusted }, { action: 'status' });
    expect(f.createService).toHaveBeenCalledTimes(2); expect(f.soloists[1].getServiceOptions).toHaveBeenCalledOnce();
});

it('setup-only quit releases its receiver even when no catalog service was ever created', async () => {
    const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
    await handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'start', requestId: 'setup' });
    const preventDefault = vi.fn(); f.appHandlers.get('before-quit')!({ preventDefault });
    await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce());
    expect(f.createService).not.toHaveBeenCalled(); expect(f.appliance.close).toHaveBeenCalledOnce(); expect(f.soloist.close).toHaveBeenCalledOnce();
});

it('a later queued stop remains a barrier to catalog requests and setup start', async () => {
    const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
    await handle({ sender: f.trusted }, { action: 'status' });
    let firstRelease!: () => void, secondRelease!: () => void;
    f.appliance.stopSetup.mockImplementationOnce(() => new Promise<void>(resolve => { firstRelease = resolve; }));
    f.appliance.stopSetup.mockImplementationOnce(() => new Promise<void>(resolve => { secondRelease = resolve; }));
    const first = handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'stop' });
    await vi.waitFor(() => expect(f.appliance.stopSetup).toHaveBeenCalledTimes(1));
    const search = handle({ sender: f.trusted }, { action: 'search', query: 'fenced' });
    const start = handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'start', requestId: 'next' });
    const second = handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'stop' });
    firstRelease(); await first;
    await vi.waitFor(() => expect(f.appliance.stopSetup).toHaveBeenCalledTimes(2));
    expect(f.createService).toHaveBeenCalledTimes(1); expect(f.appliance.startSetup).not.toHaveBeenCalled();
    secondRelease(); await second; await search; await start;
    expect(f.appliance.startSetup).toHaveBeenCalledOnce(); expect(f.createService).toHaveBeenCalledTimes(2);
});

it('late catalog and setup results from a revoked connection cannot be returned as successes', async () => {
    const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
    let catalogRelease!: (value: any) => void, startRelease!: (value: any) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { catalogRelease = resolve; }));
    f.appliance.startSetup.mockImplementationOnce(() => new Promise(resolve => { startRelease = resolve; }));
    const catalog = handle({ sender: f.trusted }, { action: 'search', query: 'before-stop' });
    const start = handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'start', requestId: 'old' });
    await vi.waitFor(() => { expect(f.request).toHaveBeenCalledOnce(); expect(f.appliance.startSetup).toHaveBeenCalledOnce(); });
    await handle({ sender: f.trusted }, { action: 'playbackSetup', operation: 'stop' });
    catalogRelease({ action: 'search' }); startRelease({ hasKey: true, state: 'ready' });
    expect(await catalog).toHaveProperty('spotifyError.message', 'Spotify: request-cancelled');
    expect(await start).toHaveProperty('spotifyError.message', 'Spotify: request-cancelled');
});

it('a failed PCM cleanup still releases the receiver on stop or logout and permits a fresh runtime', async () => {
    for (const action of ['stop', 'logout']) {
        const f = await fixture(true), handle = f.handlers.get('spotify:request')!;
        await handle({ sender: f.trusted }, { action: 'status' });
        f.close.mockRejectedValueOnce(new Error('private cleanup failure'));
        const input = action === 'stop' ? { action: 'playbackSetup', operation: 'stop' } : { action: 'logout' };
        expect(await handle({ sender: f.trusted }, input)).toHaveProperty('spotifyError');
        if (action === 'stop') expect(f.appliance.stopSetup).toHaveBeenCalledOnce();
        else expect(f.appliance.logout).toHaveBeenCalledOnce();
        await handle({ sender: f.trusted }, { action: 'status' });
        expect(f.createService).toHaveBeenCalledTimes(2); expect(f.soloists[1].getServiceOptions).toHaveBeenCalledOnce();
    }
});
it('private PCM cannot initialize a service or bypass the actual trusted sender check', async () => {
    const f = await fixture();
    expect(await f.handlers.get('spotify:browser-pcm')!({ sender: f.trusted }, { action: 'begin' })).toHaveProperty('spotifyError');
    expect(f.createService).not.toHaveBeenCalled();
    await f.handlers.get('spotify:request')!({ sender: f.trusted }, { action: 'status' });
    expect(await f.handlers.get('spotify:browser-pcm')!({ sender: f.foreign }, { action: 'pull' })).toHaveProperty('spotifyError');
    expect(f.browserPcm).not.toHaveBeenCalled();
});
it('normal quit awaits the existing service and then closes its unique Soloist runtime once', async () => {
    const f = await fixture(); await f.handlers.get('spotify:request')!({ sender: f.trusted }, { action: 'status' });
    let release!: () => void; f.close.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const preventDefault = vi.fn(); f.appHandlers.get('before-quit')!({ preventDefault }); f.appHandlers.get('before-quit')!({ preventDefault });
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    expect(f.soloist.close).not.toHaveBeenCalled(); expect(f.app.quit).not.toHaveBeenCalled();
    release(); await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledTimes(1));
    expect(f.soloist.close).toHaveBeenCalledTimes(1); expect(preventDefault).toHaveBeenCalledTimes(2);
    f.appHandlers.get('before-quit')!({ preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(f.runtime.lookupSoloistPcmSource('opaque')).toBeNull();
});

it('archived non-cable runtime reports no desktop route owner without constructing its account service', async () => {
    const f = await fixture();
    expect(await f.handlers.get('spotify:request')!({ sender: f.trusted }, { action: 'sourceRevision' })).toEqual({ ownsRoute: false });
    expect(f.createService).not.toHaveBeenCalled();
});
