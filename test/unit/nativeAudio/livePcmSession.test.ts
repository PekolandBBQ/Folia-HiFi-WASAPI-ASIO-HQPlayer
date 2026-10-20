import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import net from 'node:net';
import { once } from 'node:events';

// test/unit/nativeAudio/livePcmSession.test.ts — real output sockets, cancellable PCM producers and playback generations.
const { createLivePcmSession } = createRequire(import.meta.url)('../../../electron/nativeAudio/livePcmSession.cjs');
const { LIVE_PCM_TRANSPORT } = createRequire(import.meta.url)('../../../electron/nativeAudio/livePcmFormat.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
const deferred = <T = void>() => {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

async function fixture({ finiteFirst = false, emptyFirst = false, hq = false, malformedTransport = false, actualHQ = false } = {}) {
    const connections: Array<{ socket: net.Socket; chunks: Buffer[] }> = [];
    const server = net.createServer(socket => {
        const connection = { socket, chunks: [] as Buffer[] }; connections.push(connection);
        socket.on('data', bytes => connection.chunks.push(Buffer.from(bytes))); socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address() as net.AddressInfo;
    const current = { id: 'live-test', abort: new AbortController(), backend: hq ? 'hqplayer' : 'asio', deviceId: 'test',
        durationHint: 120, sourceMetadata: { preparedAudio: { representation: 's32le', sampleRate: 44100, channels: 2 } } };
    let generation = 0, position = 0, playing = false;
    const helper = { close: vi.fn(async () => {}), request: vi.fn(async (request: any) => {
        if (request.action === 'stream-load' || request.action === 'stream-reset') {
            ++generation; position = request.position; playing = false;
        }
        if (request.action === 'play') playing = true;
        if (request.action === 'pause' || request.action === 'stream-retire') playing = false;
        const received = connections[generation - 1]?.chunks.reduce((sum, bytes) => sum + bytes.length, 0) || 0;
        return { session: current.id, streaming: true, streamGeneration: generation, position, duration: 120,
            playing, ended: false, bufferedStart: position, bufferedEnd: position + received / (44100 * 8), producerComplete: false };
    }) };
    const readers: Array<{ positionMs: number; signal: AbortSignal; finished: boolean; release: ReturnType<typeof deferred<void>> }> = [];
    let latestReader: any, parkedReader: any;
    const source = { sampleRate: 44100, channels: 2, durationMs: 120000,
        assertReader: vi.fn((opened: any) => {
            if (opened !== latestReader || opened === parkedReader) throw Object.assign(new Error('stale'), { code: 'CANCELLED' });
            readers.at(-1)!.signal.throwIfAborted();
        }),
        beginPlayingSeek: vi.fn((_input: any) => { parkedReader = latestReader; return { cancel: vi.fn(async () => {}) }; }),
        pause: vi.fn(async () => {}), openReadable: vi.fn(async ({ positionMs, signal }: any) => {
            const reader = { positionMs, signal, finished: false, release: deferred() }; readers.push(reader);
            latestReader = Object.freeze({ positionMs, transport: Object.freeze({ ...LIVE_PCM_TRANSPORT,
                ...(malformedTransport ? { sampleFormat: 'f32le' } : {}) }), stream: (async function* () {
                try {
                    if (emptyFirst && readers.length === 1) return;
                    yield Buffer.alloc(16, readers.length);
                    if (finiteFirst && readers.length === 1) return;
                    await new Promise<void>((resolve, reject) => {
                        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
                        reader.release.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); }, reject);
                        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
                    });
                } finally { reader.finished = true; }
            })() }); return latestReader;
        }) };
    const progress = vi.fn(), onError = vi.fn();
    let outputHelper = helper;
    if (actualHQ) {
        const { createHQPlayerStreamAdapter } = createRequire(import.meta.url)('../../../electron/nativeAudio/hqplayerStreamAdapter.cjs');
        Object.assign(current, { livePcmSource: source });
        const status = async () => { const state = await helper.request({ action: 'status' });
            return { state, generation: state.streamGeneration, ready: true, position0: state.position,
                bufferedSeconds: state.bufferedEnd - state.position }; };
        const hqplayer = {
            streamPrepare: async (request: any) => { await helper.request({ action: 'stream-load', position: request.position0 }); return status(); },
            streamReset: async (request: any) => { await helper.request({ action: 'stream-reset', position: request.position0 }); return status(); },
            streamStatus: status, streamClose: async () => {},
            command: async (_id: string, action: string) => helper.request({ action }),
        };
        const adapter = createHQPlayerStreamAdapter({ current, hqplayer });
        outputHelper = { ...adapter, request: vi.fn(adapter.request), close: vi.fn(adapter.close) };
    }
    const session = createLivePcmSession({ current, source, helper: outputHelper, progress, onError,
        assertCurrent: () => current.abort.signal.throwIfAborted(), prebufferSeconds: 0.00002,
        connectPipe: () => net.createConnection({ host: '127.0.0.1', port: address.port, allowHalfOpen: true }) });
    cleanups.push(async () => {
        current.abort.abort(); for (const reader of readers) reader.release.resolve();
        await session.close(); for (const connection of connections) connection.socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return { session, source, helper, outputHelper, current, readers, connections, progress, onError };
}

it('closes its pipe/output on provider exit without sending another remote pause after private capture acknowledgement',async()=>{
    const f=await fixture();await f.session.prepare();
    Object.assign(f.source,{detachOutputForProviderExit:()=>true});
    f.source.pause.mockRejectedValueOnce(Error('Remote phone must not be paused'));
    await expect(f.session.close({providerExit:true})).resolves.toBeUndefined();
    expect(f.source.pause).not.toHaveBeenCalled();expect(f.readers[0].finished).toBe(true);
});
it('retires old HQ audio before waiting for remote seek and resets only with the fresh reader descriptor', async () => {
    const f = await fixture({ hq: true }); await f.session.prepare(); await f.session.command('play');
    const first = f.helper.request.mock.calls.find(([request]) => request.action === 'stream-load')![0].livePcmReader;
    const gate = deferred(), original = f.source.openReadable.getMockImplementation()!;
    f.source.openReadable.mockImplementationOnce(async args => { await gate.promise; return original(args); });
    const seeking = f.session.command('seek', { position: 12 });
    await vi.waitFor(() => expect(f.helper.request.mock.calls.some(([request]) => request.action === 'stream-retire')).toBe(true));
    expect(f.readers[0].signal.aborted).toBe(true);
    expect(f.helper.request.mock.calls.some(([request]) => request.action === 'stream-reset')).toBe(false);
    expect(f.connections).toHaveLength(1);
    gate.resolve(); expect(await seeking).toMatchObject({ position: 12, playing: true, streamGeneration: 2 });
    const second = f.helper.request.mock.calls.find(([request]) => request.action === 'stream-reset')![0].livePcmReader;
    expect(second).not.toBe(first); expect(second.transport).toEqual(LIVE_PCM_TRANSPORT);
    expect(Buffer.concat(f.connections[0].chunks)).toEqual(Buffer.alloc(16, 1));
    expect(Buffer.concat(f.connections[1].chunks)).toEqual(Buffer.alloc(16, 2));
});

it('sends zero PCM and opens no output for a malformed normal-HQ reader descriptor', async () => {
    const f = await fixture({ hq: true, malformedTransport: true });
    await expect(f.session.prepare()).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    expect(f.connections).toEqual([]); expect(f.helper.request).not.toHaveBeenCalled();
});

it('opens no pipe and yields zero bytes if stopped during HQ output preparation', async () => {
    const f = await fixture({ hq: true }), output = deferred<any>(), original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(request => request.action === 'stream-load' ? output.promise : original(request));
    const loading = f.session.prepare(), rejected = expect(loading).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.helper.request.mock.calls.some(([request]) => request.action === 'stream-load')).toBe(true));
    f.current.abort.abort(); output.resolve({ streamGeneration: 1 }); await rejected;
    expect(f.connections).toEqual([]); expect(f.session.source.state.available).toBe(0);
});

it('retains the source checkpoint when handoff closes initial preparation before any native position exists', async () => {
    const f = await fixture({ hq: true }), output = deferred<any>(), original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(request => request.action === 'stream-load' ? output.promise : original(request));
    const loading = f.session.prepare(37), rejected = expect(loading).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.helper.request.mock.calls.some(([request]) => request.action === 'stream-load')).toBe(true));
    expect(f.readers[0].positionMs).toBe(37000);
    const closing = f.session.close({ retainSource: true });
    await vi.waitFor(() => expect(f.source.pause).toHaveBeenCalled());
    expect(f.source.pause.mock.calls[0]).toEqual([]);
    output.resolve({ streamGeneration: 1 }); await rejected; await closing;
    expect(f.connections).toEqual([]); expect(f.session.source.state.available).toBe(0);
});

