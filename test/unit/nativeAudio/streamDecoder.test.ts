import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// A decoder exit must interrupt a blocked source reader rather than wait for the next network packet.
const { decodeStream } = createRequire(import.meta.url)('../../../electron/nativeAudio/streamDecoder.cjs');
it('reports a decoder exit promptly while the source is waiting for another network chunk', async () => {
    const owner = new AbortController(); let readerAborted = false;
    const source = { async *chunks(signal: AbortSignal) {
        await new Promise<void>((_resolve, reject) => {
            const abort = () => { readerAborted = true; reject(new DOMException('Cancelled', 'AbortError')); };
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
    } };
    const onFormat = vi.fn();
    // Node exits for FFmpeg's unsupported options without opening any audio output device.
    const decoding = decodeStream({ executable: process.execPath, source, signal: owner.signal,
        position: 0, compatibilityMode: false, onFormat });
    const outcome = decoding.then(() => 'success', (error: { code?: string }) => error.code || 'error');
    try {
        const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('pending'), 1000))]);
        expect(result).toBe('DECODE_FAILED'); expect(readerAborted).toBe(true); expect(onFormat).not.toHaveBeenCalled();
        expect(owner.signal.aborted).toBe(false);
    } finally { owner.abort(); await outcome; }
});
