// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderPlaybackSetupRequest, ProviderPlaybackSetupStatus } from '@/types/onlineMusic';
import { automaticCableStatus, cableStatus } from '../onlineMusic/spotifyCableFixture';
import { cableSelectionComplete, EMPTY_CABLE_SELECTION } from '@/services/onlineMusic/spotifyCableSetup';

// Real guide and React ownership flows; only the Omni boundary is mocked, with no Windows or account I/O.
const fixture = vi.hoisted(() => ({ status: vi.fn(), setup: vi.fn(), begin: vi.fn(), check: vi.fn(), cancel: vi.fn(), complete: vi.fn(), t: (key: string) => key }));
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: fixture.t }) }));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { hasProviderPlaybackSetup: () => true, getProviderCapabilities: () => ({ auth: true }),
    getQrTtlMs: () => null, getLoginStatus: fixture.status, requestProviderPlaybackSetup: fixture.setup,
    createQrLogin: fixture.begin, checkQrLogin: fixture.check, cancelQrLogin: fixture.cancel } }));
import { useSpotifyConnection, type SpotifyConnection } from '@/hooks/useSpotifyConnection';
import { spotifyPlaybackSetup } from '@/services/onlineMusic/spotifyPlaybackSetup';
import { useSpotifyConnectionStore, SPOTIFY_CONNECTION_PENDING_KEY } from '@/stores/useSpotifyConnectionStore';
import SpotifyConnectionModal from '@/components/app/home/SpotifyConnectionModal';

let root: Root | undefined, host: HTMLDivElement, current: SpotifyConnection, receiver: ProviderPlaybackSetupStatus;
const user = { id: 'test-user', nickname: 'Listener' };
const desktopStatus = (ready = true) => ({ enabled: true, ready, installations: [], versions: { spicetify: '2.45.3', cable: '3.3.1.7' },
    install: { phase: 'idle', busy: false }, systemOutput: { state: 'ready', names: ['Test DAC'] } });
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
afterEach(async () => { act(() => root?.unmount()); root = undefined; host.remove(); delete window.electron; await Promise.resolve(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('Spotify cable first-connection guide', () => {



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


});

// Current Wrapper completion rechecks desktop readiness and respects dismissal ownership.
it('completes Wrapper setup using current desktop readiness without browser authorization', async () => {
    const request = vi.fn(async (_input: { operation: string }) => desktopStatus());
    Object.defineProperty(window, 'electron', { configurable: true, value: { spotify: { request } } });
    fixture.status.mockResolvedValue(user); await mount(); await open();
    await act(async () => { await current.finishDesktop(); });
    expect(fixture.complete).toHaveBeenCalledOnce(); expect(current.open).toBe(false);
    expect(fixture.begin).not.toHaveBeenCalled(); expect(request.mock.calls.every(([x]) => ['status', 'preferences'].includes(x.operation))).toBe(true);
});
it('does not finish Wrapper setup when desktop readiness is revoked', async () => {
    const request = vi.fn(async (_input: { operation: string }) => desktopStatus(false));
    Object.defineProperty(window, 'electron', { configurable: true, value: { spotify: { request } } });
    fixture.status.mockResolvedValue(user); await mount(); await open();
    await act(async () => { await current.finishDesktop(); });
    expect(fixture.complete).not.toHaveBeenCalled(); expect(current.open).toBe(true); expect(current.error).toBe('completeFailed');
});
it('dismissal defeats a late Wrapper readiness response', async () => {
    const request = vi.fn(async (_input: { operation: string }) => desktopStatus());
    Object.defineProperty(window, 'electron', { configurable: true, value: { spotify: { request } } });
    fixture.status.mockResolvedValue(user); await mount(); await open();
    const pending = deferred<ReturnType<typeof desktopStatus>>(); request.mockImplementationOnce(() => pending.promise);
    let work!: Promise<void>; act(() => { work = current.finishDesktop(); current.close(); });
    pending.resolve(desktopStatus()); await act(async () => { await work; });
    expect(fixture.complete).not.toHaveBeenCalled(); expect(current.open).toBe(false);
});
