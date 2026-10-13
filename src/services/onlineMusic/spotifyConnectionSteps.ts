import type { ProviderPlaybackSetupStatus } from '../../types/onlineMusic';
import { cablePrerequisitesComplete, cableReady } from './spotifyCableSetup';

// The guide saves one-time setup. Track clicks own technical route and capture checks.
export const SPOTIFY_CONNECTION_STEPS = ['catalog', 'desktop', 'cable', 'ready'] as const;
export type SpotifyConnectionStep = typeof SPOTIFY_CONNECTION_STEPS[number];
export function getSpotifyConnectionStep(catalogAuthorized: boolean, status: ProviderPlaybackSetupStatus | null): SpotifyConnectionStep {
    if (!catalogAuthorized) return 'catalog';
    if (!status?.spotifyRunning || !status.selection?.connectDeviceId || status.code === 'DEVICE_INACTIVE') return 'desktop';
    if (!cablePrerequisitesComplete(status)) return 'cable';
    return cableReady(status) ? 'ready' : 'cable';
}
export function getSpotifyConnectionView(step: SpotifyConnectionStep, review: number | null) {
    const current = SPOTIFY_CONNECTION_STEPS.indexOf(step);
    const viewed = review == null ? current : Math.max(0, Math.min(review, current));
    return { current, viewed, step: SPOTIFY_CONNECTION_STEPS[viewed], reviewing: viewed < current };
}
