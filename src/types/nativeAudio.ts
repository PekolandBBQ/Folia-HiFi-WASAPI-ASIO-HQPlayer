import type { HQPlayerDspSettings } from './hqplayerDsp';
import type { LoadProgress } from '../stores/usePlaybackLoadStore';
import type { AudioQualityPreference, ProviderAudioMetadata } from './onlineMusic';

// src/types/nativeAudio.ts — the Windows helper's playback and device contract.
export type NativeAudioBackend = 'browser' | 'wasapi-exclusive' | 'asio' | 'hqplayer';
export type NativeAudioProcessingMode = 'compatibility' | 'integer-direct';
/** prebufferMs is retained only for legacy migration; livePcmPrebufferMs owns the active target. */
export type HQPlayerSpotifyExperimentSettings = { enabled: boolean; prebufferMs: number; startupDelayMs: number };
export type NativeAudioDevice = { backend: Exclude<NativeAudioBackend, 'browser'>; id: string; name: string };
export type NativeAudioState = {
    preparationRevision?: number;
    livePcmPrebufferMs?: number;
    session: string; position: number; duration: number; playing: boolean; ended: boolean;
    sampleRate: number; channels: number; latency: number; backend: string; deviceId: string;
    processingMode?: NativeAudioProcessingMode; outputFormat?: string; outputMode?: string; hqplayerGainDb?: number; outputRateReported?: boolean; volumeDb?: number;
    sourceSampleRate?: number; sourceBitsPerSample?: number; sourceCodec?: string; sourceBitrate?: number;
    requestedQuality?: AudioQualityPreference; sourceQuality?: AudioQualityPreference; sourceProviderLevel?: string;
    sourceEncodingVerified?: boolean; preparedSource?: boolean; sourceOrigin?: ProviderAudioMetadata['sourceOrigin'];
    hqplayerInputContainer?: 'wav';
    // Decoded transport input is separate from the provider's original encoding and engine output.
    preparedAudio?: ProviderAudioMetadata['preparedAudio'];
    effectiveGain?: number; replayGain?: number; volume?: number; sampleValuesPreserved?: boolean;
    // Streaming ranges describe decodable PCM in song seconds, not the complete source length.
    streaming?: boolean; buffering?: boolean; bufferedStart?: number; bufferedEnd?: number; producerComplete?: boolean;
};
export type NativeAudioEvent = { event: 'state' | 'resume' | 'error' | 'progress'; progress?: LoadProgress; session: string; state?: NativeAudioState; error?: string; errorCode?: string }
    | { event: 'lifecycle-error'; errorCode: 'SOURCE_RESTORE_UNCONFIRMED'; session?: never; state?: never; progress?: never };
export type NativeAudioApi = {
    supported: boolean;
    request: (request: { action: string; reason?: 'handoff'; session?: string; backend?: string; deviceId?: string;
        hqplayerSpotifyExperiment?: HQPlayerSpotifyExperimentSettings;
        livePcmPrebufferMs?: number;
        hqplayerDefaults?: HQPlayerDspSettings | null; instancePid?: number; silent?: boolean; visible?: boolean; compatibilityMode?: boolean; trackKey?: string; settings?: HQPlayerDspSettings; when?: 'current' | 'next'; path?: string; url?: string; data?: Uint8Array; position?: number; volume?: number; gain?: number; gainDb?: number; hqplayerGainDb?: number; sourceName?: string; mimeType?: string;
        processingMode?: NativeAudioProcessingMode; duration?: number; sourceMetadata?: ProviderAudioMetadata; sessionBoundAudio?: boolean }) => Promise<unknown>;
    onEvent: (listener: (event: NativeAudioEvent) => void) => () => void;
};
