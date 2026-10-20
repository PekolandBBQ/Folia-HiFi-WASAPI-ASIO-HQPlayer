import type { SongResult } from '../types';
import { releasePlaybackProviderOutputs } from './playbackProviderOutput';
import { activatePlaybackSource } from './playbackSourceIntent';
import { omni } from './onlineMusic/omni';
import { setStatusMessage } from '../stores/useStatusMessageStore';

// src/services/playbackSourceCommit.ts: retire Spotify output before committing another provider.
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
    if (!(song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'spotify'))
        setStatusMessage(current => current?.providerId === 'spotify' ? null : current);
    activatePlaybackSource(options.source);
}
