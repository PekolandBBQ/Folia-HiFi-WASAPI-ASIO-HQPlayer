import type { SongResult } from '../types';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';

// src/services/playbackSourceRequest.ts: one pending source intent across queue, restore and recovery.
let active: AbortController | null = null;
let revision = 0;
const releases = new WeakMap<AbortController, () => void>();

export function finishPlaybackSourceRequest(request: AbortController) {
    releases.get(request)?.();
    releases.delete(request);
    if (active === request) active = null;
}

export function cancelPlaybackSourceRequest() { revision++; active?.abort(); }
export function playbackSourceRequestRevision() { return revision; }

// A new explicit queue choice supersedes a still-preparing restore before the
// displayed currentSong changes. Restores also watch direct song/context changes.
export function beginPlaybackSourceRequest(song?: SongResult, onCancel?: () => void) {
    cancelPlaybackSourceRequest();
    const request = new AbortController();
    active = request;
    const key = song ? getPlaybackSongKey(song) : null;
    const unsubscribe = key ? usePlaybackStore.subscribe((state, previous) => {
        if (state.activePlaybackContext !== previous.activePlaybackContext
            || state.currentSong !== previous.currentSong && (!state.currentSong || getPlaybackSongKey(state.currentSong) !== key)) request.abort();
    }) : () => {};
    releases.set(request, unsubscribe);
    request.signal.addEventListener('abort', () => { finishPlaybackSourceRequest(request); onCancel?.(); }, { once: true });
    return request;
}
