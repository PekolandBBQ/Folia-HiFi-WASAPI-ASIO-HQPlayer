import type { SongResult } from '../types';
import { releasePlaybackProviderOutputs } from './playbackProviderOutput';
import { activatePlaybackSource } from './playbackSourceIntent';
import { omni } from './onlineMusic/omni';

// src/services/playbackSourceCommit.ts: cross-provider output commits await the exact Spotify route owner.
export async function preparePlaybackSourceCommit(song: SongResult, options: {
    signal?: AbortSignal; isCurrent?: () => boolean; source?: string | null;
} = {}) {
    const assertCurrent = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false)
            throw new DOMException('Request cancelled', 'AbortError');
    };
    assertCurrent();
    if (!(song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'spotify')) {
        await releasePlaybackProviderOutputs('spotify');
        assertCurrent();
        await omni.leavePlaybackProvider('spotify', options);
    }
    assertCurrent();
    activatePlaybackSource(options.source);
}
