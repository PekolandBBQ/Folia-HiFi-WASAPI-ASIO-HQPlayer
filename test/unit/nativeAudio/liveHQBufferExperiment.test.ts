import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';

// liveHQBufferExperiment.test.ts — real session/pump logic with only in-memory PCM and writable pipes.
const require = createRequire(import.meta.url);
const { createLivePcmSession } = require('../../../electron/nativeAudio/livePcmSession.cjs');
const { installPreviewDiagnosticSink } = require('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
const rate = 44100, byteRate = rate * 8;
function pcm(milliseconds: number, seed = 1) {
    const bytes = Buffer.alloc(Math.round(rate * milliseconds / 1000) * 8);
    for (let offset = 0; offset < bytes.length; offset += 8) {
        bytes.writeInt32LE(((offset / 8 + seed) % 311 - 155) * 32, offset);
        bytes.writeInt32LE(((offset / 8 + seed) % 197 - 98) * -16, offset + 4);
    }
    return bytes;
}
async function advance(ms: number) { await vi.advanceTimersByTimeAsync(ms); }
function fixture({ prebufferMs = 350, startupDelayMs = 0, capacityMs = 3000 } = {}) {
    vi.useFakeTimers();
    const current = { id: 'memory-hq', abort: new AbortController(), backend: 'hqplayer', deviceId: 'hqplayer-local',
        durationHint: 120, sourceMetadata: { preparedAudio: { representation: 's32le', sampleRate: rate, channels: 2 } } };
    const readers: any[] = [], pipes: any[] = [], events: any[] = [];
    const uninstall = installPreviewDiagnosticSink({ enabled: () => true, record: (type: string, fields: object) => events.push({ type, fields }) });
    let generation = 0, position = 0, playing = false;
    const helper = { close: vi.fn(async () => {}), request: vi.fn(async (request: any) => {
        if (['stream-load', 'stream-reset'].includes(request.action)) { generation++; position = request.position; playing = false; }
        if (request.action === 'play') { playing = true; pipes[generation - 1]?.resume(); }
        if (request.action === 'pause') playing = false;
        const pipe = pipes[generation - 1];
        return { session: current.id, backend: 'hqplayer', streaming: true, streamGeneration: generation,
            ready: true, position, duration: 120, playing, ended: false, buffering: false,
            bufferedStart: position, bufferedEnd: position + (pipe?.received || 0) / byteRate,
            streamQueuedSeconds: (pipe?.queued || 0) / byteRate, bufferCapacityBytes: byteRate * capacityMs / 1000,
            producerComplete: false };
    }) };
    const source = { sampleRate: rate, channels: 2, bitDepth: 32, durationMs: 120000, pause: vi.fn(async () => {}),
        openReadable: vi.fn(async ({ positionMs, signal }: any) => {
            const reader = { signal, positionMs, queue: [] as Buffer[], finished: false, wake: () => {},
                push(bytes: Buffer) { this.queue.push(bytes); this.wake(); } }; readers.push(reader);
            return { stream: (async function* () {
                try {
                    while (true) {
                        signal.throwIfAborted();
                        if (reader.queue.length) { yield reader.queue.shift()!; continue; }
                        await new Promise<void>((resolve, reject) => {
                            const cleanup = () => signal.removeEventListener('abort', abort);
                            const abort = () => { cleanup(); reject(signal.reason); };
                            reader.wake = () => { cleanup(); resolve(); };
                            signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
                        });
                    }
                } finally { reader.finished = true; }
            })() };
        }) };
    const progress = vi.fn(), onError = vi.fn();
    const session = createLivePcmSession({ current, source, helper, progress, onError,
        assertCurrent: () => current.abort.signal.throwIfAborted(), getPrebufferMs: () => prebufferMs, experiment: { enabled: true, prebufferMs, startupDelayMs },
        connectPipe: () => {
            const record = { received: 0, queued: 0, maximumQueued: 0, chunks: [] as Buffer[], unblock: null as null | (() => void),
                resume() { this.queued = 0; const callback = this.unblock; this.unblock = null; callback?.(); } };
            const pipe = new Writable({ highWaterMark: 65536, write(bytes, _encoding, done) {
                const accept = () => {
                    record.chunks.push(Buffer.from(bytes)); record.received += bytes.length;
                    if (!playing) record.queued += bytes.length;
                    record.maximumQueued = Math.max(record.maximumQueued, record.queued); done();
                };
                if (!playing && record.queued + bytes.length > byteRate * capacityMs / 1000) record.unblock = accept;
                else accept();
            } });
            pipes.push(Object.assign(record, { pipe })); queueMicrotask(() => pipe.emit('connect'));
            return pipe;
        } });
    cleanups.push(async () => { current.abort.abort(); await session.close(); for (const record of pipes) record.pipe.destroy(); uninstall(); });
    return { current, session, source, helper, readers, pipes, events, progress, onError };
}
async function push(f: ReturnType<typeof fixture>, ms: number, seed = 1) {
    const bytes = pcm(ms, seed);
    for (let offset = 0; offset < bytes.length; offset += 35280) f.readers.at(-1).push(bytes.subarray(offset, offset + 35280));
    await advance(25); return bytes;
}

it('waits for the selected PCM target and then the configured delay, preserving every known signal byte', async () => {
    const f = fixture({ prebufferMs: 1000, startupDelayMs: 400 });
    let result: any;
    const preparing = f.session.prepare().then((state: any) => { result = state; return state; });
    await advance(25);
    const first = await push(f, 900); expect(result).toBeUndefined();
    const second = await push(f, 100, 2); expect(result).toBeUndefined();
    await advance(350); expect(result).toBeUndefined();
    await advance(75); await preparing;
    expect(result.playing).toBe(false);
    expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
    expect(Buffer.concat(f.pipes[0].chunks).equals(Buffer.concat([first, second]))).toBe(true);
    expect(f.progress).toHaveBeenCalledWith(f.current, 'buffer', expect.objectContaining({ total: 1000, startupDelayMs: 400 }));
    const ready = f.events.find(value => value.type === 'native.hq-experiment' && value.fields.phase === 'ready');
    expect(ready.fields).toMatchObject({ prebufferMs: 1000, startupDelayMs: 400, inputBytes: byteRate, pcmFormat: 's32le' });
    expect(ready.fields.startupWaitMs).toBeGreaterThanOrEqual(400);
    await f.session.command('play'); expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'play')).toHaveLength(1);
});
it('can become ready at the maximum delay while the bounded paused pipe is backpressured', async () => {
    const f = fixture({ prebufferMs: 1000, startupDelayMs: 1000 });
    const preparing = f.session.prepare(); await advance(25);
    const expected = await push(f, 4000);
    expect(f.pipes[0].unblock).toBeTypeOf('function');
    await advance(1000); expect((await preparing).playing).toBe(false);
    expect(f.pipes[0].maximumQueued).toBeLessThanOrEqual(3 * byteRate);
    await f.session.command('play'); await advance(25);
    expect(Buffer.concat(f.pipes[0].chunks).equals(expected)).toBe(true);
    expect(f.onError).not.toHaveBeenCalled();
});
it.each([false, true])('cancel/handoff interrupts a pending readiness wait (already prebuffered=%s)', async filled => {
    const f = fixture({ prebufferMs: 1000, startupDelayMs: 1000 });
    const pending = f.session.prepare(); const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await advance(25); if (filled) await push(f, 1000);
    f.current.abort.abort(); await rejected; await f.session.close(); await advance(1200);
    expect(f.readers[0].finished).toBe(true); expect(f.pipes[0].pipe.destroyed).toBe(true);
    expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
});
it('reapplies the delay after a playing seek, rejects an old generation and keeps bytes in their own pipes', async () => {
    const f = fixture({ prebufferMs: 100, startupDelayMs: 200 });
    const initial = f.session.prepare(); await advance(25); const first = await push(f, 100); await advance(200); await initial;
    await f.session.command('play');
    const seeking = f.session.command('seek', { position: 22 }); await advance(25);
    expect(f.readers[0].signal.aborted).toBe(true); expect(f.readers[1].positionMs).toBe(22000);
    const second = await push(f, 100, 77);
    expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'play')).toHaveLength(1);
    await advance(200); expect(await seeking).toMatchObject({ playing: true, position: 22, streamGeneration: 2 });
    expect(Buffer.concat(f.pipes[0].chunks).equals(first)).toBe(true); expect(Buffer.concat(f.pipes[1].chunks).equals(second)).toBe(true);
    expect(f.session.observe({ streaming: true, streamGeneration: 1, position: 80, playing: true })).toBe(false);
});
it.each([['empty', Buffer.alloc(0)], ['incomplete-frame', Buffer.alloc(7)], ['oversized-block', Buffer.alloc(65544)], ['wrong-type', 'not PCM']])('fails malformed PCM rather than padding, relabeling or playing it: %s', async (_label, bytes) => {
    const f = fixture();
    const pending = f.session.prepare(); const rejected = expect(pending).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    await advance(25); f.readers[0].push(bytes as Buffer); await advance(25); await rejected;
    expect(f.pipes[0].chunks).toHaveLength(0);
    expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
});
