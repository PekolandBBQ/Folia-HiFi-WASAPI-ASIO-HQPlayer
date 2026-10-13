import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Readiness, seek ownership and late failures are independent of whole-source completion.
const { createStreamSession } = createRequire(import.meta.url)('../../../electron/nativeAudio/streamSession.cjs');
function fixture() {
    const current = { id: 'test-stream', abort: new AbortController(), remoteUrl: 'https://example.invalid/audio',
        input: 'missing-test-file.audio', backend: 'asio', deviceId: 'test-driver', processingMode: 'integer-direct', durationHint: 120 };
    let generation = 0, position = 0, playing = false;
    const helper = { request: vi.fn(async (request: any) => {
        if (request.action === 'stream-reset') { generation++; position = request.position; playing = false; }
        if (request.action === 'play') playing = true;
        if (request.action === 'pause') playing = false;
        return { session: current.id, streaming: true, streamGeneration: generation, position, duration: 120,
            playing, ended: false, bufferedStart: position, bufferedEnd: position + 1, producerComplete: false };
    }) };
    const source = { state: { complete: false, available: 100 }, downloaded: Promise.resolve() };
    const progress = vi.fn(), onError = vi.fn(); let lateFailure: (error: unknown) => void = () => {};
    const decode = vi.fn(async ({ signal, onFormat }: any) => {
        await onFormat({ sampleRate: 44100, channels: 2, blockAlign: 8 });
        await new Promise<void>((_resolve, reject) => {
            lateFailure = reject; const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
    });
    const session = createStreamSession({ current, helper, executable: 'test.exe', fetchImpl: vi.fn(), progress,
        assertCurrent: () => current.abort.signal.throwIfAborted(), onError, sourceFactory: () => source, decode });
    return { session, current, source, helper, decode, progress, onError, rejectDecoder: (error: unknown) => lateFailure(error) };
}
it('becomes ready from prebuffer before download or decoder EOF and preserves playback intent after seek', async () => {
    const { session, source, helper, decode, current } = fixture();
    try {
        expect((await session.prepare()).bufferedEnd).toBe(1); expect(source.state.complete).toBe(false);
        await session.command('play', {});
        const seeked = await session.command('seek', { position: 65 });
        expect(seeked).toMatchObject({ position: 65, playing: true, streamGeneration: 1 });
        expect(decode.mock.calls[1][0].position).toBe(65);
        const pipes = helper.request.mock.calls.filter(([request]) => ['stream-load', 'stream-reset'].includes(request.action)).map(([request]) => request.pipeName);
        expect(pipes[0]).not.toBe(pipes[1]);
        expect(session.observe({ streaming: true, streamGeneration: 0 })).toBe(false);
    } finally { current.abort.abort(); await session.close(); }
});
it('a paused seek fills a new generation without implicitly playing it', async () => {
    const { session, current, helper } = fixture();
    try { await session.prepare(); await session.command('seek', { position: 10 });
        expect(helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
    } finally { current.abort.abort(); await session.close(); }
});
it('reports a strict decoder failure after readiness rather than silently replaying the track', async () => {
    const { session, current, onError, rejectDecoder } = fixture();
    try { await session.prepare(); const failure = Object.assign(new Error('Corrupt frame'), { code: 'STRICT_DECODE_FAILED' });
        rejectDecoder(failure); await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    } finally { current.abort.abort(); await session.close(); }
});
it('rejects a producer failure received during status instead of accepting the resulting pipe EOF as readiness', async () => {
    const f = fixture();
    type DeviceState = Awaited<ReturnType<typeof f.helper.request>>;
    let reply!: (value: DeviceState) => void;
    const status = new Promise<DeviceState>(resolve => { reply = resolve; });
    const original = f.helper.request.getMockImplementation()!;
    f.helper.request.mockImplementation(async request => request.action === 'status' ? status : original(request));
    try {
        const preparing = f.session.prepare();
        const rejected = expect(preparing).rejects.toMatchObject({ code: 'CONTROL_FAILED' });
        await vi.waitFor(() => expect(f.helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'status' })));
        f.rejectDecoder(Object.assign(new Error('Spotify Soloist: CONTROL_FAILED'), { code: 'CONTROL_FAILED' }));
        await Promise.resolve(); await Promise.resolve();
        // Closing a failed producer can make an output report EOF while its status
        // request is outstanding. This is not successful decode completion.
        reply({ session: f.current.id, streaming: true, streamGeneration: 0, position: 0, duration: 120,
            playing: false, ended: true, bufferedStart: 0, bufferedEnd: 0, producerComplete: true });
        await rejected; expect(f.onError).not.toHaveBeenCalled();
    } finally { f.current.abort.abort(); await f.session.close(); }
});
it('keeps an initial producer failure recoverable while final source metadata is pending', async () => {
    const sourceInfo = createRequire(import.meta.url)('../../../electron/nativeAudio/sourceInfo.cjs');
    let release!: () => void;
    const metadata = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(sourceInfo, 'readOriginalSourceInfo').mockResolvedValueOnce({})
        .mockImplementationOnce(async () => { await metadata; return {}; });
    const f = fixture();
    // The service treats onError as a failure after readiness and cancels the
    // entire source, which would make the initial full-file fallback impossible.
    f.onError.mockImplementation(() => f.current.abort.abort());
    try {
        const preparing = f.session.prepare().catch((error: unknown) => error);
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        const failure = Object.assign(new Error('Late initial decode failure'), { code: 'DECODE_FAILED' });
        f.rejectDecoder(failure);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        release();
        expect(await preparing).toBe(failure);
        expect(f.onError).not.toHaveBeenCalled();
        expect(f.decode.mock.calls[0][0].signal.aborted).toBe(true);
        expect(f.current.abort.signal.aborted).toBe(false);
    } finally { release(); f.current.abort.abort(); await f.session.close(); read.mockRestore(); }
});
it.each([false, true])('retires the owned decoder when output readiness fails (seek=%s)', async seek => {
    const f = fixture();
    const failure = Object.assign(new Error('Output device disconnected'), { code: 'DEVICE_UNAVAILABLE' });
    const original = f.helper.request.getMockImplementation()!;
    let failStatus = false;
    f.helper.request.mockImplementation(async request => {
        if (request.action === 'status' && failStatus) throw failure;
        const state = await original(request);
        if (seek && request.action === 'stream-reset') failStatus = true;
        return state;
    });
    try {
        if (seek) await f.session.prepare(); else failStatus = true;
        const preparing = seek ? f.session.command('seek', { position: 10 }) : f.session.prepare();
        await expect(preparing).rejects.toBe(failure);
        // A rejected load/refill must not leave FFmpeg or a live producer attached
        // to its output pipe until an unrelated later stop or source replacement.
        expect(f.decode.mock.calls.at(-1)?.[0].signal.aborted).toBe(true);
        expect(f.current.abort.signal.aborted).toBe(false);
        expect(f.onError).not.toHaveBeenCalled();
    } finally { f.current.abort.abort(); await f.session.close(); }
});
it('waits for failed decoder teardown and lets a newer preparation supersede its error', async () => {
    const f = fixture();
    const original = f.helper.request.getMockImplementation()!;
    let release!: () => void, cleanupStarted = false, failStatus = true;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    f.decode.mockImplementationOnce(async ({ signal, onFormat }: any) => {
        await onFormat({ sampleRate: 44100, channels: 2, blockAlign: 8 });
        try {
            await new Promise<void>((_resolve, reject) => {
                const abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
            });
        } finally { cleanupStarted = true; await cleanup; }
    });
    f.helper.request.mockImplementation(async request => {
        if (request.action === 'status' && failStatus) {
            failStatus = false;
            throw Object.assign(new Error('Output device disconnected'), { code: 'DEVICE_UNAVAILABLE' });
        }
        return original(request);
    });
    try {
        const failed = f.session.prepare();
        const cancelled = expect(failed).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(cleanupStarted).toBe(true));
        const replacement = f.session.prepare(5, true);
        expect(f.decode).toHaveBeenCalledOnce();
        release(); await cancelled;
        expect(await replacement).toMatchObject({ position: 5, streamGeneration: 1 });
        expect(f.decode.mock.calls.at(-1)?.[0].signal.aborted).toBe(false);
        expect(f.onError).not.toHaveBeenCalled();
    } finally { release(); f.current.abort.abort(); await f.session.close(); }
});
it('does not resume from an old play snapshot when paused during a seek refill', async () => {
    const { session, current, helper } = fixture(); let waiting = true;
    const original = helper.request.getMockImplementation()!;
    helper.request.mockImplementation(async (request: any) => {
        const state = await original(request);
        return { ...state, bufferedEnd: state.position === 90 && waiting ? state.position : state.position + 1 };
    });
    try {
        await session.prepare(); await session.command('play', {});
        const seeking = session.command('seek', { position: 90 });
        await vi.waitFor(() => expect(helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-reset', position: 90 })));
        await session.command('pause', {}); waiting = false;
        expect((await seeking).playing).toBe(false);
    } finally { current.abort.abort(); await session.close(); }
});
it('supersedes a waiting far seek with a near seek and isolates the old decoder controller', async () => {
    const { session, current, helper, onError, decode } = fixture();
    const original = helper.request.getMockImplementation()!;
    helper.request.mockImplementation(async (request: any) => {
        const state = await original(request);
        return { ...state, bufferedEnd: state.position === 90 ? state.position : state.position + 1 };
    });
    try {
        await session.prepare(); await session.command('play', {});
        const far = session.command('seek', { position: 90 }); const rejected = expect(far).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-reset', position: 90 })));
        const near = await session.command('seek', { position: 5 }); await rejected;
        expect(near).toMatchObject({ position: 5, playing: true, streamGeneration: 2 });
        expect(decode.mock.calls.at(-1)?.[0].signal.aborted).toBe(false); expect(onError).not.toHaveBeenCalled();
    } finally { current.abort.abort(); await session.close(); }
});
it('does not let a late status response from an older seek replace a newer seek', async () => {
    const { session, current, helper } = fixture(); let release!: () => void, delayed = false;
    const original = helper.request.getMockImplementation()!;
    const wait = new Promise<void>(resolve => { release = resolve; });
    try {
        await session.prepare(); await session.command('play', {});
        helper.request.mockImplementation(async (request: any) => {
            if (request.action === 'status' && !delayed) { delayed = true; await wait; }
            return original(request);
        });
        const old = session.command('seek', { position: 90 }); const rejected = expect(old).rejects.toMatchObject({ code: 'CANCELLED' });
        expect((await session.command('seek', { position: 5 })).position).toBe(5); release(); await rejected;
        expect(helper.request.mock.calls.some(([request]) => request.action === 'stream-reset' && request.position === 90)).toBe(false);
    } finally { release(); current.abort.abort(); await session.close(); }
});
it('seeks after natural EOF without retaining the previous automatic play intent', async () => {
    const { session, current, helper } = fixture();
    try {
        await session.prepare(); await session.command('play', {});
        session.observe({ streaming: true, streamGeneration: 0, ended: true, playing: false });
        const plays = helper.request.mock.calls.filter(([request]) => request.action === 'play').length;
        expect((await session.command('seek', { position: 4 })).playing).toBe(false);
        expect(helper.request.mock.calls.filter(([request]) => request.action === 'play')).toHaveLength(plays);
    } finally { current.abort.abort(); await session.close(); }
});
it('uses the authoritative EOF status even if its final event has not arrived before a seek', async () => {
    const { session, current, helper } = fixture(); let ended = true;
    const original = helper.request.getMockImplementation()!;
    try {
        await session.prepare(); await session.command('play', {});
        helper.request.mockImplementation(async (request: any) => {
            if (request.action === 'stream-reset') ended = false;
            return { ...await original(request), ended };
        });
        expect((await session.command('seek', { position: 4 })).playing).toBe(false);
    } finally { current.abort.abort(); await session.close(); }
});

function blockedRefillFixture() {
    const f = fixture(), blocked = new Set<number>();
    const original = f.helper.request.getMockImplementation()!;
    let devicePosition = 0;
    f.helper.request.mockImplementation(async (request: any) => {
        if (request.action === 'stream-reset') devicePosition = request.position;
        // Match the real component's guard: an empty replacement cannot play.
        if (request.action === 'play' && blocked.has(devicePosition)) throw Object.assign(new Error('No buffered PCM'), { code: 'INVALID_REQUEST' });
        const state = await original(request);
        return { ...state, bufferedEnd: blocked.has(state.position) ? state.position : state.position + 1 };
    });
    return { ...f, blocked };
}
it('waits for the complete pending seek before play, including a delayed pre-reset status', async () => {
    const f = blockedRefillFixture(); let release!: () => void;
    try {
        await f.session.prepare(); f.blocked.add(10);
        const original = f.helper.request.getMockImplementation()!;
        let delayed = false;
        const status = new Promise<void>(resolve => { release = resolve; });
        f.helper.request.mockImplementation(async (request: any) => {
            if (request.action === 'status' && !delayed) { delayed = true; await status; }
            return original(request);
        });
        const seeking = f.session.command('seek', { position: 10 });
        const playing = f.session.command('play', {});
        await Promise.resolve(); await Promise.resolve();
        expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
        release();
        await vi.waitFor(() => expect(f.helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-reset', position: 10 })));
        expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
        f.blocked.delete(10);
        expect(await playing).toMatchObject({ position: 10, playing: true, streamGeneration: 1 });
        expect(await seeking).toMatchObject({ position: 10, playing: true, streamGeneration: 1 });
        expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'play')).toHaveLength(1);
    } finally { release?.(); f.current.abort.abort(); await f.session.close(); }
});
it('pause and gain remain responsive while a seek-bound play is waiting for PCM', async () => {
    const f = blockedRefillFixture();
    try {
        await f.session.prepare(); f.blocked.add(10);
        const seeking = f.session.command('seek', { position: 10 });
        await vi.waitFor(() => expect(f.helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-reset', position: 10 })));
        const playing = f.session.command('play', {});
        const cancelled = expect(playing).rejects.toMatchObject({ code: 'CANCELLED' });
        await f.session.command('volume', { volume: 0.5 });
        expect(await f.session.command('pause', {})).toMatchObject({ playing: false });
        f.blocked.delete(10); expect((await seeking).playing).toBe(false); await cancelled;
        expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
    } finally { f.current.abort.abort(); await f.session.close(); }
});
it('a newer seek cancels the waiting play and only its ready generation can resume', async () => {
    const f = blockedRefillFixture();
    try {
        await f.session.prepare(); f.blocked.add(90);
        const far = f.session.command('seek', { position: 90 });
        const cancelledSeek = expect(far).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(f.helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-reset', position: 90 })));
        const playing = f.session.command('play', {});
        const cancelledPlay = expect(playing).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(await f.session.command('seek', { position: 5 })).toMatchObject({ position: 5, playing: true, streamGeneration: 2 });
        await cancelledSeek; await cancelledPlay;
        expect(f.helper.request.mock.calls.filter(([request]) => request.action === 'play').map(([request]) => request.streamGeneration)).toEqual([2]);
    } finally { f.current.abort.abort(); await f.session.close(); }
});
it('a failed replacement rejects its waiting play without bypassing the producer error', async () => {
    const f = blockedRefillFixture();
    try {
        await f.session.prepare(); f.blocked.add(10);
        const seeking = f.session.command('seek', { position: 10 });
        const failure = Object.assign(new Error('Corrupt replacement'), { code: 'STRICT_DECODE_FAILED' });
        const rejectedSeek = expect(seeking).rejects.toBe(failure);
        await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(2));
        const playing = f.session.command('play', {});
        const rejectedPlay = expect(playing).rejects.toBe(failure);
        f.rejectDecoder(failure); await rejectedSeek; await rejectedPlay;
        expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
    } finally { f.current.abort.abort(); await f.session.close(); }
});
it('closing a pending replacement cancels its waiting play without sending a late play', async () => {
    const f = blockedRefillFixture();
    try {
        await f.session.prepare(); f.blocked.add(10);
        const seeking = f.session.command('seek', { position: 10 });
        const cancelledSeek = expect(seeking).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(f.helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-reset', position: 10 })));
        const playing = f.session.command('play', {});
        const cancelledPlay = expect(playing).rejects.toMatchObject({ code: 'CANCELLED' });
        await f.session.close(); await cancelledSeek; await cancelledPlay;
        expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
    } finally { f.current.abort.abort(); await f.session.close(); }
});
it('suspending a replacement cancels its waiting play and permits a later prepared stream to play', async () => {
    const f = blockedRefillFixture();
    try {
        await f.session.prepare(); f.blocked.add(10);
        const seeking = f.session.command('seek', { position: 10 });
        const cancelledSeek = expect(seeking).rejects.toMatchObject({ code: 'CANCELLED' });
        await vi.waitFor(() => expect(f.helper.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-reset', position: 10 })));
        const playing = f.session.command('play', {});
        const cancelledPlay = expect(playing).rejects.toMatchObject({ code: 'CANCELLED' });
        await f.session.suspend(); await cancelledSeek; await cancelledPlay;
        expect(f.helper.request.mock.calls.some(([request]) => request.action === 'play')).toBe(false);
        await f.session.prepare(5, true);
        expect(await f.session.command('play', {})).toMatchObject({ position: 5, playing: true, streamGeneration: 2 });
    } finally { f.current.abort.abort(); await f.session.close(); }
});
