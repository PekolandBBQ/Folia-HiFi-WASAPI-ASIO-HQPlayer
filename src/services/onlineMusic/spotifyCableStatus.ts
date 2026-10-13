import type { ProviderPlaybackSetupStatus } from '../../types/onlineMusic';

// Explicit renderer projection: native process paths, driver internals and accidental fields stay outside UI state.
const states = new Set<ProviderPlaybackSetupStatus['state']>(['unsupported', 'driver-missing', 'spotify-missing', 'selection-required',
    'routing-required', 'format-mismatch', 'stopped', 'probing', 'starting', 'ready', 'failed']);
const text = (value: unknown, maximum = 2048) => typeof value === 'string' ? value.slice(0, maximum) : '';
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
export function normalizeCableSetupStatus(value: ProviderPlaybackSetupStatus,
    previousDevices?: ProviderPlaybackSetupStatus['devices']): ProviderPlaybackSetupStatus {
    const selection = value.selection, probe = value.probe, recovery = value.coldRecovery;
    const recoveryDevice = text(recovery?.deviceId, 256);
    const recoveryVolume = Number.isInteger(recovery?.originalVolume) && recovery!.originalVolume! >= 0 && recovery!.originalVolume! <= 100
        ? recovery!.originalVolume : undefined;
    const endpoints = (values: Array<{ id: string; name: string }> | undefined) => Array.isArray(values)
        ? values.slice(0, 256).map(device => ({ id: text(device.id), name: text(device.name, 256) })) : [];
    return { backend: value.backend === 'vb-cable' ? 'vb-cable' : undefined, state: states.has(value.state) ? value.state : 'failed',
        driverInstalled: value.driverInstalled === true, driverBundled: value.driverBundled === true,
        driverInstallerAvailable: value.driverInstallerAvailable === true, spotifyRunning: value.spotifyRunning === true,
        ...(value.automaticRoute ? { automaticRoute: { enabled: value.automaticRoute.enabled === true, supported: value.automaticRoute.supported === true,
            productionQualified: value.automaticRoute.productionQualified === true, eligible: value.automaticRoute.eligible === true,
            sourceOutputDefaultRequired: value.automaticRoute.sourceOutputDefaultRequired === true,
            trialAvailable: value.automaticRoute.trialAvailable === true, trialAuthorized: value.automaticRoute.trialAuthorized === true } } : {}),
        ...(recovery ? { coldRecovery: { required: recovery.archived !== true && recovery.required === true,
            recoverable: recovery.archived !== true && recovery.required === true && recovery.recoverable === true && Boolean(recoveryDevice)
                && recoveryDevice === selection?.connectDeviceId && recoveryVolume !== undefined,
            sourceControlUnconfirmed: recovery.sourceControlUnconfirmed === true,
            ...(recovery.archived === true ? { archived: true, unresolvedHistorical: recovery.unresolvedHistorical === true } : {}),
            ...(recoveryDevice ? { deviceId: recoveryDevice } : {}),
            ...(recoveryVolume !== undefined ? { originalVolume: recoveryVolume } : {}) } } : {}),
        ...(selection ? { selection: { connectDeviceId: text(selection.connectDeviceId), captureDeviceId: text(selection.captureDeviceId),
            renderDeviceId: text(selection.renderDeviceId), internal44100Confirmed: selection.internal44100Confirmed === true,
            spotifyOnlyConfirmed: selection.spotifyOnlyConfirmed === true, defaultsConfirmed: selection.defaultsConfirmed === true } } : {}),
        ...(value.devices ? { devices: {
            spotify: Array.isArray(value.devices.spotify) ? value.devices.spotify.slice(0, 256).map(device => ({
                id: typeof device.id === 'string' ? text(device.id, 256) : null, name: text(device.name, 256), type: text(device.type, 32),
                isActive: device.isActive === true, restricted: device.restricted !== false,
                selectable: device.selectable === true && typeof device.id === 'string' && Boolean(device.id) && device.restricted === false,
            })) : [], capture: endpoints(value.devices.capture), render: endpoints(value.devices.render),
        } } : previousDevices ? { devices: previousDevices } : {}),
        ...(probe ? { probe: { captureSampleRate: positive(probe.captureSampleRate), renderMixSampleRate: positive(probe.renderMixSampleRate),
            captureMixSampleRate: positive(probe.captureMixSampleRate), channels: positive(probe.channels), routeVerified: probe.routeVerified === true,
            defaultRenderIsCable: probe.defaultRenderIsCable === true,
            ...(Number.isSafeInteger(probe.otherWriterCount) && probe.otherWriterCount! >= 0 ? { otherWriterCount: probe.otherWriterCount } : {}),
            temporaryFormatLeaseEligible: probe.temporaryFormatLeaseEligible === true, temporaryFormatLease: probe.temporaryFormatLease === true,
            formatLeaseApplied: probe.formatLeaseApplied === true } } : {}),
        ...(typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? { code: value.code } : {}),
    };
}
