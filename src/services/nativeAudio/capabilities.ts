// src/services/nativeAudio/capabilities.ts — shared visibility for settings and command palette.
export const isNativeAudioSupported = () =>
    typeof window !== 'undefined' && Boolean(window.electron?.nativeAudio?.supported);
