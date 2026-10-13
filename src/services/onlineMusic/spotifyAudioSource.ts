import type { AudioQualityPreference, ProviderAudioSource } from '../../types/onlineMusic';
import { isSpotifyLivePcm } from './spotifyCableSetup';

// Map verified Spotify source facts separately from its generated PCM transport representation.
const tiers = new Set<AudioQualityPreference>(['standard', 'high', 'lossless', 'hires']);
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
export function normalizeSpotifyAudioSource(raw: Record<string, any> | null | undefined,
    requestedQuality: AudioQualityPreference): ProviderAudioSource | null {
    if (typeof raw?.url !== 'string' || !raw.url) return null;
    const actual = raw.playbackTransport !== 'cable-pcm' && tiers.has(raw.actualQuality) ? raw.actualQuality as AudioQualityPreference : undefined;
    const facts = raw.playbackTransport !== 'cable-pcm' && raw.sourceInfo?.encodingVerified === true ? raw.sourceInfo : null;
    const format = facts ? {
        ...(typeof facts.codec === 'string' && facts.codec ? { codec: facts.codec } : {}),
        ...(positive(facts.sampleRate) ? { sampleRate: facts.sampleRate } : {}),
        ...(positive(facts.bitDepth) ? { bitsPerSample: facts.bitDepth } : {}),
        ...(positive(facts.bitrate) ? { bitrate: facts.bitrate } : {}),
    } : undefined;
    const prepared = raw.preparedAudio;
    const preparedAudio = prepared && typeof prepared.representation === 'string' ? {
        representation: prepared.representation,
        ...(positive(prepared.sampleRate) ? { sampleRate: prepared.sampleRate } : {}),
        ...(positive(prepared.channels) ? { channels: prepared.channels } : {}),
        ...(positive(prepared.bitDepth) ? { bitDepth: prepared.bitDepth } : {}),
    } : undefined;
    return {
        url: raw.url, fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : Date.now(), requestedQuality,
        ...(actual ? { quality: actual } : {}),
        ...(format && Object.keys(format).length ? { sourceFormat: format } : {}),
        ...(preparedAudio ? { preparedAudio } : {}),
        ...(isSpotifyLivePcm(raw.playbackTransport) ? { playbackTransport: raw.playbackTransport as 'soloist-pcm' | 'cable-pcm' } : {}),
        ...(raw.streaming === true ? { streaming: true } : {}),
    };
}
