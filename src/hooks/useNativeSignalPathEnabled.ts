import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { isStagePlaybackSong } from '../utils/appPlaybackGuards';
import { isNativeAudioSupported } from '../services/nativeAudio/capabilities';

// src/hooks/useNativeSignalPathEnabled.ts — the disclosure never changes ordinary browser controls.
export function useNativeSignalPathEnabled() {
    const enabled = useAudioSettingsStore(state => state.showAudioSignalPath && state.nativeAudioBackend !== 'browser');
    const supportedSource = usePlaybackStore(state => Boolean(state.currentSong && !isStagePlaybackSong(state.currentSong)));
    return enabled && supportedSource && isNativeAudioSupported();
}
