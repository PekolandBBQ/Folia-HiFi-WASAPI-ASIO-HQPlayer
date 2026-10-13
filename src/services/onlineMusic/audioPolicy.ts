import type { SongResult } from '../../types';

// Session-bound sources must be reauthorized by their provider instead of entering the durable media cache.
// Spotify always controls a live client; legacy persisted songs may lack the metadata flag.
export const isSessionBoundAudio = (song: SongResult) => song.sourceRef?.kind === 'online'
    && (song.sourceRef.providerId === 'spotify' || song.sourceRef.providerData?.sessionBoundAudio === true);
