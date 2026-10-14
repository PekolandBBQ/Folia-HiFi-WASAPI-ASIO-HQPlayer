import { isNativeAudioElement, NativeAudioTransport } from './NativeAudioTransport';

// src/services/nativeAudio/metadataCheckpoint.ts — metadata must not restart a prepared PCM producer at the same position.
export function applyPlaybackMetadataCheckpoint(audio: HTMLAudioElement, position: number, outputHandoffPending: boolean) {
    if (outputHandoffPending) return;
    if (isNativeAudioElement(audio)
        && Math.abs((audio as unknown as NativeAudioTransport).getOutputPosition() - position) <= 0.001) return;
    audio.currentTime = position;
}
