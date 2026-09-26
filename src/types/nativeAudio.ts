// src/types/nativeAudio.ts — the Windows helper's playback and device contract.
export type NativeAudioBackend = 'browser' | 'wasapi-exclusive' | 'asio';
export type NativeAudioDevice = { backend: Exclude<NativeAudioBackend, 'browser'>; id: string; name: string };
export type NativeAudioState = {
    session: string; position: number; duration: number; playing: boolean; ended: boolean;
    sampleRate: number; channels: number; latency: number; backend: string; deviceId: string;
};
export type NativeAudioEvent = { event: 'state' | 'error'; session: string; state?: NativeAudioState; error?: string };
export type NativeAudioApi = {
    supported: boolean;
    request: (request: { action: string; session?: string; backend?: string; deviceId?: string;
        path?: string; data?: Uint8Array; position?: number; volume?: number }) => Promise<unknown>;
    onEvent: (listener: (event: NativeAudioEvent) => void) => () => void;
};
