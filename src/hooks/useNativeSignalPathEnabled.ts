import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { isStagePlaybackSong } from '../utils/appPlaybackGuards';
import { isNativeAudioSupported } from '../services/nativeAudio/capabilities';
import { isSpotifyLivePcm } from '../services/onlineMusic/spotifyCableSetup';
import { getAudioSourceMetadata } from '../services/onlineMusic/audioSourceQuality';

// src/hooks/useNativeSignalPathEnabled.ts — browser visibility requires a source with an observed PCM transport.
export function useNativeSignalPathEnabled() {
    const selected = useAudioSettingsStore(state => state.nativeAudioBackend);
    const enabled = useAudioSettingsStore(state => state.showAudioSignalPath);
    const song = usePlaybackStore(state => state.currentSong);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const hqplayer = selected === 'hqplayer';
    const supportedSource = song ? !isStagePlaybackSong(song) && Boolean(audioSrc) : hqplayer;
    const browserPcm = Boolean(song && audioSrc && isSpotifyLivePcm(getAudioSourceMetadata(song, audioSrc)?.playbackTransport));
    return (hqplayer || enabled) && supportedSource && (selected === 'browser' ? browserPcm : isNativeAudioSupported());
}
