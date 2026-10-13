import type { ProviderPlaybackSetupStatus } from '@/types/onlineMusic';

// Public synthetic setup facts. This fixture never represents a Windows or Spotify account test.
export function cableStatus(patch: Partial<ProviderPlaybackSetupStatus> = {}): ProviderPlaybackSetupStatus {
    return { backend: 'vb-cable', state: 'stopped', driverInstalled: true, driverBundled: true, driverInstallerAvailable: true, spotifyRunning: true,
        selection: { connectDeviceId: 'desktop-1', captureDeviceId: 'capture-1', renderDeviceId: 'render-1',
            internal44100Confirmed: true, spotifyOnlyConfirmed: true, defaultsConfirmed: true },
        devices: { spotify: [{ id: 'desktop-1', name: 'Desktop', type: 'computer', isActive: true, restricted: false, selectable: true }],
            capture: [{ id: 'capture-1', name: 'CABLE Output' }], render: [{ id: 'render-1', name: 'CABLE Input' }] },
        probe: { captureSampleRate: 44100, renderMixSampleRate: 44100, captureMixSampleRate: 44100, channels: 2, routeVerified: true,
            defaultRenderIsCable: false, otherWriterCount: 0 }, ...patch };
}

// Passive readiness is only saved setup; native route/capture proof is intentionally absent.
export function automaticCableStatus(patch: Partial<ProviderPlaybackSetupStatus> = {}): ProviderPlaybackSetupStatus {
    return cableStatus({ state: 'stopped', code: 'AUTOMATIC_ROUTE_ON_PLAY', probe: undefined,
        automaticRoute: { enabled: true, supported: false, productionQualified: false, eligible: true,
            sourceOutputDefaultRequired: true, trialAvailable: true, trialAuthorized: false }, ...patch });
}
