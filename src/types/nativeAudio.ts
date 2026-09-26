// src/types/nativeAudio.ts — the Windows helper's playback and device contract.
export type NativeAudioBackend = 'browser' | 'wasapi-exclusive' | 'asio';
export type NativeAudioProcessingMode = 'compatibility' | 'integer-direct';
export type NativeAudioDevice = { backend: Exclude<NativeAudioBackend, 'browser'>; id: string; name: string };
export type NativeAudioState = {
    session: string; position: number; duration: number; playing: boolean; ended: boolean;
    sampleRate: number; channels: number; latency: number; backend: string; deviceId: string;
    processingMode?: NativeAudioProcessingMode; outputFormat?: string;
    sourceSampleRate?: number; sourceBitsPerSample?: number; sourceCodec?: string; sourceBitrate?: number;
    effectiveGain?: number; replayGain?: number; volume?: number; sampleValuesPreserved?: boolean;
};
export type NativeAudioEvent = { event: 'state' | 'error'; session: string; state?: NativeAudioState; error?: string };
export type NativeAudioApi = {
    supported: boolean;
    request: (request: { action: string; session?: string; backend?: string; deviceId?: string;
        path?: string; url?: string; data?: Uint8Array; position?: number; volume?: number; gain?: number;
        processingMode?: NativeAudioProcessingMode }) => Promise<unknown>;
    onEvent: (listener: (event: NativeAudioEvent) => void) => () => void;
};
