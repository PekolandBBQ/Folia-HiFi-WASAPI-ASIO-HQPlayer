import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

// test/unit/onlineMusic/soloistBrowserSession.test.ts: real async reader ownership, bounded IPC and cancellation.
const { createSoloistBrowserSession } = createRequire(import.meta.url)('../../../electron/spotify/soloistBrowserSession.cjs');
const session = '11111111-1111-4111-8111-111111111111', url = 'http://127.0.0.1:12345/opaque.wav';
function fixture(open?: (...args: any[]) => any) {
    const source = { sampleRate: 44100, channels: 2, bitDepth: 32, durationMs: 60000,
        stop: vi.fn(async () => {}), seek: vi.fn(async (positionMs: number) => ({ positionMs: positionMs + 25 })),
        openReadable: vi.fn(open || (async () => ({ positionMs: 125, stream: (async function* () {
            const block = Buffer.alloc(131072); for (let index = 0; index < block.length; index++) block[index] = index % 251;
            yield block; block.fill(0); })() }))) };
    const lookup = vi.fn((value: string) => value === url ? source : null), manager = createSoloistBrowserSession({ lookup });
    return { source, lookup, manager, begin: () => manager.request({ action: 'begin', session, url }),
        start: () => manager.request({ action: 'start', session, positionMs: 100 }) };
}
it('accepts only the active opaque source and never opens a producer for begin or malformed input', async () => {
    const f = fixture();
    await expect(f.manager.request({ action: 'begin', session, url: 'http://unowned.invalid/token' })).rejects.toThrow('source-unavailable');
    await expect(f.manager.request({ action: 'begin', session: 'invalid', url })).rejects.toThrow('invalid-browser-request');
    expect(await f.begin()).toMatchObject({ sampleRate: 44100, durationMs: 60000 });
    expect(f.source.openReadable).not.toHaveBeenCalled(); await f.manager.close();
});
it('uses the confirmed source origin and splits/copies PCM into at most 64KiB IPC blocks', async () => {
    const f = fixture(); await f.begin(); const started = await f.start();
    expect(started.positionMs).toBe(125);
    expect(f.source.stop).not.toHaveBeenCalled(); // first read uses its already confirmed, prepared generation.
    const first = await f.manager.request({ action: 'pull', session, generation: started.generation });
    const second = await f.manager.request({ action: 'pull', session, generation: started.generation });
    expect(first.data.byteLength).toBe(65536); expect(second.data.byteLength).toBe(65536);
    expect(await f.manager.request({ action: 'pull', session, generation: started.generation })).toMatchObject({ complete: true });
    const expected = Buffer.alloc(131072); for (let index = 0; index < expected.length; index++) expected[index] = index % 251;
    expect(Buffer.concat([Buffer.from(first.data), Buffer.from(second.data)])).toEqual(expected);
    await f.manager.close();
});
it('pause aborts a truly pending pull and resumes through a fresh generation without revoking the URL', async () => {
    let aborted = false;
    const f = fixture(async ({ signal }: { signal: AbortSignal }) => ({ positionMs: 100,
        stream: (async function* () { await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); yield Buffer.alloc(8); })() }));
    await f.begin(); const first = await f.start();
    const pending = f.manager.request({ action: 'pull', session, generation: first.generation });
    const rejected = expect(pending).rejects.toThrow('request-cancelled');
    await Promise.resolve(); await f.manager.request({ action: 'pause', session }); await rejected;
    expect(aborted).toBe(true); const next = await f.start(); expect(next.generation).toBeGreaterThan(first.generation);
    await expect(f.manager.request({ action: 'pull', session, generation: first.generation })).rejects.toThrow('request-cancelled');
    expect(f.lookup).toHaveBeenCalledTimes(1); await f.manager.close();
});
it('a late pause cannot retire the reader opened by a newer start', async () => {
    const f = fixture(); await f.begin(); const first = await f.start();
    let release!: () => void; f.source.stop.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const paused = f.manager.request({ action: 'pause', session }); const rejected = expect(paused).rejects.toThrow('request-cancelled');
    const second = await f.start(); release(); await rejected;
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(await f.manager.request({ action: 'pull', session, generation: second.generation })).toMatchObject({ complete: false });
    await f.manager.close();
});
it('rejects concurrent pulls and malformed PCM rather than producing a false natural EOF', async () => {
    let release!: () => void;
    const f = fixture(async () => ({ positionMs: 0, stream: (async function* () { await new Promise<void>(resolve => { release = resolve; }); yield Buffer.alloc(7); })() }));
    await f.begin(); const first = await f.start();
    const pending = f.manager.request({ action: 'pull', session, generation: first.generation });
    const bad = expect(pending).rejects.toThrow('invalid-pcm-block'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.manager.request({ action: 'pull', session, generation: first.generation })).rejects.toThrow('request-cancelled');
    release(); await bad; await f.manager.close();
});
it('paused position changes use the actual source-confirmed position without starting playback', async () => {
    const f = fixture(); await f.begin();
    expect(await f.manager.request({ action: 'position', session, positionMs: 5000 })).toMatchObject({ positionMs: 5025 });
    expect(f.source.openReadable).not.toHaveBeenCalled(); expect(f.source.seek).toHaveBeenCalledWith(5000); await f.manager.close();
});
it.each(['clear', 'close'])('%s always retires the reader when an externally changed track refuses owner-gated stop', async method => {
    let aborted = false;
    const f = fixture(async ({ signal }: { signal: AbortSignal }) => ({ positionMs: 0,
        stream: (async function* () { await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); yield Buffer.alloc(8); })() }));
    await f.begin(); const started = await f.start();
    const pending = f.manager.request({ action: 'pull', session, generation: started.generation });
    const rejected = expect(pending).rejects.toThrow('request-cancelled'); await Promise.resolve();
    f.source.stop.mockRejectedValueOnce(Object.assign(new Error('external ownership'), { code: 'TRACK_NOT_CURRENT' }));
    await f.manager[method](); await rejected; expect(aborted).toBe(true);
    await expect(f.manager.request({ action: 'pull', session, generation: started.generation })).rejects.toThrow();
    if (method === 'clear') { expect(await f.begin()).toMatchObject({ session }); await f.manager.close(); }
    else await expect(f.begin()).rejects.toThrow('invalid-browser-request');
});
