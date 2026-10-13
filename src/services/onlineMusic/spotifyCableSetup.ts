import type { ProviderCableSelection, ProviderPlaybackSetupStatus } from '../../types/onlineMusic';

// Saved setup permits track-click preparation; confirmations never prove a live route or capture.
export const EMPTY_CABLE_SELECTION: ProviderCableSelection = { connectDeviceId: '', captureDeviceId: '', renderDeviceId: '',
    internal44100Confirmed: false, spotifyOnlyConfirmed: false, defaultsConfirmed: false };
export const cableSelectionComplete = (selection?: ProviderCableSelection) => Boolean(selection?.connectDeviceId
    && selection.captureDeviceId && selection.renderDeviceId && selection.internal44100Confirmed
    && selection.spotifyOnlyConfirmed);
export const cablePrerequisitesComplete = (status: ProviderPlaybackSetupStatus | null) => status?.backend === 'vb-cable'
    && status.driverInstalled === true && status.spotifyRunning === true && cableSelectionComplete(status.selection);
export const cableReady = (status: ProviderPlaybackSetupStatus | null) => cablePrerequisitesComplete(status)
    && status?.coldRecovery?.required !== true
    && (status?.automaticRoute?.enabled === true
        ? status.automaticRoute.eligible
            && (status.state === 'ready' || status.state === 'stopped' && status.code === 'AUTOMATIC_ROUTE_ON_PLAY')
        : status?.state === 'ready' && status.probe?.channels === 2 && status.probe.routeVerified === true
    && (status.probe.temporaryFormatLeaseEligible === true || status.probe.captureSampleRate === 44100
        && status.probe.captureMixSampleRate === 44100 && status.probe.renderMixSampleRate === 44100)
    && status.probe.defaultRenderIsCable !== true
    && (status.probe.otherWriterCount ?? 0) === 0);
export const isSpotifyLivePcm = (transport: unknown) => transport === 'cable-pcm' || transport === 'soloist-pcm';
