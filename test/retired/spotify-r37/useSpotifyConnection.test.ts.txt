// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderPlaybackSetupRequest, ProviderPlaybackSetupStatus } from '@/types/onlineMusic';
import { automaticCableStatus, cableStatus } from '../onlineMusic/spotifyCableFixture';
import { cableSelectionComplete, EMPTY_CABLE_SELECTION } from '@/services/onlineMusic/spotifyCableSetup';

// Real guide and React ownership flows; only the Omni boundary is mocked, with no Windows or account I/O.
const fixture = vi.hoisted(() => ({ status: vi.fn(), setup: vi.fn(), begin: vi.fn(), check: vi.fn(), cancel: vi.fn(), complete: vi.fn(), t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixture.t }) }));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { hasProviderPlaybackSetup: () => true, getProviderCapabilities: () => ({ auth: true }),
    getQrTtlMs: () => null, getLoginStatus: fixture.status, requestProviderPlaybackSetup: fixture.setup,
    createQrLogin: fixture.begin, checkQrLogin: fixture.check, cancelQrLogin: fixture.cancel } }));
import { useSpotifyConnection, type SpotifyConnection } from '@/hooks/useSpotifyConnection';
import { spotifyPlaybackSetup } from '@/services/onlineMusic/spotifyPlaybackSetup';
import { useSpotifyConnectionStore, SPOTIFY_CONNECTION_PENDING_KEY } from '@/stores/useSpotifyConnectionStore';
import SpotifyConnectionModal from '@/components/app/home/SpotifyConnectionModal';