it('suspends actual PCM on pause, keeps paused seeks parked and resumes using a new output generation', async () => {
    const f = await fixture();
    const loaded = await f.session.prepare(); expect(loaded.streamGeneration).toBe(1);
    await f.session.command('play');
    const paused = await f.session.command('pause');
    expect(paused).toMatchObject({ position: 0, playing: false, buffering: false, bufferedEnd: 0 });
    expect(f.readers[0].signal.aborted).toBe(true); expect(f.readers[0].finished).toBe(true);
    const shortPipeEof = { ...paused, duration: 0.45, ended: true, producerComplete: true };
    expect(f.session.observe(shortPipeEof)).toBe(false);
    expect(paused).toMatchObject({ duration: 120, ended: false, producerComplete: false });
    const parked = await f.session.command('seek', { position: 35 });
    expect(parked).toMatchObject({ position: 35, playing: false, bufferedStart: 35, bufferedEnd: 35 });
    expect(f.source.openReadable).toHaveBeenCalledTimes(1);
    const resumed = await f.session.command('play');
    expect(resumed).toMatchObject({ position: 35, playing: true, streamGeneration: 2 });
    expect(f.readers[1].positionMs).toBe(35000); expect(f.readers[1].signal.aborted).toBe(false);
    expect(Buffer.concat(f.connections[0].chunks)).toEqual(Buffer.alloc(16, 1));
    expect(Buffer.concat(f.connections[1].chunks)).toEqual(Buffer.alloc(16, 2));
    expect(f.session.observe({ streaming: true, streamGeneration: 1, position: 80, playing: true })).toBe(false);
    expect(f.onError).not.toHaveBeenCalled();
});

