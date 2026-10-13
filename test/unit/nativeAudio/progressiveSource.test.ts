import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A growing cache must unblock early readers without treating a network gap as EOF.
const { createProgressiveSource } = createRequire(import.meta.url)('../../../electron/nativeAudio/progressiveSource.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(total = 6, maxBytes = 100) {
    const folder = await mkdtemp(path.join(tmpdir(), 'folia-stream-source-test-'));
    const abort = new AbortController(); let input!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller; } });
    abort.signal.addEventListener('abort', () => input.error(new DOMException('Cancelled', 'AbortError')));
    const source = createProgressiveSource({ url: 'https://example.invalid/audio', file: path.join(folder, 'input.audio'),
        signal: abort.signal, maxBytes, fetchImpl: async () => new Response(body, { headers: { 'content-length': String(total) } }) });
    cleanups.push(async () => { abort.abort(); await source.downloaded.catch(() => {}); await rm(folder, { recursive: true, force: true }); });
    return { source, input, abort };
}
it('yields committed bytes before EOF, waits through a gap and supports a second reader', async () => {
    const { source, input } = await fixture(); const reader = new AbortController();
    const stream = source.chunks(reader.signal); input.enqueue(new Uint8Array([1, 2, 3]));
    expect(Buffer.from((await stream.next()).value)).toEqual(Buffer.from([1, 2, 3]));
    expect(source.state.complete).toBe(false);
    let settled = false; const next = stream.next().then((value: unknown) => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false);
    input.enqueue(new Uint8Array([4, 5, 6])); input.close();
    expect(Buffer.from((await next as any).value)).toEqual(Buffer.from([4, 5, 6]));
    await source.downloaded; expect((await stream.next()).done).toBe(true);
    const replay: Buffer[] = []; for await (const chunk of source.chunks(reader.signal)) replay.push(chunk);
    expect(Buffer.concat(replay)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
});
it('a replaced decoder aborts its waiting reader without stopping the source download', async () => {
    const { source, input } = await fixture(); const old = new AbortController();
    const pending = source.chunks(old.signal).next(); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    old.abort(); await rejected; input.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6])); input.close();
    await source.downloaded; expect(source.state.complete).toBe(true);
});
it('rejects declared oversize sources and does not pretend their cache is complete', async () => {
    const { source } = await fixture(101, 100);
    await expect(source.downloaded).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
    expect(source.state.complete).toBe(false);
});
it('rejects truncated content and propagates the same source failure to a waiting decoder', async () => {
    const { source, input } = await fixture(); input.enqueue(new Uint8Array([1])); input.close();
    await expect(source.downloaded).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(source.chunks(new AbortController().signal).next()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});
