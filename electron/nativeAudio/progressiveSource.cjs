const fs = require('node:fs/promises');
const { audioError } = require('./errors.cjs');
const { MAX_REMOTE_AUDIO_BYTES } = require('./download.cjs');

// Session-owned growing source cache. Decoder readers can restart without another signed-URL request.
function createProgressiveSource({ url, file, signal, fetchImpl, onProgress = () => {}, maxBytes = MAX_REMOTE_AUDIO_BYTES }) {
    let available = 0, complete = false, failure = null, total;
    const waiters = new Set();
    const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
    const downloaded = (async () => {
        let response, writer, reader;
        try {
            response = await fetchImpl(url, { signal, redirect: 'follow', credentials: 'include' });
            if (!response.ok) throw audioError([401, 403, 404, 410].includes(response.status) ? 'SOURCE_EXPIRED' : 'SOURCE_UNAVAILABLE', `Audio download failed (HTTP ${response.status})`);
            const declared = Number(response.headers.get('content-length'));
            if (declared > maxBytes) throw audioError('SOURCE_TOO_LARGE', 'Audio source exceeds staging limit');
            total = declared > 0 ? declared : undefined;
            if (!response.body) throw audioError('SOURCE_UNAVAILABLE', 'Audio response has no body');
            reader = response.body.getReader(); writer = await fs.open(file, 'w');
            let lastProgress = 0;
            onProgress({ loaded: 0, total, contentType: response.headers.get('content-type') || undefined });
            while (true) {
                signal.throwIfAborted();
                const { done, value } = await reader.read();
                if (done) break;
                if (available + value.byteLength > maxBytes) throw audioError('SOURCE_TOO_LARGE', 'Audio source exceeds staging limit');
                for (let offset = 0; offset < value.byteLength;) {
                    signal.throwIfAborted();
                    const { bytesWritten } = await writer.write(value, offset, value.byteLength - offset, available + offset);
                    if (!bytesWritten) throw new Error('Unable to write progressive audio');
                    offset += bytesWritten;
                }
                available += value.byteLength; wake();
                if (Date.now() - lastProgress >= 100) { onProgress({ loaded: available, total }); lastProgress = Date.now(); }
            }
            if (!available) throw audioError('SOURCE_UNAVAILABLE', 'Empty audio response');
            if (total !== undefined && available !== total) throw audioError('SOURCE_UNAVAILABLE', 'Truncated audio response');
            complete = true; wake(); onProgress({ loaded: available, total: available, complete: true });
        } catch (error) {
            failure = audioError(signal.aborted ? 'CANCELLED' : error.code || 'SOURCE_UNAVAILABLE', error.message); wake(); throw failure;
        } finally {
            await reader?.cancel().catch(() => {}); await writer?.close();
            if (!reader) await response?.body?.cancel().catch(() => {});
        }
    })();
    downloaded.catch(() => {});
    // Positional reads see only bytes committed by the writer; source EOF differs from temporary emptiness.
    async function* chunks(readerSignal) {
        let handle, offset = 0;
        const abort = () => wake(); readerSignal.addEventListener('abort', abort, { once: true });
        try {
            while (true) {
                readerSignal.throwIfAborted(); signal.throwIfAborted();
                if (failure) throw failure;
                if (offset >= available) {
                    if (complete) break;
                    await new Promise(resolve => { waiters.add(resolve); if (readerSignal.aborted || signal.aborted) wake(); });
                    continue;
                }
                handle ||= await fs.open(file, 'r');
                const bytes = Buffer.allocUnsafe(Math.min(65536, available - offset));
                const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
                if (!bytesRead) throw audioError('SOURCE_UNAVAILABLE', 'Progressive cache read failed');
                offset += bytesRead; yield bytes.subarray(0, bytesRead);
            }
        } finally { readerSignal.removeEventListener('abort', abort); await handle?.close(); }
    }
    signal.addEventListener('abort', wake, { once: true });
    downloaded.finally(() => signal.removeEventListener('abort', wake)).catch(() => {});
    return { downloaded, chunks, get state() { return { available, total, complete, failure }; } };
}
module.exports = { createProgressiveSource };
