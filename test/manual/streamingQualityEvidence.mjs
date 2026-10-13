import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';

// Validate the encoded source currently loaded by the browser, not another request made later.
const ranks = { standard: 0, high: 1, lossless: 2, hires: 3 };
export function findQualityReferenceIndex(songs, provider, referenceId) {
    const expected = String(referenceId);
    // QQ has a numeric song id and a distinct songMid used by sourceRef. The first
    // explicit reference can name either; subsequent tiers lock the selected mediaId.
    return songs.findIndex(song => song.sourceRef?.providerId === provider
        && (String(song.id) === expected || String(song.sourceRef?.mediaId ?? song.id) === expected));
}
export function qualityOutcome(requested, actual) {
    if (!(requested in ranks) || !(actual in ranks)) throw new Error('Actual source tier is unknown');
    if (ranks[actual] > ranks[requested]) throw new Error('Returned tier exceeds the selected request; source association must be checked');
    return actual === requested ? 'requested-tier' : 'provider-fallback';
}

export function assertEncodedQuality(provider, requested, metadata, header) {
    const outcome = qualityOutcome(requested, metadata?.quality);
    if (metadata.requestedQuality !== requested || !header?.codec || !header.sampleRate)
        throw new Error('Loaded source lacks matching quality metadata or an encoded header');
    if (metadata.preparedAudio) throw new Error('Prepared PCM cannot establish original source quality');
    if (['lossless', 'hires'].includes(metadata.quality) && header.lossless !== true)
        throw new Error('Selected lossless tier did not contain an original lossless source');
    if (metadata.quality === 'hires' && !(header.bitsPerSample > 16 || header.sampleRate > 48000))
        throw new Error('Selected HiRes tier did not contain a verifiable HiRes source');
    if (['netease', 'qq'].includes(provider) && ['standard', 'high'].includes(metadata.quality)) {
        const expected = metadata.quality === 'standard' ? 128000 : 320000;
        if (!/layer 3|mp3/i.test(header.codec) || !header.bitrate || Math.abs(header.bitrate - expected) > 1000)
            throw new Error('Loaded compressed source bitrate does not match the actual tier');
    }
    const reported = metadata.sourceFormat;
    if (reported?.sampleRate && reported.sampleRate !== header.sampleRate)
        throw new Error('Reported original sample rate does not match loaded source');
    if (reported?.bitsPerSample && reported.bitsPerSample !== header.bitsPerSample)
        throw new Error('Reported original bit depth does not match loaded source');
    if (reported?.bitrate && !header.lossless && Math.abs(reported.bitrate - header.bitrate) > 1000)
        throw new Error('Reported original bitrate does not match loaded source');
    return outcome;
}

export function assertNativeSourceFacts(facts, evidence, backend, requested) {
    if (facts?.backend !== backend || !facts.session || !facts.sourceEncodingVerified)
        throw new Error('Quality evidence is not from the current verified native output');
    if (facts.requestedQuality !== requested || facts.sourceQuality !== evidence.metadata.quality)
        throw new Error('Native original source tier does not match the loaded source');
    if (facts.sourceSampleRate !== evidence.header.sampleRate)
        throw new Error('Native original sample rate differs from the browser source header');
    if (evidence.header.bitsPerSample && facts.sourceBitsPerSample !== evidence.header.bitsPerSample)
        throw new Error('Native original bit depth differs from the browser source header');
    if (evidence.header.bitrate && !evidence.header.lossless && (!facts.sourceBitrate || Math.abs(facts.sourceBitrate - evidence.header.bitrate) > 1000))
        throw new Error('Native original bitrate differs from the browser source header');
    const expectedCodec = /layer 3|mp3/i.test(evidence.header.codec) ? /mp3|mpeg/i
        : /flac/i.test(evidence.header.codec) ? /flac/i : /alac/i.test(evidence.header.codec) ? /alac/i : /vorbis/i;
    if (!expectedCodec.test(facts.sourceCodec || '')) throw new Error('Native original codec differs from the browser source header');
}

export async function inspectCurrentBrowserSource(page) {
    const prefix = await page.evaluate(async () => {
        const q = window.outputRegression, state = q.player.getState(), url = state.audioSrc;
        const audio = [...document.querySelectorAll('audio')].find(item => item.getAttribute('src') === url && !item.paused);
        if (!url || !audio || audio.readyState < 2) throw new Error('No current browser source is playing');
        const response = await fetch(url, { headers: { Range: 'bytes=0-262143' }, signal: AbortSignal.timeout(20000) });
        if (!response.ok || !response.body) throw new Error('Current source prefix unavailable');
        const reader = response.body.getReader(), chunks = []; let length = 0;
        try {
            while (length < 262144) {
                const { value, done } = await reader.read(); if (done) break;
                const bytes = value.subarray(0, 262144 - length); chunks.push(bytes); length += bytes.length;
            }
        } finally { await reader.cancel(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        if (q.player.getState().audioSrc !== url) throw new Error('Source changed while inspecting its encoded prefix');
        const song = state.currentSong;
        return { bytes: Array.from(bytes), sourceTag: q.sourceTag(url), provider: song.sourceRef?.providerId,
            mediaId: String(song.sourceRef?.mediaId ?? song.id), metadata: q.getAudioSourceMetadata(song, url),
            request: q.qualityRequests.slice(q.caseCursor).filter(item => item.provider === song.sourceRef?.providerId
                && item.mediaId === String(song.sourceRef?.mediaId ?? song.id) && item.requested === q.currentQuality
                && item.sourceTag === q.sourceTag(url) && item.available).at(-1), httpStatus: response.status };
    });
    const { bytes, ...evidence } = prefix, buffer = Buffer.from(bytes);
    const parsed = await parseBuffer(buffer, undefined, { duration: false, skipCovers: true });
    const { codec, container, sampleRate, bitsPerSample, bitrate, lossless, numberOfChannels } = parsed.format;
    return { ...evidence, header: { codec, container, sampleRate, bitsPerSample, lossless, numberOfChannels,
        ...(!lossless ? { bitrate } : {}), prefixBytes: buffer.length, prefixSha256: createHash('sha256').update(buffer).digest('hex') } };
}
