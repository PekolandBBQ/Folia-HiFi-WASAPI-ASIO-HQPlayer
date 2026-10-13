import type { AudioQualityPreference, ProviderAudioSource } from '../../types/onlineMusic';
import { toFiniteNumber } from '../../utils/replayGain';

// Preserve the actual URL response tier and format, including lower-tier fallbacks and unknown metadata.
const levels = new Map<string, AudioQualityPreference>([
    ['standard', 'standard'], ['higher', 'high'], ['exhigh', 'high'], ['lossless', 'lossless'], ['hires', 'hires'],
]);
const codecs = new Set(['mp3', 'flac', 'aac', 'opus', 'vorbis', 'alac']);
const positiveNumber = (value: unknown) => {
    const numeric = toFiniteNumber(value);
    return numeric !== undefined && numeric > 0 ? numeric : undefined;
};

export function normalizeNeteaseAudioSource(raw: Record<string, unknown> | null | undefined,
    requestedQuality: AudioQualityPreference): ProviderAudioSource | null {
    if (!raw?.url) return null;
    const providerLevel = typeof raw.level === 'string' ? raw.level.trim().toLowerCase() : undefined;
    const quality = providerLevel ? levels.get(providerLevel) : undefined;
    // NetEase's encodeType can remain "mp3" when the returned file's type is FLAC.
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
    const codec = codecs.has(type) ? type : undefined;
    const sampleRate = positiveNumber(raw.sr);
    const bitsPerSample = positiveNumber(raw.bitsPerSample ?? raw.bitDepth);
    const bitrate = positiveNumber(raw.br);
    const sourceFormat = {
        ...(codec ? { codec } : {}),
        ...(sampleRate === undefined ? {} : { sampleRate }),
        ...(bitsPerSample === undefined ? {} : { bitsPerSample }),
        ...(bitrate === undefined ? {} : { bitrate }),
    };
    const trackGain = toFiniteNumber(raw.gain);
    return {
        url: String(raw.url).replace(/^http:/, 'https:'), fetchedAt: Date.now(), requestedQuality,
        ...(quality ? { quality } : {}),
        ...(providerLevel ? { providerLevel } : {}),
        ...(Object.keys(sourceFormat).length ? { sourceFormat } : {}),
        ...(trackGain === undefined ? {} : { replayGain: { trackGain } }),
    };
}