it('rejects a live producer which reaches EOF without delivering any PCM frame', async () => {
    const f = await fixture({ emptyFirst: true });
    await expect(f.session.prepare()).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    expect(f.session.source.state).toEqual({ complete: false, available: 0, live: true });
    expect(f.readers[0].finished).toBe(true); expect(f.onError).not.toHaveBeenCalled();
    expect(Buffer.concat(f.connections[0]?.chunks || [])).toHaveLength(0);
});

it.each([['CONTROL_FAILED', 'SOURCE_UNAVAILABLE'], ['AUTH_REQUIRED', 'SOURCE_UNAVAILABLE'], ['PCM_INTERRUPTED', 'SOURCE_UNAVAILABLE'],
    ['TRACK_NOT_CURRENT', 'SOURCE_EXPIRED'], ['STALE_SESSION', 'SOURCE_EXPIRED'], ['SUPERSEDED', 'SOURCE_EXPIRED'],
    ['HQPLAYER_COMMAND_REJECTED', 'HQPLAYER_COMMAND_REJECTED'], ['DEVICE_UNAVAILABLE', 'DEVICE_UNAVAILABLE']])
('distinguishes %s from a driver failure using the public %s code', async (originalCode, publicCode) => {
    const f = await fixture(); const original = Object.assign(new Error('arbitrary_private_source_response'), { code: originalCode });
    f.source.openReadable.mockRejectedValueOnce(original);
    const failed = f.session.prepare();
    await expect(failed).rejects.toMatchObject({ code: publicCode });
    if (originalCode !== publicCode) await expect(failed).rejects.not.toHaveProperty('message', original.message);
    else await expect(failed).rejects.toBe(original);
    expect(f.onError).not.toHaveBeenCalled();
});

