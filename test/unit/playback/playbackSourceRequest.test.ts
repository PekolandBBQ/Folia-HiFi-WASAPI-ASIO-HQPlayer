import { afterEach, expect, it, vi } from 'vitest';
import { beginPlaybackSourceRequest, cancelPlaybackSourceRequest, finishPlaybackSourceRequest,
    playbackSourceRequestRevision } from '@/services/playbackSourceRequest';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import type { SongResult } from '@/types';

// test/unit/playback/playbackSourceRequest.test.ts: pending source ownership never outlives its replacement.
const song = { id: 'one', name: 'One', artists: [], album: { id: 'album', name: 'Album' }, durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'one' } } as SongResult;
afterEach(() => cancelPlaybackSourceRequest());

it('records explicit Pause/cancel even before any source owner exists', () => {
    cancelPlaybackSourceRequest(); const before = playbackSourceRequestRevision();
    cancelPlaybackSourceRequest(); expect(playbackSourceRequestRevision()).toBe(before + 1);
});

it('cancels the old intent before creating its replacement and never lets old finish clear the new owner', () => {
    const cancelled = vi.fn(), before = playbackSourceRequestRevision();
    const first = beginPlaybackSourceRequest(undefined, cancelled), second = beginPlaybackSourceRequest();
    expect(first.signal.aborted).toBe(true); expect(cancelled).toHaveBeenCalledOnce();
    expect(playbackSourceRequestRevision()).toBe(before + 2);
    finishPlaybackSourceRequest(first); cancelPlaybackSourceRequest();
    expect(second.signal.aborted).toBe(true);
});

it('keeps same-song metadata updates alive but cancels on direct song/context change', () => {
    usePlaybackStore.setState({ currentSong: song, activePlaybackContext: 'main' });
    const request = beginPlaybackSourceRequest(song);
    usePlaybackStore.setState({ currentSong: { ...song, name: 'Updated title' } });
    expect(request.signal.aborted).toBe(false);
    usePlaybackStore.setState({ activePlaybackContext: 'stage' }); expect(request.signal.aborted).toBe(true);
    const next = beginPlaybackSourceRequest(song);
    usePlaybackStore.setState({ currentSong: null }); expect(next.signal.aborted).toBe(true);
});

it('releases observers after completion without cancelling a successfully prepared source', () => {
    usePlaybackStore.setState({ currentSong: song, activePlaybackContext: 'main' });
    const request = beginPlaybackSourceRequest(song), cancelled = vi.fn(); request.signal.addEventListener('abort', cancelled);
    finishPlaybackSourceRequest(request);
    usePlaybackStore.setState({ currentSong: null }); cancelPlaybackSourceRequest();
    expect(cancelled).not.toHaveBeenCalled(); expect(request.signal.aborted).toBe(false);
});
