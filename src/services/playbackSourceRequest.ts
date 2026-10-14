import type { SongResult } from '../types';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';

// src/services/playbackSourceRequest.ts: one pending source intent across queue, restore and recovery.
let active: AbortController | null = null;
let revision = 0;
const releases = new WeakMap<AbortController, () => void>();
const completion = new WeakMap<AbortController, { promise: Promise<void>; resolve: () => void }>();

export function finishPlaybackSourceRequest(request: AbortController) {
    releases.get(request)?.();
    releases.delete(request);
    if (active === request) active = null;
    completion.get(request)?.resolve();
    completion.delete(request);
}

export const hasPendingPlaybackSourceRequest = () => active !== null;
// An output change must not reopen the old deck while a new queue selection is resolving.
export async function waitForPlaybackSourceRequest() {
    while (active) {
        const pending = completion.get(active);
        if (!pending) return;
        await pending.promise;
    }
}

export function cancelPlaybackSourceRequest() { revision++; active?.abort(); }
export function playbackSourceRequestRevision() { return revision; }

// A new explicit queue choice supersedes a still-preparing restore before the
// displayed currentSong changes. Restores also watch direct song/context changes.
export function beginPlaybackSourceRequest(song?: SongResult, onCancel?: () => void) {
    cancelPlaybackSourceRequest();
    const request = new AbortController();
    active = request;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    completion.set(request, { promise, resolve });
    const key = song ? getPlaybackSongKey(song) : null;
    const unsubscribe = key ? usePlaybackStore.subscribe((state, previous) => {
        if (state.activePlaybackContext !== previous.activePlaybackContext
            || state.currentSong !== previous.currentSong && (!state.currentSong || getPlaybackSongKey(state.currentSong) !== key)) request.abort();
    }) : () => {};
    releases.set(request, unsubscribe);
    request.signal.addEventListener('abort', () => { finishPlaybackSourceRequest(request); onCancel?.(); }, { once: true });
    return request;
}