it('maps a late actual PCM producer error to the source failure callback without exposing its raw response', async () => {
    const f = await fixture(); await f.session.prepare(); await f.session.command('play');
    f.readers[0].release.reject(Object.assign(new Error('arbitrary_private_response'), { code: 'CONTROL_FAILED' }));
    await vi.waitFor(() => expect(f.onError).toHaveBeenCalledOnce());
    expect(f.onError.mock.calls[0][0]).toMatchObject({ code: 'SOURCE_UNAVAILABLE', message: 'Live PCM source failed (CONTROL_FAILED)' });
    expect(f.session.source.state.complete).toBe(false);
});

it('a playing seek replaces the old reader and preserves play intent without leaking old PCM', async () => {
    const f = await fixture(); await f.session.prepare(); await f.session.command('play');
    expect(await f.session.command('seek', { position: 22 })).toMatchObject({ position: 22, playing: true, streamGeneration: 2 });
    expect(f.readers[0].finished).toBe(true); expect(f.readers[0].signal.aborted).toBe(true);
    expect(f.readers[1].positionMs).toBe(22000); expect(f.onError).not.toHaveBeenCalled();
});

it('resets source completion and byte accounting when seeking after a completed producer', async () => {
    const f = await fixture({ finiteFirst: true }); await f.session.prepare();
    await vi.waitFor(() => expect(f.session.source.state.complete).toBe(true));
    await f.session.command('play');
    await f.session.command('seek', { position: 12 });
    expect(f.session.source.state).toMatchObject({ complete: false, available: 16 });
    expect(f.readers[1].signal.aborted).toBe(false);
});

it('replays from zero through a fresh output pipe after finite PCM and the current device EOF', async () => {
    const f = await fixture({ finiteFirst: true }); const first = await f.session.prepare();
    await vi.waitFor(() => expect(f.session.source.state.complete).toBe(true));
    await f.session.command('play');
    // The producer has reached actual socket EOF. Playback ends only after the
    // current device generation reports its buffered frames consumed.
    expect(f.readers[0].finished).toBe(true);
    expect(Buffer.concat(f.connections[0].chunks)).toEqual(Buffer.alloc(16, 1));
    const deviceEof = { ...first, streamGeneration: 1, streaming: true, position: 120, duration: 120,
        bufferedStart: 120, bufferedEnd: 120, producerComplete: true, playing: false, ended: true };
    expect(f.session.observe(deviceEof)).toBe(true);
    const replayed = await f.session.command('play');
    expect(replayed).toMatchObject({ position: 0, playing: true, streamGeneration: 2, duration: 120 });
    expect(f.readers[1].positionMs).toBe(0); expect(f.readers[1].signal.aborted).toBe(false);
    expect(f.session.source.state).toMatchObject({ complete: false, available: 16 });
    expect(Buffer.concat(f.connections[1].chunks)).toEqual(Buffer.alloc(16, 2));
    expect(f.session.observe(deviceEof)).toBe(false); expect(f.onError).not.toHaveBeenCalled();
});

