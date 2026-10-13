import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderPlaybackSetupRequest, ProviderPlaybackSetupStatus } from '@/types/onlineMusic';
import { automaticCableStatus, cableStatus } from './spotifyCableFixture';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { hasProviderPlaybackSetup: () => false } }));
import { createSpotifyPlaybackSetupController } from '@/services/onlineMusic/spotifyPlaybackSetup';

// Device/installer actions are explicit and one generation owns each setup result.
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { vi.useRealTimers(); useStatusMessageStore.setState({ message: null }); });
function fixture(initial = cableStatus()) {
    let status = initial;
    const request = vi.fn(async (_input: ProviderPlaybackSetupRequest) => status);
    const controller = createSpotifyPlaybackSetupController({ supported: () => true, request });
    return { controller, request, setStatus: (value: ProviderPlaybackSetupStatus) => { status = value; } };
}
it('only reads status on activation; installer/start/route changes need explicit actions', async () => {
    const f = fixture(); const release = f.controller.activate(); await f.controller.refresh(); release();
    expect(f.request).toHaveBeenCalledOnce(); expect(f.request).toHaveBeenCalledWith({ operation: 'status' });
});
it('blocks legacy key actions and does not infer cable readiness from a saved key', async () => {
    const f = fixture({ hasKey: true, state: 'ready' }); await f.controller.refresh();
    expect(f.controller.canRun('saveKey')).toBe(false); expect(f.controller.canRun('keyPage')).toBe(false);
    expect(f.controller.canRun('start')).toBe(false);
});
it('requires all saved choices and confirmations to probe/start', async () => {
    const status = cableStatus(), f = fixture({ ...status, selection: { ...status.selection!, spotifyOnlyConfirmed: false } });
    await f.controller.refresh(); expect(f.controller.canRun('probe')).toBe(false); expect(f.controller.canRun('start')).toBe(false);
    f.setStatus(status); await f.controller.refresh(); expect(f.controller.canRun('probe')).toBe(true);
});
it('only enables an available original bundled installer', async () => {
    const f = fixture(cableStatus({ driverBundled: false })); await f.controller.refresh(); expect(f.controller.canRun('openDriver')).toBe(false);
    expect(await f.controller.run({ operation: 'openDriver' })).toBe(false);
    f.setStatus(cableStatus({ driverInstallerAvailable: false })); await f.controller.refresh(); expect(f.controller.canRun('openDriver')).toBe(false);
    expect(await f.controller.run({ operation: 'openDriver' })).toBe(false);
    f.setStatus(cableStatus()); await f.controller.refresh(); expect(f.controller.canRun('openDriver')).toBe(true);
    await f.controller.run({ operation: 'openDriver' }); expect(f.request).toHaveBeenLastCalledWith({ operation: 'openDriver' }, expect.any(Object));
});
it('allows the original installer after endpoint detection without changing failed setup or confirmations', async () => {
    const status = cableStatus({ state: 'failed', code: 'ROUTE_PROBE_FAILED', probe: undefined }), f = fixture(status);
    await f.controller.refresh(); expect(f.controller.canRun('openDriver')).toBe(true);
    expect(await f.controller.run({ operation: 'openDriver' })).toBe(true);
    expect(f.controller.store.getState().status).toEqual(status);
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(['status', 'openDriver']);
});
it('deduplicates an installer launch and lets Stop supersede its late status without restarting playback', async () => {
    const f = fixture(cableStatus({ state: 'failed', code: 'ROUTE_PROBE_FAILED', probe: undefined }));
    await f.controller.refresh(); const pending = deferred<ProviderPlaybackSetupStatus>();
    f.request.mockImplementationOnce(() => pending.promise);
    const launching = f.controller.run({ operation: 'openDriver' });
    expect(f.controller.canRun('openDriver')).toBe(false);
    expect(await f.controller.run({ operation: 'openDriver' })).toBe(false);
    f.setStatus(cableStatus()); expect(await f.controller.run({ operation: 'stop' })).toBe(true);
    pending.resolve(cableStatus({ state: 'ready' })); expect(await launching).toBe(false);
    expect(f.controller.store.getState()).toMatchObject({ busy: false, operation: null, status: { state: 'stopped' } });
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(['status', 'openDriver', 'stop']);
});
it('ignores unknown top-level status fields and never stores a legacy key', async () => {
    const f = fixture({ ...cableStatus(), unexpectedSecret: 'synthetic-secret',
        probe: { ...cableStatus().probe, processPath: 'synthetic-secret' },
        devices: { ...cableStatus().devices, spotify: [{ ...cableStatus().devices!.spotify[0], token: 'synthetic-secret' }] } } as any); await f.controller.refresh();
    expect(JSON.stringify(f.controller.store.getState())).not.toContain('synthetic-secret');
});
it('deduplicates status reads and ignores an old read after a newer selection save', async () => {
    const f = fixture(); const old = deferred<ProviderPlaybackSetupStatus>(); f.request.mockImplementationOnce(() => old.promise);
    const first = f.controller.refresh(), second = f.controller.refresh(); expect(first).toBe(second);
    await Promise.resolve();
    await f.controller.run({ operation: 'saveSelection', selection: cableStatus().selection });
    old.resolve(cableStatus({ driverInstalled: false })); expect(await first).toBe(false);
    expect(f.controller.store.getState().status?.driverInstalled).toBe(true);
});
it('deduplicates repeated start clicks and lets Stop supersede a pending verification', async () => {
    const f = fixture(); await f.controller.refresh(); const pending = deferred<ProviderPlaybackSetupStatus>();
    f.request.mockImplementationOnce(() => pending.promise);
    const start = f.controller.run({ operation: 'start' });
    expect(await f.controller.run({ operation: 'start' })).toBe(false);
    expect(await f.controller.run({ operation: 'stop' })).toBe(true);
    pending.resolve(cableStatus({ state: 'ready' })); expect(await start).toBe(false);
    expect(f.controller.store.getState().status?.state).toBe('stopped'); expect(f.controller.store.getState().busy).toBe(false);
});
it('preserves device choices across a status refresh that only reports facts', async () => {
    const f = fixture(); await f.controller.refresh(); f.setStatus(cableStatus({ devices: undefined })); await f.controller.refresh();
    expect(f.controller.store.getState().status?.devices?.spotify[0].id).toBe('desktop-1');
});
it('does not persist a client-side ready state when a probe succeeds without connection', async () => {
    const f = fixture(); await f.controller.refresh(); await f.controller.run({ operation: 'probe' });
    expect(f.controller.store.getState().status?.state).toBe('stopped');
});

