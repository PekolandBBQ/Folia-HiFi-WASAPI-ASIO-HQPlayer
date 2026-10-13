// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderPlaybackSetupStatus } from '@/types/onlineMusic';
import { automaticCableStatus, cableStatus } from './spotifyCableFixture';

// Exercise real settings/controller ownership; only Omni is mocked, with no Windows or driver changes.
const fixture = vi.hoisted(() => ({ setup: vi.fn(), t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixture.t }) }));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: {
    hasProviderPlaybackSetup: () => true, requestProviderPlaybackSetup: fixture.setup,
} }));
import SpotifyPlaybackSetup from '@/components/modal/settings/SpotifyPlaybackSetup';
import { spotifyPlaybackSetup } from '@/services/onlineMusic/spotifyPlaybackSetup';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';

let root: Root | undefined, host: HTMLDivElement, receiver: ProviderPlaybackSetupStatus;
const deferred = <T,>() => {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};
const flush = async () => { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); }); };
const button = (key: string) => Array.from(host.querySelectorAll('button')).find(value => value.textContent === `spotifyCable.${key}`)!;
const confirmation = (key: string) => Array.from(host.querySelectorAll('label')).find(label => label.textContent?.includes(`spotifyCable.${key}`))!.querySelector<HTMLInputElement>('input')!;
const operations = () => fixture.setup.mock.calls.map(([, input]) => input.operation);
const mount = async () => {
    root = createRoot(host);
    act(() => root!.render(React.createElement(React.StrictMode, null, React.createElement(SpotifyPlaybackSetup))));
    await flush();
};
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div'); document.body.append(host);
    receiver = cableStatus({ state: 'failed', code: 'ROUTE_PROBE_FAILED', probe: undefined,
        selection: { ...cableStatus().selection!, internal44100Confirmed: false } });
    spotifyPlaybackSetup.store.setState({ status: null, busy: false, operation: null, progress: null, message: null });
    useStatusMessageStore.setState({ message: null });
    fixture.setup.mockReset().mockImplementation(async () => structuredClone(receiver));
});
afterEach(() => { act(() => root?.unmount()); root = undefined; host.remove(); });

