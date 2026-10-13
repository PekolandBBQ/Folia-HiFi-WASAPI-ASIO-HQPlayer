import { isNativeAudioElement, reloadRecoveredNativeSource } from '../nativeAudio/NativeAudioTransport';

// src/services/playbackRecovery/reloadRecoveredSource.ts — retry an errored deck after a same-URL refresh.
export function reloadRecoveredSource(element: HTMLAudioElement, source: string | null, onReady?: () => void): boolean {
    const ownsAttribute = () => Boolean(source && element.getAttribute('src') === source);
    // A rejected browser source can leave currentSrc empty; the assigned source still identifies its owner.
    if (!element.error || !ownsAttribute() || element.currentSrc && element.currentSrc !== source) return false;
    const cleanup = () => {
        element.removeEventListener('canplay', ready);
        element.removeEventListener('error', cleanup);
    };
    const ready = () => {
        cleanup();
        if (ownsAttribute() && element.currentSrc === source && !element.error) onReady?.();
    };
    element.addEventListener('error', cleanup, { once: true });
    try {
        if (isNativeAudioElement(element)) {
            const reloaded = reloadRecoveredNativeSource(element, source, ready);
            if (!reloaded) cleanup();
            return reloaded;
        }
        element.addEventListener('canplay', ready, { once: true });
        element.load();
        return true;
    } catch (error) {
        cleanup();
        throw error;
    }
}
