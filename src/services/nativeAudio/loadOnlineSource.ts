import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { normalizeLivePcmPrebufferMs } from '../../utils/livePcmPrebuffer';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import type { HQPlayerSpotifyExperimentSettings, NativeAudioApi, NativeAudioBackend, NativeAudioProcessingMode, NativeAudioState } from '../../types/nativeAudio';
import { loadNativeLocalFile } from './loadLocalFile';
import { getAudioSourceMetadata } from '../onlineMusic/audioSourceQuality';
import { isSessionBoundAudio } from '../onlineMusic/audioPolicy';
import { normalizeHQPlayerSpotifyExperiment } from '../../utils/hqplayerSpotifyExperiment';

// src/services/nativeAudio/loadOnlineSource.ts — consume only the source already resolved by Folia.
export async function loadNativeOnlineSource(api: NativeAudioApi, session: string, src: string,
    backend: NativeAudioBackend, deviceId: string, signal: AbortSignal, processingMode: NativeAudioProcessingMode, hqplayerGainDb = -2, trackKey?: string, compatibilityMode = false,
    spotifyExperiment: HQPlayerSpotifyExperimentSettings = useHQPlayerSettingsStore.getState().spotifyExperiment, initialPosition?: number,
    livePcmPrebufferMs = useAudioSettingsStore.getState().livePcmPrebufferMs): Promise<NativeAudioState> {
    signal.throwIfAborted();
    const playback = usePlaybackStore.getState();
    const song = playback.currentSong;
    const matching = song && playback.audioSrc === src && (!trackKey || getPlaybackSongKey(song) === trackKey);
    const sourceMetadata = matching ? getAudioSourceMetadata(song, src) : undefined;
    const sessionBoundAudio = Boolean(matching && isSessionBoundAudio(song));
    if (/^https?:\/\//i.test(src) || /^folia-transcode:\/\/media\/[a-f0-9]{64}\/audio\.(flac|wav)$/.test(src)) {
        const duration = matching
            && Number.isFinite(song.durationMs) && song.durationMs! > 0 ? song.durationMs! / 1000 : undefined;
        await api.request({ action: 'begin', livePcmPrebufferMs: normalizeLivePcmPrebufferMs(livePcmPrebufferMs), ...(initialPosition === undefined ? {} : { position: initialPosition }), ...(backend === 'hqplayer' ? { hqplayerDefaults: useHQPlayerSettingsStore.getState().dspDefaults,
            hqplayerSpotifyExperiment: normalizeHQPlayerSpotifyExperiment(spotifyExperiment) } : {}), silent: useHQPlayerSettingsStore.getState().silentLaunch, session, trackKey, compatibilityMode, backend, deviceId, processingMode, ...(duration ? { duration } : {}), ...(sourceMetadata ? { sourceMetadata } : {}), ...(sessionBoundAudio ? { sessionBoundAudio } : {}), ...(backend === 'hqplayer' ? { hqplayerGainDb } : {}), url: src });
        signal.throwIfAborted();
        const state = await api.request({ action: 'finish', session }) as NativeAudioState;
        signal.throwIfAborted();
        return state;
    }
    if (src.startsWith('blob:')) {
        const response = await fetch(src, { signal });
        if (!response.ok) throw new Error('The cached audio source is unavailable');
        const blob = await response.blob();
        signal.throwIfAborted();
        return loadNativeLocalFile(api, session, new File([blob], 'cached.audio', { type: blob.type }),
            backend, deviceId, signal, processingMode, hqplayerGainDb, trackKey, compatibilityMode, sourceMetadata, sessionBoundAudio);
    }
    throw new Error('The audio source is unavailable or unsupported');
}