describe('VB-CABLE original installer access', () => {
    it('requires one migrated Spotify client completion without exposing a mode or a Windows-default checkbox', async () => {
        receiver = automaticCableStatus({ state: 'routing-required', code: 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED',
            selection: { ...cableStatus().selection!, spotifyOnlyConfirmed: false, defaultsConfirmed: false } });
        await mount();
        expect(host.textContent).toContain('spotifyCable.clientOutputStep');
        expect(host.textContent).toContain('spotifyCable.exclusiveHint');
        expect(host.textContent).not.toMatch(/automaticTrialOptIn|manualRouteHint|defaultsConfirmed/);
        const checkbox = confirmation('spotifyOnlyConfirmed');
        expect(checkbox.checked).toBe(false); expect(checkbox.required).toBe(true);
        expect(confirmation('internal44100Confirmed').checked).toBe(true);
        expect(operations()).not.toContain('saveSelection');
        act(() => checkbox.click());
        await act(async () => button('save').click()); await flush();
        const saved = fixture.setup.mock.calls.find(([, input]) => input.operation === 'saveSelection')![1];
        expect(saved.selection.spotifyOnlyConfirmed).toBe(true);
        expect(saved.selection.defaultsConfirmed).toBe(false);
        expect(saved.selection).not.toHaveProperty('automaticRouteTrialEnabled');
        expect(operations()).not.toContain('start'); expect(operations()).not.toContain('probe');
    });
    it('reuses saved setup on repeated opens without another manual confirmation or verification action', async () => {
        receiver = automaticCableStatus({ selection: { ...cableStatus().selection!, defaultsConfirmed: false } });
        await mount();
        expect(confirmation('spotifyOnlyConfirmed').checked).toBe(true);
        expect(confirmation('internal44100Confirmed').checked).toBe(true);
        expect(button('start')).toBeUndefined(); expect(button('probe')).toBeUndefined();
        expect(button('save').disabled).toBe(true);
        act(() => root?.unmount()); root = undefined; await mount();
        expect(confirmation('spotifyOnlyConfirmed').checked).toBe(true);
        expect(button('save').disabled).toBe(true);
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });
    it.each(['connectDevice', 'captureEndpoint', 'renderEndpoint'])('invalidates only relevant completed settings when changing %s', async label => {
        receiver = automaticCableStatus(); await mount();
        const select = host.querySelector<HTMLSelectElement>(`select[aria-label="spotifyCable.${label}"]`)!;
        act(() => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(confirmation('spotifyOnlyConfirmed').checked).toBe(false);
        expect(confirmation('internal44100Confirmed').checked).toBe(label === 'connectDevice');
        expect(operations()).not.toContain('saveSelection');
    });
    it('keeps the installer available after endpoint detection without treating failed setup as ready', async () => {
        await mount();
        expect(button('install').disabled).toBe(false);
        expect(host.textContent).toContain('spotifyCable.endpointsDetectedHint');
        expect(host.textContent).toContain('spotifyCable.exclusiveHint');
        expect(host.textContent).toContain('spotifyCable.qualityHint');
        expect(host.textContent).toContain('spotifyCable.routeProbeFailed');
        expect(host.textContent).toContain('ROUTE_PROBE_FAILED');
        expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
        expect(button('start')).toBeUndefined();
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
        await act(async () => { button('install').click(); }); await flush();
        expect(operations().filter(operation => operation === 'openDriver')).toHaveLength(1);
        expect(spotifyPlaybackSetup.store.getState().status?.state).toBe('failed');
        expect(spotifyPlaybackSetup.store.getState().status?.selection).toEqual(receiver.selection);
        expect(operations().some(operation => ['start', 'probe', 'saveSelection'].includes(operation))).toBe(false);
    });
    it.each([
        { driverBundled: false, driverInstallerAvailable: true },
        { driverBundled: true, driverInstallerAvailable: false },
        { driverBundled: false, driverInstallerAvailable: false },
    ])('shows a disabled action when the original installer is unavailable: %j', async unavailable => {
        receiver = { ...receiver, ...unavailable }; await mount();
        expect(button('install').disabled).toBe(true);
        expect(host.textContent).toContain('spotifyCable.driverNotBundled');
        expect(host.textContent).not.toContain('spotifyCable.installHint');
        act(() => button('install').click()); await flush();
        expect(operations()).not.toContain('openDriver');
    });
    it('deduplicates repeated clicks and restores the action after a cancelled or failed launch', async () => {
        await mount(); const pending = deferred<ProviderPlaybackSetupStatus>();
        fixture.setup.mockImplementationOnce(() => pending.promise);
        act(() => { button('install').click(); button('install').click(); });
        expect(button('install').disabled).toBe(true);
        expect(button('refreshDevices').disabled).toBe(true);
        expect(operations().filter(operation => operation === 'openDriver')).toHaveLength(1);
        pending.reject(new Error('Vendor launch cancelled')); await flush();
        expect(button('install').disabled).toBe(false);
        expect(host.textContent).toContain('spotifyCable.failed');
        expect(spotifyPlaybackSetup.store.getState().status?.state).toBe('failed');
        expect(operations().filter(operation => operation === 'openDriver')).toHaveLength(1);
        expect(operations().some(operation => ['start', 'probe', 'saveSelection'].includes(operation))).toBe(false);
        await act(async () => { button('install').click(); }); await flush();
        expect(operations().filter(operation => operation === 'openDriver')).toHaveLength(2);
    });
    it('does not launch or repeat the installer when settings are closed and reopened', async () => {
        await mount();
        act(() => root?.unmount()); root = undefined;
        await mount();
        expect(button('install').disabled).toBe(false);
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });
});

describe('saved confirmation explanations', () => {
    it.each([0, 1, 2])('lists only the required saved missing confirmations for mask %i', async mask => {
        receiver = cableStatus({ state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED', selection: {
            ...cableStatus().selection!, internal44100Confirmed: Boolean(mask & 1),
            spotifyOnlyConfirmed: Boolean(mask & 2), defaultsConfirmed: Boolean(mask & 4),
        } });
        await mount();
        const keys = ['internal44100Confirmed', 'spotifyOnlyConfirmed'] as const;
        expect(Array.from(host.querySelectorAll('[data-confirmation]')).map(item => item.getAttribute('data-confirmation')))
            .toEqual(keys.filter(key => !receiver.selection![key]));
        expect(host.textContent).toContain('spotifyCable.confirmationRequired');
        expect(host.textContent).not.toContain('spotifyCable.checkFailed');
        expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).map(input => input.checked))
            .toEqual((['spotifyOnlyConfirmed', 'internal44100Confirmed'] as const).map(key => receiver.selection![key]));
        expect(button('start')).toBeUndefined(); expect(button('probe')).toBeUndefined();
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });
    it('does not save on check, close or reopen, and does not infer confirmation from 44100 Hz readbacks', async () => {
        receiver = cableStatus({ state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED',
            selection: { ...cableStatus().selection!, internal44100Confirmed: false } });
        await mount();
        act(() => confirmation('internal44100Confirmed').click());
        expect(button('save').disabled).toBe(false); expect(button('start')).toBeUndefined();
        expect(host.querySelector('[data-confirmation=internal44100Confirmed]')).not.toBeNull();
        expect(operations()).not.toContain('saveSelection');
        act(() => root?.unmount()); root = undefined; await mount();
        expect(confirmation('internal44100Confirmed').checked).toBe(false);
        expect(button('save').disabled).toBe(true); expect(button('start')).toBeUndefined();
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });
    it('saves a checked confirmation only on the explicit Save action, without starting a connection', async () => {
        receiver = cableStatus({ state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED',
            selection: { ...cableStatus().selection!, internal44100Confirmed: false } });
        await mount();
        fixture.setup.mockImplementation(async (_provider, input) => {
            if (input.operation === 'saveSelection') receiver = cableStatus({ selection: input.selection });
            return structuredClone(receiver);
        });
        act(() => confirmation('internal44100Confirmed').click());
        await act(async () => button('save').click()); await flush();
        expect(operations().filter(operation => operation === 'saveSelection')).toHaveLength(1);
        expect(spotifyPlaybackSetup.store.getState().status?.selection?.internal44100Confirmed).toBe(true);
        expect(host.querySelector('[data-confirmation]')).toBeNull();
        expect(operations()).not.toContain('start'); expect(operations()).not.toContain('probe');
        act(() => root?.unmount()); root = undefined; await mount();
        expect(confirmation('internal44100Confirmed').checked).toBe(true);
        expect(operations().filter(operation => operation === 'saveSelection')).toHaveLength(1);
    });
    it('presents a completed temporary probe as released instead of a verification failure', async () => {
        receiver = cableStatus({ state: 'ready', code: 'FORMAT_LEASE_PROBE_RELEASED' }); await mount();
        expect(host.textContent).toContain('spotifyCable.probeReleased');
        expect(host.textContent?.split('spotifyCable.probeReleased')).toHaveLength(2);
        expect(host.textContent).not.toContain('spotifyCable.checkFailed');
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });
});

