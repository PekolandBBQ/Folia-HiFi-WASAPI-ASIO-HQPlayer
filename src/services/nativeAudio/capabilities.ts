// src/services/nativeAudio/capabilities.ts — shared visibility for settings and command palette.
export const isNativeAudioSupported = () =>
    typeof window !== 'undefined' && window.electron?.platform === 'win32'
    && window.electron.nativeAudio?.supported === true
    && typeof window.electron.nativeAudio.request === 'function';