it('projects only the six-field saved setup and keeps private admission separate from passive readiness', async () => {
    const f = fixture({ ...cableStatus(), code: 'AUTOMATIC_ROUTE_ON_PLAY', probe: undefined,
        selection: { ...cableStatus().selection!, automaticRouteTrialEnabled: true },
        automaticRoute: { enabled: true, supported: false, productionQualified: false, eligible: true,
            sourceOutputDefaultRequired: false, trialAvailable: true, trialAuthorized: false } } as any);
    await f.controller.refresh();
    const status = f.controller.store.getState().status!;
    expect(status.selection).not.toHaveProperty('automaticRouteTrialEnabled');
    expect(Object.keys(status.selection!)).toHaveLength(6);
    expect(status.automaticRoute).toMatchObject({ enabled: true, supported: false, productionQualified: false,
        eligible: true, trialAuthorized: false });
    expect(status.probe).toBeUndefined();
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(['status']);
});

it('projects a pending recovery without exporting receipt internals or admitting mismatched targets', async () => {
    const f = fixture({ ...cableStatus(), coldRecovery: { required: true, recoverable: true, deviceId: 'desktop-1', originalVolume: 0,
        receiptPath: '/private/recovery.json', nonce: 'private-token' } } as any);
    await f.controller.refresh();
    expect(f.controller.store.getState().status?.coldRecovery).toEqual({ required: true, recoverable: true, deviceId: 'desktop-1', originalVolume: 0, sourceControlUnconfirmed: false });
    expect(f.controller.canRun('checkColdRecovery')).toBe(true);
    expect(JSON.stringify(f.controller.store.getState())).not.toMatch(/private|nonce|receiptPath/);
    f.setStatus({ ...cableStatus(), coldRecovery: { required: true, recoverable: true, deviceId: 'other-desktop', originalVolume: 100 } });
    await f.controller.refresh(); expect(f.controller.canRun('checkColdRecovery')).toBe(false);
    expect(await f.controller.run({ operation: 'checkColdRecovery' })).toBe(false);
    f.setStatus(cableStatus()); await f.controller.refresh(); expect(f.controller.canRun('checkColdRecovery')).toBe(false);
});

const pendingColdRecovery = () => automaticCableStatus({ state: 'routing-required', code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED',
    coldRecovery: { required: true, recoverable: true, deviceId: 'desktop-1', originalVolume: 9 } });
const clearedColdRecovery = () => automaticCableStatus({ coldRecovery: { required: false, recoverable: false } });
const coldRecoveryMessage = () => ({ type: 'error' as const, text: 'Synthetic volume recovery required', persistent: true,
    statusKey: 'spotify-cold-volume-recovery-required' as const });

