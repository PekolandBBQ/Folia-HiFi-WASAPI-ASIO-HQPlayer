import { afterEach, expect, it } from 'vitest';
import type { SongResult } from '../../../src/types';
import { PlayerState } from '../../../src/types';
import { usePlaybackStore } from '../../../src/stores/usePlaybackStore';
import { revokeProviderPlayback } from '../../../src/services/onlineMusic/revokeProviderPlayback';

// Account revocation stops the owning provider's current source without losing its selected song.
afterEach(() => usePlaybackStore.setState({ currentSong: null, audioSrc: null, playerState: PlayerState.IDLE }));
it('pauses and clears the revoked source while keeping song and duration', () => {
    const song = { id: 'track', sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'track' } } as SongResult;
    usePlaybackStore.setState({ currentSong: song, audioSrc: 'http://127.0.0.1/temporary.wav', playerState: PlayerState.PLAYING, duration: 200 });
    revokeProviderPlayback('spotify');
    expect(usePlaybackStore.getState()).toMatchObject({ currentSong: song, audioSrc: null, playerState: PlayerState.PAUSED, duration: 200, transitionDisplay: null });
});
it.each(['qq', 'netease', 'local'])('does not interrupt the current %s track when Spotify logs out', provider => {
    const sourceRef = provider === 'local' ? { kind: 'local', mediaId: 'track' } : { kind: 'online', providerId: provider, mediaId: 'track' };
    const song = { id: 'track', sourceRef } as SongResult;
    usePlaybackStore.setState({ currentSong: song, audioSrc: 'blob:other', playerState: PlayerState.PLAYING });
    revokeProviderPlayback('spotify');
    expect(usePlaybackStore.getState()).toMatchObject({ currentSong: song, audioSrc: 'blob:other', playerState: PlayerState.PLAYING });
});
