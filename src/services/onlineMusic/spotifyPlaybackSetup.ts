import { createStore } from 'zustand/vanilla';
import { omni } from './omni';
import { cablePrerequisitesComplete } from './spotifyCableSetup';
import { normalizeCableSetupStatus } from './spotifyCableStatus';
import { setStatusMessage, useStatusMessageStore } from '../../stores/useStatusMessageStore';
import type { AudioSourceRequestOptions, ProviderPlaybackSetupRequest, ProviderPlaybackSetupStatus } from '../../types/onlineMusic';

// One transient setup owner serves the guide, settings and palette. Main persists device choices.
type SetupOperation = Exclude<ProviderPlaybackSetupRequest['operation'], 'status'>;
type SetupProgress = NonNullable<AudioSourceRequestOptions['onProgress']> extends (value: infer T) => void ? T : never;
export type SpotifyPlaybackSetupState = {
    status: ProviderPlaybackSetupStatus | null;
    busy: boolean;
    operation: SetupOperation | null;
    progress: SetupProgress | null;
    message: 'selectionSaved' | 'coldRecoveryUnconfirmed' | 'readFailed' | 'failed' | null;
};
type SetupDependencies = {
    supported: () => boolean;
    request: (input: ProviderPlaybackSetupRequest, options?: AudioSourceRequestOptions) => Promise<ProviderPlaybackSetupStatus>;
};

export function createSpotifyPlaybackSetupController({ supported, request }: SetupDependencies) {
    const store = createStore<SpotifyPlaybackSetupState>(() => ({ status: null, busy: false, operation: null, progress: null, message: null }));
    let generation = 0, consumers = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let reading: { generation: number; promise: Promise<boolean> } | undefined;
    const canRun = (operation: SetupOperation) => {
        const { status, busy, operation: active } = store.getState();
        if (!supported() || ['saveKey', 'keyPage'].includes(operation)) return false;
        if (operation === 'checkColdRecovery') return !busy && status?.coldRecovery?.required === true && status.coldRecovery.recoverable === true;
        if (status?.state === 'unsupported' && !['saveSelection', 'devices', 'openSoundSettings'].includes(operation)) return false;
        if (operation === 'stop') return active !== 'stop' && (busy || ['probing', 'starting', 'ready'].includes(status?.state || ''));
        if (busy) return false;
        if (operation === 'openDriver') return status?.driverBundled === true && status.driverInstallerAvailable === true;
        if (operation === 'openCablePanel') return status?.driverInstalled === true;
        if (operation === 'start' || operation === 'probe') return cablePrerequisitesComplete(status);
        return true;
    };
    const scheduleRefresh = () => {
        const state = store.getState();
        const needed = consumers > 0 && supported() && !state.busy
            && ['starting', 'probing'].includes(state.status?.state || '');
        if (!needed && timer) { clearInterval(timer); timer = undefined; }
        if (needed && !timer) timer = setInterval(() => void refresh(), 2000);
    };
    const update = (patch: Partial<SpotifyPlaybackSetupState>) => { store.setState(patch); scheduleRefresh(); };
    const statusOnly = (value: ProviderPlaybackSetupStatus) => normalizeCableSetupStatus(value, store.getState().status?.devices);
    const refresh = (): Promise<boolean> => {
        if (!supported() || store.getState().busy) return Promise.resolve(false);
        const current = generation;
        if (reading?.generation === current) return reading.promise;
        const pending = { generation: current, promise: Promise.resolve(false) };
        reading = pending;
        pending.promise = Promise.resolve().then(() => request({ operation: 'status' }))
            .then(value => {
                if (generation !== current) return false;
                update({ status: statusOnly(value), ...(store.getState().message === 'readFailed' ? { message: null } : {}) });
                return true;
            })
            .catch(() => {
                if (generation === current && !['failed', 'coldRecoveryUnconfirmed'].includes(store.getState().message || '')) update({ message: 'readFailed' });
                return false;
            })
            .finally(() => { if (reading === pending) reading = undefined; });
        return pending.promise;
    };
    // Stop supersedes an in-flight start. Only the newest request may publish
    // progress, status or completion, including a late read-only status response.
    const run = async (input: ProviderPlaybackSetupRequest): Promise<boolean> => {
        if (input.operation === 'status') return refresh();
        if (!canRun(input.operation) || (input.operation === 'saveSelection' && !input.selection)) return false;
        const current = ++generation;
        const recoveryMessage = input.operation === 'checkColdRecovery' ? useStatusMessageStore.getState().message : null;
        update({ busy: true, operation: input.operation, message: null, progress: null });
        let failed = false;
        try {
            const result = await request(input, { onProgress: progress => {
                if (generation === current) update({ progress: { stage: progress.stage, loaded: progress.loaded, total: progress.total, unit: progress.unit } });
            } });
            if (generation !== current) return false;
            update({ status: statusOnly(result), ...(input.operation === 'saveSelection' ? { message: 'selectionSaved' as const }
                : input.operation === 'checkColdRecovery' && result.coldRecovery?.required ? { message: 'coldRecoveryUnconfirmed' as const } : {}) });
            // Only this verified check owns its original recovery toast; newer failures must survive.
            if (generation === current && input.operation === 'checkColdRecovery'
                && result.coldRecovery?.required === false && result.coldRecovery?.archived !== true
                && result.code !== 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED'
                && recoveryMessage?.statusKey === 'spotify-cold-volume-recovery-required') {
                setStatusMessage(message => message === recoveryMessage ? null : message);
            }
            return true;
        } catch {
            if (generation === current) { failed = true; update({ message: input.operation === 'checkColdRecovery' ? 'coldRecoveryUnconfirmed' : 'failed' }); }
            return false;
        } finally {
            if (generation === current) {
                update({ busy: false, operation: null, progress: null });
                if (failed) void refresh();
            }
        }
    };
    const activate = () => {
        consumers++; void refresh(); scheduleRefresh();
        let active = true;
        return () => { if (active) { active = false; consumers--; scheduleRefresh(); } };
    };
    return { store, canRun, run, refresh, activate };
}

export const spotifyPlaybackSetup = createSpotifyPlaybackSetupController({
    supported: () => omni.hasProviderPlaybackSetup('spotify'),
    request: (input, options) => omni.requestProviderPlaybackSetup('spotify', input, options),
});