it('clears only the captured cold-recovery toast after the explicit check succeeds, without starting playback', async () => {
    const f = fixture(pendingColdRecovery()); await f.controller.refresh();
    useStatusMessageStore.setState({ message: coldRecoveryMessage() });
    f.setStatus(clearedColdRecovery());
    expect(await f.controller.run({ operation: 'checkColdRecovery' })).toBe(true);
    expect(useStatusMessageStore.getState().message).toBeNull();
    expect(f.controller.store.getState().status).toMatchObject({ state: 'stopped', code: 'AUTOMATIC_ROUTE_ON_PLAY' });
    expect(f.controller.store.getState().status?.coldRecovery).toEqual({ required: false, recoverable: false, sourceControlUnconfirmed: false });
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(['status', 'checkColdRecovery']);
});
it.each(['failed', 'still-required', 'blocked-code', 'missing-evidence', 'archived'] as const)('retains the recovery toast when the check is %s', async kind => {
    const f = fixture(pendingColdRecovery()); await f.controller.refresh();
    const message = coldRecoveryMessage(); useStatusMessageStore.setState({ message });
    if (kind === 'failed') f.request.mockRejectedValueOnce(new Error('synthetic failure'));
    if (kind === 'blocked-code') f.setStatus({ ...clearedColdRecovery(), code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    if (kind === 'missing-evidence') f.setStatus(automaticCableStatus());
    if (kind === 'archived') f.setStatus(automaticCableStatus({ coldRecovery: { required: false, recoverable: false, archived: true, unresolvedHistorical: true } }));
    await f.controller.run({ operation: 'checkColdRecovery' });
    expect(useStatusMessageStore.getState().message).toBe(message);
});
it.each(['unrelated', 'new-recovery'] as const)('retains a %s toast that replaces the captured error during a recovery check', async kind => {
    const f = fixture(pendingColdRecovery()); await f.controller.refresh();
    useStatusMessageStore.setState({ message: coldRecoveryMessage() });
    const pending = deferred<ProviderPlaybackSetupStatus>(); f.request.mockImplementationOnce(() => pending.promise);
    const checking = f.controller.run({ operation: 'checkColdRecovery' });
    expect(await f.controller.run({ operation: 'checkColdRecovery' })).toBe(false);
    const newer = kind === 'new-recovery' ? coldRecoveryMessage() : { type: 'error' as const, text: 'Another failure', persistent: true };
    useStatusMessageStore.setState({ message: newer });
    pending.resolve(clearedColdRecovery()); expect(await checking).toBe(true);
    expect(useStatusMessageStore.getState().message).toBe(newer);
});
it('does not clear an unrelated existing persistent error after a recovery check', async () => {
    const f = fixture(pendingColdRecovery()); await f.controller.refresh();
    const message = { type: 'error' as const, text: 'Another failure', persistent: true };
    useStatusMessageStore.setState({ message }); f.setStatus(clearedColdRecovery());
    await f.controller.run({ operation: 'checkColdRecovery' });
    expect(useStatusMessageStore.getState().message).toBe(message);
});
it('does not clear the recovery toast on passive refresh or a superseded check', async () => {
    const f = fixture(pendingColdRecovery()); await f.controller.refresh();
    const message = coldRecoveryMessage(); useStatusMessageStore.setState({ message });
    f.setStatus(clearedColdRecovery()); await f.controller.refresh();
    expect(useStatusMessageStore.getState().message).toBe(message);
    f.setStatus(pendingColdRecovery()); await f.controller.refresh();
    const pending = deferred<ProviderPlaybackSetupStatus>(); f.request.mockImplementationOnce(() => pending.promise);
    const checking = f.controller.run({ operation: 'checkColdRecovery' });
    expect(await f.controller.run({ operation: 'stop' })).toBe(true);
    pending.resolve(clearedColdRecovery()); expect(await checking).toBe(false);
    expect(useStatusMessageStore.getState().message).toBe(message);
    expect(f.controller.store.getState().status?.coldRecovery?.required).toBe(true);
});


it('archives historical volume recovery without restoring it or admitting uncertain source control', async () => {
    const f = fixture(automaticCableStatus({ coldRecovery: { required: true, recoverable: true,
        archived: true, unresolvedHistorical: true, sourceControlUnconfirmed: true,
        deviceId: 'desktop-1', originalVolume: 9 } }));
    await f.controller.refresh();
    expect(f.controller.store.getState().status?.coldRecovery).toEqual({ required: false, recoverable: false,
        archived: true, unresolvedHistorical: true, sourceControlUnconfirmed: true, deviceId: 'desktop-1', originalVolume: 9 });
    expect(f.controller.canRun('checkColdRecovery')).toBe(false);
    expect(await f.controller.run({ operation: 'checkColdRecovery' })).toBe(false);
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(['status']);
});
