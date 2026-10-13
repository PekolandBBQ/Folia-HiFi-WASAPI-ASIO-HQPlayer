const { audioError } = require('./errors.cjs');

// Read original source headers before PCM preparation; metadata failure must not block playback.
async function readSourceInfo(file, { complete = true } = {}) {
    try {
        const { parseFile } = await import('music-metadata');
        const { format } = await parseFile(file, { skipCovers: true, duration: false });
        // A partial lossless file can yield an average computed from prefix size
        // divided by full duration. PCM rates are exact; compressed averages are not.
        const partialLossless = !complete && (format.lossless || /flac|alac|ape|wavpack|truehd/i.test(format.codec || format.container || ''))
            && !/pcm/i.test(format.codec || '');
        return { sourceSampleRate: format.sampleRate, sourceBitsPerSample: format.bitsPerSample,
            sourceCodec: format.codec || format.container, sourceBitrate: partialLossless ? undefined : format.bitrate };
    } catch { return {}; }
}
// Renderer source facts are optional telemetry, with bounded fields only. A
// prepared PCM source is deliberately distinct from its original encoding.
function normalizeSourceMetadata(value) {
    if (value == null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) throw audioError('INVALID_REQUEST', 'Invalid source metadata');
    const result = {};
    for (const field of ['requestedQuality', 'quality']) {
        if (value[field] == null) continue;
        if (!['standard', 'high', 'lossless', 'hires'].includes(value[field])) throw audioError('INVALID_REQUEST', 'Invalid source quality');
        result[field] = value[field];
    }
    const text = (input, maximum) => {
        if (typeof input !== 'string' || !input || input.length > maximum || /[\x00-\x1f]/.test(input)) throw audioError('INVALID_REQUEST', 'Invalid source format');
        return input;
    };
    if (value.providerLevel != null) result.providerLevel = text(value.providerLevel, 64);
    for (const field of ['sourceFormat', 'preparedAudio']) {
        if (value[field] == null) continue;
        const input = value[field];
        if (typeof input !== 'object' || Array.isArray(input)) throw audioError('INVALID_REQUEST', 'Invalid source format');
        const format = {};
        const label = field === 'sourceFormat' ? 'codec' : 'representation';
        if (input[label] != null) format[label] = text(input[label], 64);
        if (field === 'preparedAudio' && !format.representation) throw audioError('INVALID_REQUEST', 'Missing prepared audio representation');
        const numeric = field === 'sourceFormat' ? { sampleRate: 1536000, bitsPerSample: 64, bitrate: 100000000 } : { sampleRate: 1536000, channels: 8, bitDepth: 64 };
        for (const [key, maximum] of Object.entries(numeric)) {
            if (input[key] == null) continue;
            if (!Number.isFinite(input[key]) || input[key] <= 0 || input[key] > maximum) throw audioError('INVALID_REQUEST', 'Invalid source format');
            format[key] = input[key];
        }
        result[field] = format;
    }
    return result;
}

async function readOriginalSourceInfo(current, read = readSourceInfo) {
    const metadata = current.sourceMetadata || {}, format = metadata.sourceFormat || {};
    // Explicit undefined values also override helper telemetry from a generated
    // WAV. Otherwise PCM32 could be mistaken for the provider's original audio.
    const original = { sourceSampleRate: format.sampleRate, sourceBitsPerSample: format.bitsPerSample,
        sourceCodec: format.codec, sourceBitrate: format.bitrate };
    if (!metadata.preparedAudio) {
        const measured = await read(current.input, { complete: current.stream?.source?.state.complete !== false });
        for (const [key, value] of Object.entries(measured)) if (value !== undefined) original[key] = value;
    }
    return { ...original, requestedQuality: metadata.requestedQuality, sourceQuality: metadata.quality,
        sourceProviderLevel: metadata.providerLevel, sourceEncodingVerified: Boolean(original.sourceCodec),
        preparedSource: Boolean(metadata.preparedAudio),
        ...(metadata.preparedAudio ? { preparedAudio: { ...metadata.preparedAudio } } : {}) };
}
module.exports = { readSourceInfo, normalizeSourceMetadata, readOriginalSourceInfo };
