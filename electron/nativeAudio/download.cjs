const fs = require('node:fs/promises');
const { audioError } = require('./errors.cjs');

// electron/nativeAudio/download.cjs — stage the resolved source completely before decoding.
const MAX_REMOTE_AUDIO_BYTES = 2 * 1024 ** 3;
async function downloadRemoteAudio(url, destination, signal, fetchImpl = globalThis.fetch) {
    let response, reader, file;
    try {
        response = await fetchImpl(url, { signal, redirect: 'follow', credentials: 'include' });
        if (!response.ok) throw audioError([401, 403, 404, 410].includes(response.status) ? 'SOURCE_EXPIRED' : 'SOURCE_UNAVAILABLE', `Audio download failed (HTTP ${response.status})`);
        if (!response.body) throw new Error('Audio download returned no body');
        if (Number(response.headers.get('content-length')) > MAX_REMOTE_AUDIO_BYTES)
            throw audioError('SOURCE_TOO_LARGE', 'Audio source exceeds the 2 GiB staging limit');
        reader = response.body.getReader();
        file = await fs.open(destination, 'w');
        let bytes = 0;
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_REMOTE_AUDIO_BYTES) throw audioError('SOURCE_TOO_LARGE', 'Audio source exceeds the 2 GiB staging limit');
            // File writes may be partial, even when the network chunk arrived intact.
            for (let offset = 0; offset < value.byteLength;) {
                signal.throwIfAborted();
                const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
                if (!bytesWritten) throw new Error('Unable to write audio source');
                offset += bytesWritten;
            }
        }
        signal.throwIfAborted();
        if (!bytes) throw new Error('Audio download returned an empty file');
        return { bytes };
    } catch (error) {
        if (signal.aborted) throw audioError('CANCELLED', 'Audio preparation cancelled');
        if (error.code?.startsWith('SOURCE_')) throw error;
        throw audioError('SOURCE_UNAVAILABLE', error.message);
    } finally {
        if (reader) await reader.cancel().catch(() => {});
        else await response?.body?.cancel().catch(() => {});
        await file?.close();
    }
}
module.exports = { downloadRemoteAudio, MAX_REMOTE_AUDIO_BYTES };
