import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Real native IPC controller with fake output/producer boundaries: no Windows, COM or DAC runs here.
const { registerNativeAudio } = createRequire(import.meta.url)('../../../electron/nativeAudio/service.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
const deferred = () => { let resolve!: (value?: unknown) => void;
    const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-output-release-'));
    const app = Object.assign(new EventEmitter(), { getPath: () => directory, quit: vi.fn() });
    const sender = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const source = { sampleRate: 44100, channels: 2, durationMs: 120000, pause: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const otherSource = { ...source, pause: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const helper = { dispose: vi.fn(), request: vi.fn(async (request: any) => request.action === 'hello'
        ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry', 'streaming-pcm-v1'] }
        : { session: request.session, position: 15, duration: 120, playing: false }) };
    const helperEvents: Array<(event: any) => void> = [];
    const helperFactory = vi.fn((_path: string, event: (value: any) => void) => { helperEvents.push(event); return helper; });
    const hq = { checkExisting: vi.fn(async () => {}), prepare: vi.fn(async () => {}), setSilent: vi.fn(),
        supportsStreaming: vi.fn(async () => true), stop: vi.fn(async () => {}), shutdown: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const streams: any[] = [];
    const factory = (options: any) => {
        const stream = { options, prepare: vi.fn(async () => { options.current.loadRequested = true; return { session: options.current.id, position: 15, duration: 120 }; }),
            command: vi.fn(async () => ({ session: options.current.id, position: 15, duration: 120 })), observe: vi.fn(() => true),
            close: vi.fn(async ({ retainSource = false } = {}) => retainSource ? options.source.pause() : options.source.stop()) };
        streams.push(stream); return stream;
    };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    let controller: any;
    try { controller = registerNativeAudio({ app, ipcMain: { handle: vi.fn() }, isTrustedSender: (value: unknown) => value === sender,
        componentManager: { status: async () => ({ available: true, executable: 'fake-helper' }) }, helperFactory,
        hqplayerFactory: () => hq, decoderResolver: async () => 'unused', liveStreamFactory: factory,
        resolveLivePcmSource: (url: string) => url.endsWith('/two') ? otherSource : source }); }
    finally { Object.defineProperty(process, 'platform', platform); }
    const request = (payload: any) => controller.handle({ sender, senderFrame: sender.mainFrame }, payload);
    const begin = (session: string, backend = 'asio', song = 'one') => request({ action: 'begin', session, backend,
        deviceId: backend === 'hqplayer' ? 'hqplayer-local' : 'fake-device', url: `http://127.0.0.1/${song}`, trackKey: `online:spotify:${song}` });
    const load = async (session: string, backend = 'asio', song = 'one') => { await begin(session, backend, song); await request({ action: 'finish', session }); };
    cleanups.push(async () => { source.stop.mockResolvedValue(undefined); otherSource.stop.mockResolvedValue(undefined); hq.stop.mockResolvedValue(undefined); hq.shutdown.mockResolvedValue(undefined);
        app.emit('before-quit', { preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 10)); await rm(directory, { recursive: true, force: true }); });
    return { controller, app, sender, source, otherSource, helper, helperFactory, helperEvents, hq, streams, request, begin, load };
}
it('same-source output handoff pauses its reader while different track replacement retires that reader', async () => {
    const f = await fixture(); await f.load('first'); await f.load('second', 'wasapi-exclusive');
    expect(f.streams[0].close).toHaveBeenCalledWith({ retainSource: true }); expect(f.source.stop).not.toHaveBeenCalled();
    await f.load('third', 'asio', 'two'); expect(f.streams[1].close).toHaveBeenCalledWith({ retainSource: false });
    expect(f.source.stop).toHaveBeenCalledOnce();
});
it('failed source restoration prevents new output and remains retryable by the original owner', async () => {
    const f = await fixture(); await f.load('first');
    f.source.stop.mockRejectedValue(Object.assign(new Error('Spotify: automatic-route-restore-unconfirmed'), { code: 'unavailable' }));
    await expect(f.request({ action: 'stop', session: 'first' })).rejects.toMatchObject({ code: 'SOURCE_RESTORE_UNCONFIRMED' });
    await expect(f.begin('second')).rejects.toMatchObject({ code: 'SOURCE_RESTORE_UNCONFIRMED' });
    expect(f.streams).toHaveLength(1);
    f.source.stop.mockResolvedValue(undefined); await f.request({ action: 'stop', session: 'first' });
    await f.load('third'); expect(f.streams).toHaveLength(2);
});
it('output release failure does not masquerade as successful source restoration', async () => {
    const f = await fixture(); await f.load('first', 'hqplayer');
    f.hq.stop.mockRejectedValue({ code: 'HQPLAYER_COMMAND_REJECTED' });
    await expect(f.request({ action: 'stop', session: 'first' })).rejects.toMatchObject({ code: 'HQPLAYER_COMMAND_REJECTED' });
    expect(f.source.stop).toHaveBeenCalledOnce();
    await expect(f.begin('second')).rejects.toMatchObject({ code: 'HQPLAYER_COMMAND_REJECTED' });
    f.hq.stop.mockResolvedValue(undefined); await f.request({ action: 'stop', session: 'first' }); await f.load('third');
});
it('retained reader after lazy paused output change is stopped without preparing new output', async () => {
    const f = await fixture(); await f.load('first'); await f.request({ action: 'stop', session: 'first', reason: 'handoff' });
    expect(f.source.stop).not.toHaveBeenCalled(); expect(f.source.pause).toHaveBeenCalledOnce();
    await f.request({ action: 'stop', session: 'first' }); expect(f.source.stop).toHaveBeenCalledOnce(); expect(f.streams).toHaveLength(1);
});
it('stale owner Stop cannot restore the same source after ownership transfers to new output', async () => {
    const f = await fixture(); await f.load('first'); await f.request({ action: 'stop', session: 'first', reason: 'handoff' });
    await f.load('second', 'wasapi-exclusive'); await f.request({ action: 'stop', session: 'first' });
    expect(f.source.stop).not.toHaveBeenCalled(); expect(f.streams[1].close).not.toHaveBeenCalled();
});
it('Quit with a retained route blocks on failed restoration and retries rather than falsely exiting', async () => {
    const f = await fixture(); await f.load('first'); await f.request({ action: 'stop', session: 'first', reason: 'handoff' });
    f.source.stop.mockRejectedValue(Object.assign(new Error('Spotify: automatic-route-restore-unconfirmed'), { code: 'unavailable' }));
    f.app.emit('before-quit', { preventDefault() {} }); await vi.waitFor(() => expect(f.source.stop).toHaveBeenCalledOnce());
    expect(f.app.quit).not.toHaveBeenCalled();
    expect(f.sender.send).toHaveBeenCalledWith('native-audio:event', { event: 'lifecycle-error', errorCode: 'SOURCE_RESTORE_UNCONFIRMED' });
    f.source.stop.mockResolvedValue(undefined); f.app.emit('before-quit', { preventDefault() {} });
    await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce()); expect(f.source.stop).toHaveBeenCalledTimes(2);
});
it('new output waits for entire HQ shutdown, including rapid return to HQ before it acknowledges', async () => {
    const f = await fixture(); await f.load('first', 'hqplayer'); const gate = deferred(); f.hq.shutdown.mockImplementation(() => gate.promise as Promise<void>);
    const shutdown = f.request({ action: 'hqplayer-shutdown', reason: 'handoff' });
    await vi.waitFor(() => expect(f.hq.shutdown).toHaveBeenCalledOnce());
    const returning = f.begin('returning', 'hqplayer'); await Promise.resolve(); await Promise.resolve();
    expect(f.hq.prepare).toHaveBeenCalledOnce(); expect(f.source.stop).not.toHaveBeenCalled();
    gate.resolve(); await shutdown; await returning; expect(f.hq.prepare).toHaveBeenCalledTimes(2);
});
it('a rejected HQ shutdown prevents begin until an explicit shutdown retry succeeds', async () => {
    const f = await fixture(); await f.load('first', 'hqplayer'); f.hq.shutdown.mockRejectedValue({ code: 'HQPLAYER_CONTROL_UNAVAILABLE' });
    await expect(f.request({ action: 'hqplayer-shutdown', reason: 'handoff' })).rejects.toMatchObject({ code: 'HQPLAYER_CONTROL_UNAVAILABLE' });
    await expect(f.begin('second', 'asio')).rejects.toMatchObject({ code: 'HQPLAYER_CONTROL_UNAVAILABLE' });
    f.hq.shutdown.mockResolvedValue(undefined); await f.request({ action: 'hqplayer-shutdown', reason: 'handoff' }); await f.load('third');
});


it('helper replacement waits for owned old exit, and an old late event cannot invalidate new helper readiness', async () => {
    const f = await fixture(); await f.request({ action: 'devices' });
    const gate = deferred(); Object.assign(f.helper, { waitForExit: vi.fn(() => gate.promise) });
    f.helperEvents[0]({ event: 'error', errorCode: 'COMPONENT_TIMEOUT' });
    const replacement = { ...f.helper, request: vi.fn(f.helper.request.getMockImplementation()!), waitForExit: vi.fn(async () => {}) };
    f.helperFactory.mockImplementationOnce((_path, event) => { f.helperEvents.push(event); return replacement; });
    const pending = f.request({ action: 'devices' }); await Promise.resolve();
    expect(f.helperFactory).toHaveBeenCalledOnce(); expect(f.helper.dispose).toHaveBeenCalledOnce();
    gate.resolve(); await pending; expect(f.helperFactory).toHaveBeenCalledTimes(2);
    f.helperEvents[0]({ event: 'error', errorCode: 'COMPONENT_CRASHED' });
    await f.request({ action: 'devices' }); expect(f.helperFactory).toHaveBeenCalledTimes(2);
});

it('a known failed stream handoff requires full source cleanup instead of retaining its revoked route', async () => {
    const f = await fixture(); await f.load('first');
    f.streams[0].options.onError({ code: 'SOURCE_UNAVAILABLE' });
    f.source.pause.mockRejectedValue({ code: 'SOURCE_UNAVAILABLE' });
    await expect(f.request({ action: 'stop', session: 'first', reason: 'handoff' })).resolves.toEqual({ ok: true });
    expect(f.source.pause).not.toHaveBeenCalled(); expect(f.source.stop).toHaveBeenCalledOnce();
    expect(f.streams[0].close).toHaveBeenCalledWith({ retainSource: false });
    await f.request({ action: 'stop', session: 'first' }); expect(f.source.stop).toHaveBeenCalledOnce();
    await f.load('second', 'wasapi-exclusive');
});

it('handoff after an unreported resume failure accepts only acknowledged full source restoration', async () => {
    const f = await fixture(); await f.load('first');
    f.source.pause.mockRejectedValue(Object.assign(new Error('Spotify: cable-preparation-failed'), { code: 'unavailable' }));
    const gate = deferred(); f.source.stop.mockImplementation(() => gate.promise as Promise<void>);
    let released = false;
    const handoff = f.request({ action: 'stop', session: 'first', reason: 'handoff' }).then(() => { released = true; });
    await vi.waitFor(() => expect(f.source.stop).toHaveBeenCalledOnce());
    const next = f.begin('second', 'wasapi-exclusive'); await Promise.resolve();
    expect(released).toBe(false); expect(f.streams).toHaveLength(1);
    gate.resolve(); await handoff; await next;
    expect(f.streams[0].close.mock.calls.map(([options]: any[]) => options.retainSource)).toEqual([true, false]);
    await f.request({ action: 'stop', session: 'first' }); expect(f.source.stop).toHaveBeenCalledOnce();
});

it('failed retained-source pause cannot clear an unconfirmed full-restoration barrier', async () => {
    const f = await fixture(); await f.load('first');
    f.source.pause.mockRejectedValue({ code: 'SOURCE_UNAVAILABLE' });
    f.source.stop.mockRejectedValue(Object.assign(new Error('Spotify: automatic-route-restore-unconfirmed'), { code: 'unavailable' }));
    await expect(f.request({ action: 'stop', session: 'first', reason: 'handoff' })).rejects.toMatchObject({ code: 'SOURCE_RESTORE_UNCONFIRMED' });
    await expect(f.begin('second', 'wasapi-exclusive')).rejects.toMatchObject({ code: 'SOURCE_RESTORE_UNCONFIRMED' });
    expect(f.streams).toHaveLength(1);
    f.source.stop.mockResolvedValue(undefined);
    await expect(f.request({ action: 'stop', session: 'first' })).resolves.toMatchObject({ ok: true });
    await f.load('third', 'wasapi-exclusive'); expect(f.streams).toHaveLength(2);
});

it('provider exit defers only failed source retirement until final native recovery, after proving old output stopped', async () => {
    const f = await fixture(); await f.load('first');
    f.source.stop.mockRejectedValue(Object.assign(new Error('Spotify: automatic-route-restore-unconfirmed'), { code: 'unavailable' }));
    const receipt = await f.controller.releaseProviderOutput();
    expect(receipt.complete).toEqual(expect.any(Function));
    expect(f.helper.request).toHaveBeenCalledWith({ action: 'stop', session: 'first' });
    await expect(f.begin('new')).rejects.toMatchObject({ code: 'SOURCE_RESTORE_UNCONFIRMED' });
    // The source owner permits this only after its exact native restore receipt.
    f.source.stop.mockResolvedValue(undefined); await receipt.complete(); await f.begin('after-restore');
});
it('provider exit never defers an unconfirmed native output stop', async () => {
    const f = await fixture(); await f.load('first', 'hqplayer');
    f.hq.stop.mockRejectedValue({ code: 'HQPLAYER_COMMAND_REJECTED' });
    await expect(f.controller.releaseProviderOutput()).rejects.toMatchObject({ code: 'HQPLAYER_COMMAND_REJECTED' });
    expect(f.source.stop).not.toHaveBeenCalled();
});
