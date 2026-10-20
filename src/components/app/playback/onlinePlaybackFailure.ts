import type { TFunction } from 'i18next';
import type { SongResult, StatusMessage } from '../../../types';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { openSettings } from '../../../stores/useSettingsModalStore';

// src/components/app/playback/onlinePlaybackFailure.ts
// Track availability and connection failures have different messages and recovery actions.
export const isOnlinePlaybackCancellation = (error: unknown): boolean => (
    (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError'
);

export const getOnlineUnavailableTextKeys = (song: SongResult) => (
    song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'spotify'
        ? { message: 'spotifyPlaybackErrors.notPlayable', prompt: 'spotifyPlaybackErrors.notPlayablePrompt' } as const
        : { message: 'status.songUnavailable', prompt: 'status.songUnavailablePrompt' } as const
);

export function createOnlinePlaybackFailureStatus(error: unknown, t: TFunction): StatusMessage {
    if (!(error instanceof OnlineProviderError) || error.providerId !== 'spotify') {
        return { type: 'error', text: t('status.playbackError') };
    }
    const sourceRestore = error.message === 'Spotify: automatic-route-restore-unconfirmed';
    const coldRecovery = error.code === 'setup-required' && error.message === 'Spotify: spotify-cold-volume-recovery-required';
    const key = error.code === 'setup-required' ? 'setupRequired'
        : error.code === 'auth-required' ? 'authRequired'
        : error.code === 'network' ? 'network'
        : error.code === 'invalid-response' ? 'invalidSource'
        : error.code === 'not-playable' ? 'notPlayable'
        : error.code === 'unsupported' ? (/^Spotify: (?:playback|catalog)-http-403$/.test(error.message) ? 'forbidden' : 'unsupported')
        : 'unavailable';
    return {
        type: 'error', providerId: 'spotify', text: error.details?.userMessage || t(sourceRestore ? 'spotifyCable.sourceRestoreUnconfirmed'
            : coldRecovery ? 'spotifyCable.bootstrapRecovery' : `spotifyPlaybackErrors.${key}`),
        ...(coldRecovery ? { statusKey: 'spotify-cold-volume-recovery-required' } : {}),
        ...(error.code === 'setup-required' || sourceRestore ? {
            persistent: true,
            actionLabel: t('spotifyPlaybackErrors.openConnection'),
            onAction: () => openSettings('options', 'integration', null, 'spotifyConnection'),
        } : {}),
    };
}