it('capture EOF leaves HQPlayer playing through its buffered tail and reports drained only on current output EOF', async () => {
    const info = vi.spyOn(console,'info').mockImplementation(()=>{});
    const f = await fixture({finiteFirst:true,hq:true}); const first = await f.session.prepare();
    await vi.waitFor(()=>expect(f.session.source.state.complete).toBe(true)); await f.session.command('play');
    const tail = {...first,streaming:true,streamGeneration:1,position:114,duration:120,bufferedEnd:120,
        producerComplete:true,playing:true,ended:false,latency:5.5};
    expect(f.session.observe(tail)).toBe(true);
    expect(f.source.pause).not.toHaveBeenCalled();
    expect(f.helper.request.mock.calls.some(([r])=>r.action==='stop')).toBe(false);
    expect(f.readers[0].signal.aborted).toBe(false);
    expect(info.mock.calls.some(([tag,raw])=>tag==='[SpotifyOutputEnd]'&&JSON.parse(String(raw)).phase==='output-drained')).toBe(false);
    expect(f.session.observe({...tail,streamGeneration:0,playing:false,ended:true})).toBe(false);
    expect(f.session.observe({...tail,position:120,playing:false,ended:true})).toBe(true);
    expect(info.mock.calls.filter(([tag,raw])=>tag==='[SpotifyOutputEnd]'&&JSON.parse(String(raw)).phase==='output-drained')).toHaveLength(1);
    expect(f.onError).not.toHaveBeenCalled();
});

it('does not let an older delayed pause park or abort a newer seek', async () => {
    const f = await fixture(); await f.session.prepare(); await f.session.command('play');
    const pauseReply = deferred<any>(); const original = f.helper.request.getMockImplementation()!;
    let delayedPause = false;
    f.helper.request.mockImplementation(async request => {
        if (request.action === 'pause' && !delayedPause) { delayedPause = true; return pauseReply.promise; }
        return original(request);
    });
    const pending = f.session.command('pause'); const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    const newer = await f.session.command('seek', { position: 42 });
    pauseReply.resolve({ ...newer, streamGeneration: 1, position: 0, playing: false }); await rejected;
    expect(f.readers[1].signal.aborted).toBe(false);
    expect(await f.session.command('volume', { volume: 0.5 })).toMatchObject({ position: 42, playing: false });
});

it('reports failed source restoration while still closing output and permits cleanup retry', async () => {
    const f = await fixture(); await f.session.prepare();
    f.source.pause.mockRejectedValueOnce(new Error('Pause rejected'));
    await expect(f.session.close()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', message: 'SOURCE_UNAVAILABLE' });
    expect(f.helper.close).toHaveBeenCalledOnce(); expect(f.readers[0].signal.aborted).toBe(true);
    await expect(f.session.command('play')).rejects.toMatchObject({ code: 'CANCELLED' });
    await f.session.close(); expect(f.helper.close).toHaveBeenCalledTimes(2);
});


it('passes the native heard checkpoint to source pause, stops output and reopens with stream-load on Play', async () => {
    const f = await fixture({ hq: true }); await f.session.prepare(); await f.session.command('play');
    const original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(async request => ({ ...await original(request), ...(request.action === 'pause' ? { position: 18.25 } : {}) }));
    await f.session.command('pause');
    expect(f.source.pause).toHaveBeenCalledWith({ positionMs: 18250 });
    expect(f.helper.request.mock.calls.some(([request]) => request.action === 'stop')).toBe(true);
    expect(f.readers[0].finished).toBe(true);
    const calls = f.helper.request.mock.calls.length;
    await f.session.command('gain', { gainDb: -5 }); await f.session.command('volume', { volume: 0.8 });
    expect(f.helper.request.mock.calls).toHaveLength(calls);
    await f.session.command('play');
    expect(f.readers[1].positionMs).toBe(18250);
    expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'stream-load')).toHaveLength(2);
    expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'stream-reset')).toHaveLength(0);
});

it('a newer Pause while output stop waits cancels queued Play before a fresh reader can start', async () => {
    const f = await fixture({ hq: true }); await f.session.prepare(); await f.session.command('play');
    const gate = deferred<any>(), original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(request => request.action === 'stop' ? gate.promise : original(request));
    const pausing = f.session.command('pause'); const pausedOld = expect(pausing).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.helper.request.mock.calls.some(([request]) => request.action === 'stop')).toBe(true));
    const playing = f.session.command('play'), cancelled = expect(playing).rejects.toMatchObject({ code: 'CANCELLED' });
    const latestPause = f.session.command('pause');
    expect(f.source.openReadable).toHaveBeenCalledTimes(1);
    gate.resolve({ ok: true }); await pausedOld; await cancelled;
    expect(await latestPause).toMatchObject({ playing: false });
    expect(f.source.openReadable).toHaveBeenCalledTimes(1);
});

