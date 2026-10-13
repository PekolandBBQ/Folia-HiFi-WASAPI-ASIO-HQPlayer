import type { OnlineProviderId } from '../../types/onlineMusic';
import { PlayerState } from '../../types';
import { usePlaybackStore } from '../../stores/usePlaybackStore';

// Logout is a normal stop, not a playback fault; leave another provider's current track alone.
export function revokeProviderPlayback(providerId: OnlineProviderId) {
    const source = usePlaybackStore.getState().currentSong?.sourceRef;
    if (source?.kind !== 'online' || source.providerId !== providerId) return;
    usePlaybackStore.setState({ audioSrc: null, playerState: PlayerState.PAUSED, transitionDisplay: null });
}
