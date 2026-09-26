// Read original source headers before PCM preparation; metadata failure must not block playback.
async function readSourceInfo(file) {
    try {
        const { parseFile } = await import('music-metadata');
        const { format } = await parseFile(file, { skipCovers: true, duration: false });
        return { sourceSampleRate: format.sampleRate, sourceBitsPerSample: format.bitsPerSample,
            sourceCodec: format.codec || format.container, sourceBitrate: format.bitrate };
    } catch { return {}; }
}
module.exports = { readSourceInfo };
