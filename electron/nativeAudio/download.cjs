const fs = require('node:fs/promises');

// electron/nativeAudio/download.cjs — stage the resolved source completely before decoding.
const MAX_REMOTE_AUDIO_BYTES = 2 * 1024 ** 3;
async function downloadRemoteAudio(url, destination, signal, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(url, { signal, redirect: 'follow' });
    let reader, file;
    try {
        if (!response.ok) throw new Error(`Audio download failed (HTTP ${response.status})`);
        if (!response.body) throw new Error('Audio download returned no body');
        if (Number(response.headers.get('content-length')) > MAX_REMOTE_AUDIO_BYTES)
            throw new Error('Audio source exceeds the 2 GiB staging limit');
        reader = response.body.getReader();
        file = await fs.open(destination, 'w');
        let bytes = 0;
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_REMOTE_AUDIO_BYTES) throw new Error('Audio source exceeds the 2 GiB staging limit');
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
    } finally {
        if (reader) await reader.cancel().catch(() => {});
        else await response.body?.cancel().catch(() => {});
        await file?.close();
    }
}
module.exports = { downloadRemoteAudio, MAX_REMOTE_AUDIO_BYTES };