describe('retired cold-start volume recovery UI', () => {
    const archived = (patch: Partial<ProviderPlaybackSetupStatus> = {}) => automaticCableStatus({
        coldRecovery: { required: false, recoverable: false, archived: true, unresolvedHistorical: true,
            deviceId: 'desktop-1', originalVolume: 37 }, ...patch });

    it('shows the historical receipt without volume fields or a recovery action', async () => {
        receiver = archived(); await mount();
        const panel = host.querySelector('[data-testid=spotify-cold-history]')!;
        expect(panel.textContent).toContain('spotifyCable.volumeHistoryRetained');
        expect(panel.textContent).not.toContain('37%');
        expect(panel.querySelector('input, button')).toBeNull();
        expect(button('checkColdRecovery')).toBeUndefined();
        expect(spotifyPlaybackSetup.canRun('checkColdRecovery')).toBe(false);
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });

    it('keeps the record visible across close and reopen without claiming restoration or writing volume', async () => {
        receiver = archived(); await mount();
        const message = { type: 'error' as const, persistent: true,
            text: 'Synthetic volume recovery required', statusKey: 'spotify-cold-volume-recovery-required' as const };
        useStatusMessageStore.setState({ message });
        act(() => root?.unmount()); root = undefined; await mount();
        expect(host.querySelector('[data-testid=spotify-cold-history]')).not.toBeNull();
        expect(useStatusMessageStore.getState().message).toBe(message);
        expect(spotifyPlaybackSetup.store.getState().status?.coldRecovery).toMatchObject({
            required: false, archived: true, unresolvedHistorical: true });
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });

    it('keeps uncertain source control separate from historical volume recovery', async () => {
        receiver = archived({ state: 'routing-required', code: 'PLAYBACK_STATE_UNCONFIRMED',
            coldRecovery: { required: false, recoverable: false, archived: true,
                unresolvedHistorical: true, sourceControlUnconfirmed: true } });
        await mount();
        expect(host.textContent).toContain('spotifyCable.sourceControlUnconfirmed');
        expect(host.querySelector('[data-testid=spotify-cold-history]')).not.toBeNull();
        expect(button('checkColdRecovery')).toBeUndefined();
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });

    it.each([
        { required: true, recoverable: false, deviceId: 'desktop-1', originalVolume: 37 },
        { required: true, recoverable: true, deviceId: 'other-desktop', originalVolume: 37 },
        { required: true, recoverable: true, deviceId: 'desktop-1' },
        { required: true, recoverable: true, deviceId: 'desktop-1', originalVolume: 101 },
        { required: true, recoverable: true, deviceId: 'desktop-1', originalVolume: 37.5 },
    ])('never offers volume recovery from legacy evidence: %j', async coldRecovery => {
        receiver = archived({ coldRecovery }); await mount();
        expect(host.querySelector('[data-testid=spotify-cold-history]')).not.toBeNull();
        expect(button('checkColdRecovery')).toBeUndefined();
        expect(operations().every(operation => ['status', 'devices'].includes(operation))).toBe(true);
    });

    it('keeps historical facts when endpoint inventory reports another failure', async () => {
        receiver = archived({ state: 'failed', code: 'CAPTURE_HELPER_UNAVAILABLE', devices: undefined }); await mount();
        expect(host.querySelector('[data-testid=spotify-cold-history]')?.textContent).toContain('spotifyCable.volumeHistoryRetained');
        expect(button('checkColdRecovery')).toBeUndefined();
        expect(operations()).not.toContain('checkColdRecovery');
    });

    it('has no recovery notice during normal preparation or ordinary routing failure', async () => {
        receiver = cableStatus({ state: 'ready', code: 'FORMAT_LEASE_ON_PLAY' }); await mount();
        expect(host.querySelector('[data-testid=spotify-cold-history]')).toBeNull();
        expect(button('checkColdRecovery')).toBeUndefined();
        receiver = cableStatus({ state: 'failed', code: 'ROUTE_PROBE_FAILED' });
        await act(async () => { await spotifyPlaybackSetup.refresh(); });
        expect(host.querySelector('[data-testid=spotify-cold-history]')).toBeNull();
        expect(operations()).not.toContain('checkColdRecovery');
    });
});
