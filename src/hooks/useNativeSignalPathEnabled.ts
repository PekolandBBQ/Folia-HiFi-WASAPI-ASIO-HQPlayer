import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { isStagePlaybackSong } from '../utils/appPlaybackGuards';
import { isNativeAudioSupported } from '../services/nativeAudio/capabilities';

// src/hooks/useNativeSignalPathEnabled.ts — the disclosure never changes ordinary browser controls.
export function useNativeSignalPathEnabled() {
    const enabled = useAudioSettingsStore(state => state.nativeAudioBackend === 'hqplayer' || (state.showAudioSignalPath && state.nativeAudioBackend !== 'browser'));
    const hqplayer = useAudioSettingsStore(state => state.nativeAudioBackend === 'hqplayer');
    const supportedSource = usePlaybackStore(state => state.currentSong ? !isStagePlaybackSong(state.currentSong) : hqplayer);
    return enabled && supportedSource && isNativeAudioSupported();
}