let root: Root | undefined, host: HTMLDivElement, current: SpotifyConnection, receiver: ProviderPlaybackSetupStatus;
const user = { id: 'test-user', nickname: 'Listener' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { await act(async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); }); };
function Probe() { current = useSpotifyConnection(fixture.complete); return current.open ? React.createElement(SpotifyConnectionModal, { connection: current, daylight: false }) : null; }
const mount = async () => { root = createRoot(host); act(() => root!.render(React.createElement(React.StrictMode, null, React.createElement(Probe)))); await flush(); };
const open = async () => { act(() => current.begin()); await flush(); };
const view = () => document.querySelector<HTMLDivElement>('.spotify-connection-overlay') || host;
const button = (key: string) => Array.from(view().querySelectorAll('button')).find(value => value.textContent === key)!;
const run = async (input: ProviderPlaybackSetupRequest) => { await act(async () => { await spotifyPlaybackSetup.run(input); }); await flush(); };
const click = async (key: string) => { await act(async () => { button(key).click(); }); await flush(); };

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    host = document.createElement('div'); document.body.append(host); localStorage.clear();
    useSpotifyConnectionStore.setState({ open: false, pending: false, authorizeOnOpen: false });
    spotifyPlaybackSetup.store.setState({ status: null, busy: false, operation: null, progress: null, message: null });
    receiver = cableStatus({ state: 'driver-missing', driverInstalled: false, spotifyRunning: false, selection: { ...EMPTY_CABLE_SELECTION }, probe: undefined });
    fixture.status.mockReset().mockResolvedValue(null); fixture.begin.mockReset().mockResolvedValue({ key: 'test-session', imageUrl: '' });
    fixture.check.mockReset().mockImplementation(async () => { fixture.status.mockResolvedValue(user); return { state: 'confirmed' }; });
    fixture.cancel.mockReset().mockResolvedValue(undefined); fixture.complete.mockReset().mockResolvedValue(true);
    fixture.setup.mockReset().mockImplementation(async (_provider, input) => {
        if (input.operation === 'saveSelection') receiver = { ...receiver, selection: input.selection, state: 'stopped',
            ...(receiver.automaticRoute?.enabled ? { code: cableSelectionComplete(input.selection) ? 'AUTOMATIC_ROUTE_ON_PLAY' : 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED' } : {}) };
        if (input.operation === 'start') receiver = { ...receiver, state: 'ready', probe: cableStatus().probe };
        if (input.operation === 'stop') receiver = { ...receiver, state: 'stopped' };
        return structuredClone(receiver);
    });
});
afterEach(async () => { act(() => root?.unmount()); root = undefined; host.remove(); await Promise.resolve(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('Spotify cable first-connection guide', () => {
    it('resumes after restart without reopening authorization or launching an installer', async () => {
        useSpotifyConnectionStore.setState({ open: true, pending: true, authorizeOnOpen: false }); await mount();
        expect(current.step).toBe('catalog'); expect(fixture.begin).not.toHaveBeenCalled();
        expect(fixture.setup.mock.calls.every(([, input]) => ['status', 'devices'].includes(input.operation))).toBe(true);
        await click('spotifyConnection.authorize'); expect(fixture.begin).toHaveBeenCalledOnce();
    });
    it('finishes initial output setup with required client settings, then leaves checks to track click', async () => {
        await mount(); await open(); expect(current.step).toBe('catalog');
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); await flush(); expect(current.step).toBe('desktop');
        expect(view().querySelector('input[type=password]')).toBeNull();
        receiver = { ...receiver, spotifyRunning: true }; await run({ operation: 'devices' });
        const desktop = view().querySelector('select[aria-label="spotifyCable.connectDevice"]') as HTMLSelectElement;
        act(() => { desktop.value = 'desktop-1'; desktop.dispatchEvent(new Event('change', { bubbles: true })); });
        await click('spotifyCable.save'); expect(current.step).toBe('cable');
        receiver = automaticCableStatus({ selection: { ...receiver.selection! } }); await run({ operation: 'devices' });
        for (const [label, value] of [['renderEndpoint', 'render-1'], ['captureEndpoint', 'capture-1']]) {
            const select = view().querySelector(`select[aria-label="spotifyCable.${label}"]`) as HTMLSelectElement;
            act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
        }
        act(() => { view().querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input => input.click()); });
        await act(async () => { await current.finish(); }); expect(fixture.complete).not.toHaveBeenCalled();
        await click('spotifyCable.save'); expect(current.step).toBe('ready');
        expect(fixture.setup.mock.calls.some(([, input]) => ['start', 'probe'].includes(input.operation))).toBe(false);
        expect(view().querySelector('[data-testid=spotify-connect-verify]')).toBeNull();
        await click('spotifyConnection.finish'); expect(fixture.complete).toHaveBeenCalledOnce(); expect(current.open).toBe(false);
        expect(localStorage.getItem(SPOTIFY_CONNECTION_PENDING_KEY)).toBeNull();
    });
    it('asks an r18 migrated setup once for client settings, saves it and does not prompt after completion/restart', async () => {
        fixture.status.mockResolvedValue(user);
        receiver = automaticCableStatus({ state: 'routing-required', code: 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED',
            selection: { ...cableStatus().selection!, spotifyOnlyConfirmed: false, defaultsConfirmed: false } });
        await mount(); await open(); expect(current.step).toBe('cable');
        const client = Array.from(view().querySelectorAll('label')).find(label => label.textContent?.includes('spotifyCable.spotifyOnlyConfirmed'))!.querySelector<HTMLInputElement>('input')!;
        expect(client.checked).toBe(false);
        await act(async () => { await current.finish(); }); expect(fixture.complete).not.toHaveBeenCalled();
        act(() => client.click()); await click('spotifyCable.save');
        expect(current.step).toBe('ready');
        expect(receiver.selection?.internal44100Confirmed).toBe(true);
        expect(receiver.selection?.defaultsConfirmed).toBe(false);
        await click('spotifyConnection.finish'); expect(current.open).toBe(false);
        act(() => root?.unmount()); root = undefined; await mount();
        expect(current.open).toBe(false);
        await open(); expect(current.step).toBe('ready');
        expect(view().querySelector('input[type=checkbox]')).toBeNull();
        expect(fixture.setup.mock.calls.filter(([, input]) => input.operation === 'saveSelection')).toHaveLength(1);
        expect(fixture.setup.mock.calls.some(([, input]) => ['probe', 'start'].includes(input.operation))).toBe(false);
    });
    it('blocks finish if fresh saved setup reports actual drift', async () => {
        fixture.status.mockResolvedValue(user); receiver = automaticCableStatus(); await mount(); await open();
        expect(current.step).toBe('ready');
        receiver = automaticCableStatus({ state: 'routing-required', code: 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED',
            selection: { ...receiver.selection!, spotifyOnlyConfirmed: false } });
        await act(async () => { await current.finish(); });
        expect(fixture.complete).not.toHaveBeenCalled(); expect(current.step).toBe('cable');
    });
    it('saved OAuth and confirmed choices survive close and reopening', async () => {
        fixture.status.mockResolvedValue(user); receiver = automaticCableStatus(); await mount(); await open(); expect(current.step).toBe('ready');
        act(() => current.close()); await flush(); await open(); expect(current.step).toBe('ready');
        expect(fixture.begin).not.toHaveBeenCalled(); expect(receiver.selection?.connectDeviceId).toBe('desktop-1');
        expect(fixture.setup.mock.calls.some(([, input]) => ['openDriver', 'saveKey', 'start'].includes(input.operation))).toBe(false);
    });
    it('reviews prior steps with Back/Continue without reinstalling or reauthorizing', async () => {
        fixture.status.mockResolvedValue(user); receiver = cableStatus({ state: 'ready' }); await mount(); await open();
        await click('spotifyConnection.back'); expect(view().querySelector('[data-testid=spotify-connect-cable]')).not.toBeNull();
        await click('spotifyConnection.back'); expect(view().querySelector('[data-testid=spotify-connect-desktop]')).not.toBeNull();
        await click('spotifyConnection.continue'); await click('spotifyConnection.continue');
        expect(view().querySelector('[data-testid=spotify-connect-ready]')).not.toBeNull(); expect(fixture.begin).not.toHaveBeenCalled();
        expect(fixture.setup.mock.calls.some(([, input]) => ['openDriver', 'start'].includes(input.operation))).toBe(false);
    });
    it('does not finish from a stale ready label when format evidence is missing', async () => {
        fixture.status.mockResolvedValue(user); receiver = cableStatus({ state: 'ready', probe: undefined }); await mount(); await open();
        expect(current.step).toBe('cable'); await act(async () => { await current.finish(); }); expect(fixture.complete).not.toHaveBeenCalled();
    });
    it('rechecks actual readiness before finishing and rejects a changed route', async () => {
        fixture.status.mockResolvedValue(user); receiver = cableStatus({ state: 'ready' }); await mount(); await open();
        receiver = cableStatus({ state: 'ready', probe: { ...cableStatus().probe!, defaultRenderIsCable: true } });
        await act(async () => { await current.finish(); }); expect(fixture.complete).not.toHaveBeenCalled(); expect(current.step).toBe('cable');
    });
    it('closing during verification prevents a late response from completing the guide', async () => {
        fixture.status.mockResolvedValue(user); receiver = cableStatus(); await mount(); await open();
        const pending = deferred<ProviderPlaybackSetupStatus>(); fixture.setup.mockImplementationOnce(() => pending.promise);
        let work!: Promise<boolean>; act(() => { work = spotifyPlaybackSetup.run({ operation: 'start' }); current.close(); });
        pending.resolve(cableStatus({ state: 'ready' })); await act(async () => { await work; }); await flush();
        expect(current.open).toBe(false); expect(fixture.complete).not.toHaveBeenCalled();
        expect(fixture.setup.mock.calls.some(([, input]) => input.operation === 'stop')).toBe(true);
    });
    it('Stop defeats a late successful verification and repeated clicks do not duplicate start', async () => {
        fixture.status.mockResolvedValue(user); receiver = cableStatus(); await mount(); await open();
        const pending = deferred<ProviderPlaybackSetupStatus>(); fixture.setup.mockImplementationOnce(() => pending.promise);
        let work!: Promise<boolean>; act(() => { work = spotifyPlaybackSetup.run({ operation: 'start' }); });
        await run({ operation: 'start' }); await run({ operation: 'stop' });
        pending.resolve(cableStatus({ state: 'ready' })); await act(async () => { await work; }); await flush();
        expect(current.step).toBe('cable'); expect(spotifyPlaybackSetup.store.getState().status?.state).toBe('stopped');
    });
    it('changing a cable selection clears all route confirmations before save', async () => {
        fixture.status.mockResolvedValue(user); receiver = cableStatus({ driverInstalled: false }); await mount(); await open();
        const capture = view().querySelector('select[aria-label="spotifyCable.captureEndpoint"]') as HTMLSelectElement;
        act(() => { capture.value = ''; capture.dispatchEvent(new Event('change', { bubbles: true })); });
        expect([...view().querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(input => !input.checked)).toBe(true);
    });
    it('labels temporary 44.1 kHz requests honestly while preserving idle 48 kHz readings', async () => {
        fixture.status.mockResolvedValue(user); receiver = cableStatus({ state: 'ready', code: 'FORMAT_LEASE_ON_PLAY',
            probe: { ...cableStatus().probe!, captureSampleRate: 48000, captureMixSampleRate: 48000, renderMixSampleRate: 48000,
                temporaryFormatLeaseEligible: true, formatLeaseApplied: false } });
        await mount(); await open(); expect(current.step).toBe('ready'); expect(view().textContent).toContain('spotifyCable.idleLease');
        expect(spotifyPlaybackSetup.store.getState().status?.probe?.captureSampleRate).toBe(48000);
        expect(view().textContent).not.toContain('spotifyCable.checkFailed');
    });
});