it('failed output stop blocks capture reacquisition until explicit cleanup succeeds', async () => {
    const f = await fixture(); await f.session.prepare(); await f.session.command('play');
    const original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(request => request.action === 'stop' ? Promise.reject({ code: 'DEVICE_UNAVAILABLE' }) : original(request));
    await expect(f.session.command('pause')).rejects.toMatchObject({ code: 'DEVICE_UNAVAILABLE' });
    await expect(f.session.command('play')).rejects.toMatchObject({ code: 'DEVICE_UNAVAILABLE' });
    expect(f.source.openReadable).toHaveBeenCalledTimes(1); expect(f.readers[0].finished).toBe(true);
});


it('Pause during a parked resume cancels the opening reader and releases its delayed new output', async () => {
    const f = await fixture({ hq: true }); await f.session.prepare(); await f.session.command('play'); await f.session.command('pause');
    const gate = deferred<any>(), original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(async request => {
        const reply = await original(request);
        if (request.action === 'stream-load') { await gate.promise; return reply; }
        return reply;
    });
    const play = f.session.command('play'), cancelled = expect(play).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'stream-load')).toHaveLength(2));
    const pause = f.session.command('pause');
    gate.resolve({ ok: true }); await cancelled;
    expect(await pause).toMatchObject({ playing: false });
    expect(f.readers[1].signal.aborted).toBe(true);
    expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'stop')).toHaveLength(2);
    expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'play')).toHaveLength(1);
});


it('preparation progress and pause ACK carry monotonic session revisions, and retired generation events are ignored', async () => {
    const f = await fixture(); const first = await f.session.prepare(); await f.session.command('play');
    const firstProgress = f.progress.mock.calls.map(([, stage, values]) => ({ stage, ...values }));
    expect(firstProgress.map(value => value.stage)).toEqual(expect.arrayContaining(['source', 'connect', 'buffer']));
    expect(firstProgress.every(value => value.preparationRevision === first.preparationRevision)).toBe(true);
    const paused = await f.session.command('pause'); expect(paused.preparationRevision).toBeGreaterThan(first.preparationRevision);
    expect(f.session.observe({ ...first, playing: true, buffering: true })).toBe(false);
    const resumed = await f.session.command('play'); expect(resumed.preparationRevision).toBeGreaterThan(paused.preparationRevision);
    expect(f.progress.mock.calls.at(-1)![2].preparationRevision).toBe(resumed.preparationRevision);
});

it.each(['asio', 'hqplayer'])('anchors %s output to the observed live-source origin during seek and resume', async backend => {
    const f = await fixture({ hq: backend === 'hqplayer' }); await f.session.prepare(); await f.session.command('play');
    const original = f.source.openReadable.getMockImplementation()!;
    f.source.openReadable.mockImplementationOnce(args => original({ ...args, positionMs: args.positionMs - 2 }));
    const sought = await f.session.command('seek', { position: 12 });
    expect(sought).toMatchObject({ position: 11.998, playing: true });
    expect(f.helper.request.mock.calls.find(([request]) => request.action === 'stream-reset')![0].position).toBe(11.998);
    await f.session.command('pause');
    f.source.openReadable.mockImplementationOnce(args => original({ ...args, positionMs: args.positionMs + 37 }));
    const resumed = await f.session.command('play');
    expect(resumed).toMatchObject({ position: 12.035, playing: true });
    expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'stream-load').at(-1)![0].position).toBe(12.035);
    expect(f.readers.slice(0, 2).every(reader => reader.signal.aborted)).toBe(true);
});

