import type { NativeAudioApi, NativeAudioBackend, NativeAudioProcessingMode, NativeAudioState } from '../../types/nativeAudio';
import { loadNativeLocalFile } from './loadLocalFile';

// src/services/nativeAudio/loadOnlineSource.ts — consume only the source already resolved by Folia.
export async function loadNativeOnlineSource(api: NativeAudioApi, session: string, src: string,
    backend: NativeAudioBackend, deviceId: string, signal: AbortSignal, processingMode: NativeAudioProcessingMode): Promise<NativeAudioState> {
    signal.throwIfAborted();
    if (/^https?:\/\//i.test(src)) {
        await api.request({ action: 'begin', session, backend, deviceId, processingMode, url: src });
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
            backend, deviceId, signal, processingMode);
    }
    throw new Error('The audio source is unavailable or unsupported');
}
