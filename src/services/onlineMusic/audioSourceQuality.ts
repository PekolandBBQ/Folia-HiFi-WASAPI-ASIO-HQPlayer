import type { SongResult } from '../../types';
import type { ProviderAudioMetadata, ProviderAudioSource } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// Associate a concrete source with its provider-reported tier, never the settings value at download completion.
const sources = new Map<string, ProviderAudioMetadata>();
const key = (song: SongResult, url: string) => JSON.stringify([getPlaybackSongKey(song), url]);
export function rememberAudioSourceQuality(song: SongResult, source: ProviderAudioSource) {
    const entry = key(song, source.url);
    sources.delete(entry);
    sources.set(entry, {
        ...(source.quality ? { quality: source.quality } : {}),
        ...(source.requestedQuality ? { requestedQuality: source.requestedQuality } : {}),
        ...(source.providerLevel ? { providerLevel: source.providerLevel } : {}),
        ...(source.sourceFormat ? { sourceFormat: { ...source.sourceFormat } } : {}),
        ...(source.preparedAudio ? { preparedAudio: { ...source.preparedAudio } } : {}),
        ...(source.playbackTransport ? { playbackTransport: source.playbackTransport } : {}),
    });
    while (sources.size > 512) sources.delete(sources.keys().next().value!);
}
export const getAudioSourceMetadata = (song: SongResult, url: string) => sources.get(key(song, url));
export const getAudioSourceQuality = (song: SongResult, url: string) => getAudioSourceMetadata(song, url)?.quality;