it.each([
    ['unavailable', 'Spotify: cable-playback-unconfirmed', 'SOURCE_UNAVAILABLE'],
    ['unavailable', 'Spotify: automatic-route-restore-unconfirmed', 'SOURCE_RESTORE_UNCONFIRMED'],
    ['unavailable', 'Spotify: request-cancelled', 'CANCELLED'],
    ['unavailable', 'Spotify: external-playback-change', 'SOURCE_EXPIRED'],
    ['auth-required', 'Spotify: auth-required', 'SOURCE_UNAVAILABLE'],
])('maps public source %s / %s to %s before renderer projection', async (code, message, expected) => {
    const f = await fixture(); f.source.openReadable.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
    await expect(f.session.prepare()).rejects.toMatchObject({ code: expected });
    expect(f.onError).not.toHaveBeenCalled();
});

it.each([-1, 0.5, NaN, Infinity, 120000])('rejects invalid observed source origin %s before opening native output', async positionMs => {
    const f = await fixture(), original = f.source.openReadable.getMockImplementation()!;
    f.source.openReadable.mockImplementationOnce(args => original({ ...args, positionMs }));
    await expect(f.session.prepare()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(f.helper.request).not.toHaveBeenCalled(); expect(f.connections).toHaveLength(0);
});

it('real HQ adapter validates old status before bounded seek revokes that reader and validates the replacement independently', async () => {
    const f = await fixture({ hq: true, actualHQ: true });
    await f.session.prepare(); await f.session.command('play');
    const before = f.source.assertReader.mock.calls.length;
    expect(await f.session.command('seek', { position: 31 })).toMatchObject({ position: 31, playing: true });
    expect(f.source.beginPlayingSeek).toHaveBeenCalledWith({ positionMs: 31000 });
    expect(f.source.assertReader.mock.calls.length).toBeGreaterThan(before);
    expect(f.readers).toHaveLength(2); expect(f.readers[0].signal.aborted).toBe(true);
});
it('rapid real-HQ seeks do not query a revoked intermediate reader and only the latest target can play', async () => {
    const f = await fixture({ hq: true, actualHQ: true });
    await f.session.prepare(); await f.session.command('play');
    const gate = deferred(), original = f.source.openReadable.getMockImplementation()!;
    f.source.openReadable.mockImplementationOnce(async args => { await gate.promise; return original(args); });
    const first = f.session.command('seek', { position: 12 });
    const cancelled = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.source.beginPlayingSeek).toHaveBeenCalledTimes(1));
    const second = f.session.command('seek', { position: 47 });
    gate.resolve(); await cancelled;
    expect(await second).toMatchObject({ position: 47, playing: true });
    expect(f.readers.at(-1)?.positionMs).toBe(47000);
});

it('seek immediately after initial preparation replaces the pending reader without reporting a playback failure',async()=>{
 const f=await fixture({hq:true,actualHQ:true});const gate=deferred();const original=f.source.openReadable.getMockImplementation()!;
 f.source.openReadable.mockImplementationOnce(async args=>{await gate.promise;return original(args);});
 const first=f.session.prepare();const old=expect(first).rejects.toBeDefined();
 await vi.waitFor(()=>expect(f.source.openReadable).toHaveBeenCalledOnce());
 const seek=f.session.command('seek',{position:24});gate.resolve();await old;await seek;
 await f.session.command('play');expect(f.readers.at(-1)?.positionMs).toBe(24000);expect(f.onError).not.toHaveBeenCalled();
});

it('seek during pending resume preserves play intent without a second manual Play',async()=>{
 const f=await fixture({hq:true,actualHQ:true});await f.session.prepare();await f.session.command('play');await f.session.command('pause');
 const gate=deferred(),original=f.source.openReadable.getMockImplementation()!;
 f.source.openReadable.mockImplementationOnce(async args=>{await gate.promise;return original(args);});
 const playing=f.session.command('play'),old=expect(playing).rejects.toBeDefined();
 await vi.waitFor(()=>expect(f.source.openReadable).toHaveBeenCalledTimes(2));
 const seeking=f.session.command('seek',{position:42});gate.resolve();await old;
 expect(await seeking).toMatchObject({position:42,playing:true});expect(f.readers.at(-1)?.positionMs).toBe(42000);expect(f.onError).not.toHaveBeenCalled();
});
