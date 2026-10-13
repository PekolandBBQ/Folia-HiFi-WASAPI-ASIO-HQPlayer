// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCableSelection, ProviderPlaybackSetupRequest } from '@/types/onlineMusic';

// test/unit/onlineMusic/cableBaseEndpointBoundary.test.ts: native JSONL is simulated; real host,
// setup, renderer projection and controls run together. No Windows helper or audio device runs.
const bridge = vi.hoisted(() => ({ request: vi.fn(), t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: bridge.t }) }));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: {
    hasProviderPlaybackSetup: () => true, requestProviderPlaybackSetup: bridge.request,
} }));
import SpotifyPlaybackSetup from '@/components/modal/settings/SpotifyPlaybackSetup';
import { spotifyPlaybackSetup } from '@/services/onlineMusic/spotifyPlaybackSetup';
import { cablePrerequisitesComplete, cableReady } from '@/services/onlineMusic/spotifyCableSetup';

const require = createRequire(import.meta.url);
const { createCableCaptureHost } = require('../../../electron/spotify/cableCaptureHost.cjs');
const { createCableSetup } = require('../../../electron/spotify/cableSetup.cjs');
const { QUEUE_BYTES } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
const mixFormat = { sampleRate: 44100, channels: 2, containerBits: 32 };
const baseIdentity = { state: 'verified', ownerInstanceId: 'ROOT\\MEDIA\\0001', failureStage: null, configRet: null };
const capture = { id: '{0.0.1.00000000}.{6ED4DB18-F40D-468B-9F3B-3A99175B436D}',
    name: 'CABLE Output (VB-Audio Virtual Cable)', deviceName: 'VB-Audio Virtual Cable',
    flow: 'capture', supportedBaseCable: true, mixFormat, baseIdentity };
// Endpoint IDs follow the supplied observation; the exact render labels match the user's Windows screenshot.
const line16 = { id: '{0.0.0.00000000}.{5DFB6494-BCA6-4EBC-BB9F-4D02781D6588}',
    name: 'CABLE In 16 Ch (VB-Audio Virtual Cable)', deviceName: 'VB-Audio Virtual Cable',
    flow: 'render', supportedBaseCable: true, mixFormat, baseIdentity };
// Localized speaker coverage is a native classification contract fixture, not a new hardware observation.
const speaker = { ...line16, id: 'synthetic-verified-base-speaker', name: '扬声器 (VB-Audio Virtual Cable)' };
const unrecognized = [
    { ...line16, id: 'unknown-pin', name: 'Unknown (VB-Audio Virtual Cable)', supportedBaseCable: false, baseIdentity: { state: 'unverified' } },
    ...['A', 'B', 'C'].map(letter => ({ ...line16, id: `cable-${letter}`, name: `CABLE-${letter} Input`,
        deviceName: `VB-Audio Cable ${letter}`, supportedBaseCable: false, baseIdentity: { state: 'unverified' } })),
    { ...line16, id: 'unclassified-pin', name: line16.name, supportedBaseCable: undefined },
    { ...line16, id: 'truthy-classification', name: line16.name, supportedBaseCable: 'true' },
];
const selected = (renderDeviceId = line16.id): ProviderCableSelection => ({ connectDeviceId: 'desktop',
    captureDeviceId: capture.id, renderDeviceId, internal44100Confirmed: true,
    spotifyOnlyConfirmed: true, defaultsConfirmed: true });
const cleanups: Array<() => Promise<void>> = [];
let root: Root | undefined, container: HTMLDivElement;
const flush = async () => { await act(async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); }); };
const button = (name: string) => Array.from(container.querySelectorAll('button'))
    .find(item => item.textContent === `spotifyCable.${name}`)!;
const select = (name: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="spotifyCable.${name}"]`)!;
const change = (name: string, value: string) => act(() => {
    const element = select(name); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
});
const click = async (name: string) => { await act(async () => button(name).click()); await flush(); };
const mount = async () => {
    root = createRoot(container);
    act(() => root!.render(React.createElement(React.StrictMode, null, React.createElement(SpotifyPlaybackSetup))));
    await flush();
};

// Feed JSONL replies through the real process owner. Unsupported native classifications are
// preserved, so the UI cannot regain a rejected endpoint by guessing from its display name.
function fixture(options: { endpoints?: any[]; saved?: ProviderCableSelection; enabled?: boolean; configuration?: any } = {}) {
    const endpoints = options.endpoints || [capture, line16, speaker, ...unrecognized];
    const calls: any[] = [], diagnostics: any[] = [], files = new Map<string, string>();
    const filename = '/synthetic-profile/spotify/cable-setup.json';
    if (options.saved) files.set(filename, JSON.stringify({ schema: 1, enabled: options.enabled === true, selection: options.saved }));
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => { child.emit('exit', 0, null); return true; });
    child.stdin = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString()); calls.push(request); done();
        queueMicrotask(() => {
            let result;
            if (request.action === 'hello') result = { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100,
                channels: 2, bitDepth: 32, sampleFormat: 's32le', queueCapacityBytes: QUEUE_BYTES,
                capabilities: ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', 'post-start-route-proof-v1', 'temporary-format-lease-v1'] };
            else if (request.action === 'devices') result = { endpoints, spotifyRunning: true };
            else if (request.action === 'inspect-route') result = { ready: true, issues: [], temporaryFormatLeaseEligible: true,
                selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le', sampleRateConversion: false,
                capture, render: endpoints.find(endpoint => endpoint.id === request.renderDeviceId),
                route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true }, ...options.configuration };
            else if (request.action === 'format-probe') {
                // Boundary witness only: fail before any native lease, stream or playback can exist.
                child.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: 'FORMAT_LEASE_FAILED' }) + '\n'); return;
            } else throw new Error(`Unexpected simulated helper action: ${request.action}`);
            child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
        });
    } });
    const connectImpl = vi.fn(() => { throw new Error('No audio pipe may open in this fixture'); });
    const host = createCableCaptureHost({ helperPath: 'C:\\Folia\\folia-capture.exe', platform: 'win32',
        spawnImpl: () => child, connectImpl, onControlDiagnostic: (value: any) => diagnostics.push(value) });
    const io = { readFile: vi.fn(async (file: string) => {
        if (!files.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return files.get(file);
    }), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async (file: string, text: string) => { files.set(file, text); }),
    rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
    unlink: vi.fn(async (file: string) => { files.delete(file); }), stat: vi.fn(async () => ({ isFile: () => false })) };
    const control = { listDevices: vi.fn(async () => [{ id: 'desktop', name: 'Synthetic desktop', type: 'Computer',
        selectable: true, isActive: true, restricted: false }]) };
    const setup = createCableSetup({ directory: '/synthetic-profile/spotify', captureHost: host, control, platform: 'win32', io });
    bridge.request.mockImplementation(async (_provider: string, input: ProviderPlaybackSetupRequest) =>
        setup.request({ action: 'playbackSetup', ...input }));
    cleanups.push(async () => { await setup.close(); await host.close(); });
    return { host, setup, calls, diagnostics, io, connectImpl,
        saved: () => files.has(filename) ? JSON.parse(files.get(filename)!) : undefined };
}

beforeEach(() => {
    // The main-process host receives Node buffers; keep that realm's Uint8Array under jsdom.
    vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.append(container);
    spotifyPlaybackSetup.store.setState({ status: null, busy: false, operation: null, progress: null, message: null });
    bridge.request.mockReset();
});
afterEach(async () => {
    act(() => root?.unmount()); root = undefined; container.remove();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.unstubAllGlobals();
});

describe('native Base endpoint classification through settings', () => {
    it('reproduces the old native rejection as an empty render list and blocks a saved rejected ID', async () => {
        const f = fixture({ endpoints: [capture, { ...line16, supportedBaseCable: false }], saved: selected() });
        await mount();
        expect(spotifyPlaybackSetup.store.getState().status).toMatchObject({ state: 'driver-missing', driverInstalled: false });
        expect(Array.from(select('renderEndpoint').options).map(option => option.value)).toEqual(['']);
        expect(button('start')).toBeUndefined(); expect(button('probe')).toBeUndefined();
        expect(spotifyPlaybackSetup.canRun('start')).toBe(false); expect(spotifyPlaybackSetup.canRun('probe')).toBe(false);
        await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
        expect(f.calls.some(call => ['inspect-route', 'format-probe', 'capture-open'].includes(call.action))).toBe(false);
        expect(f.io.writeFile).not.toHaveBeenCalled();
    });
    it.each([line16, speaker])('lists and saves the explicitly selected Base pin without inferring confirmations: $name', async endpoint => {
        // This legacy API fixture reuses its prior Windows-default acknowledgment; the new UI never creates one.
        const f = fixture({ saved: { ...selected(), connectDeviceId: '', captureDeviceId: '', renderDeviceId: '',
            internal44100Confirmed: false, spotifyOnlyConfirmed: false } }); await mount();
        expect(f.diagnostics.find(value => value.phase === 'inventory')).toMatchObject({ captureEndpointCount: 1, renderEndpointCount: 2 });
        expect(Array.from(select('renderEndpoint').options).map(option => option.value)).toEqual(['', line16.id, speaker.id]);
        expect(select('renderEndpoint').textContent).toContain(line16.name);
        expect(select('renderEndpoint').textContent).toContain(speaker.name);
        expect(JSON.stringify(spotifyPlaybackSetup.store.getState().status)).not.toContain(baseIdentity.ownerInstanceId);
        expect(select('renderEndpoint').value).toBe(''); expect(select('captureEndpoint').value).toBe('');
        expect(f.io.writeFile).not.toHaveBeenCalled();
        change('connectDevice', 'desktop'); change('renderEndpoint', endpoint.id); change('captureEndpoint', capture.id);
        expect(button('start')).toBeUndefined(); expect(spotifyPlaybackSetup.canRun('start')).toBe(false); await click('save');
        expect(spotifyPlaybackSetup.store.getState().status).toMatchObject({ state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED',
            driverInstalled: true, probe: { captureSampleRate: 44100, renderMixSampleRate: 44100, channels: 2 } });
        expect(Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).every(item => !item.checked)).toBe(true);
        expect(button('start')).toBeUndefined(); expect(button('probe')).toBeUndefined();
        expect(spotifyPlaybackSetup.canRun('start')).toBe(false); expect(spotifyPlaybackSetup.canRun('probe')).toBe(false);
        act(() => { container.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(item => item.click()); });
        expect(button('start')).toBeUndefined(); expect(spotifyPlaybackSetup.canRun('start')).toBe(false); await click('save');
        const status = spotifyPlaybackSetup.store.getState().status;
        expect(status).toMatchObject({ state: 'stopped', driverInstalled: true, selection: selected(endpoint.id) });
        expect(f.saved()).toEqual({ schema: 1, enabled: false, selection: selected(endpoint.id) });
        expect(cablePrerequisitesComplete(status)).toBe(true); expect(cableReady(status)).toBe(false);
        expect(button('start')).toBeUndefined(); expect(button('probe')).toBeUndefined();
        expect(spotifyPlaybackSetup.canRun('start')).toBe(true); expect(spotifyPlaybackSetup.canRun('probe')).toBe(true);
        await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
        await click('refreshDevices');
        expect(select('renderEndpoint').value).toBe(endpoint.id);
        expect(f.calls.every(call => ['hello', 'devices', 'inspect-route'].includes(call.action))).toBe(true);
        expect(f.connectImpl).not.toHaveBeenCalled();
    });
    it.each(['unknown-pin', 'cable-A', 'cable-B', 'cable-C', 'unclassified-pin', 'truthy-classification'])
    ('does not promote native-rejected %s through a saved selection', async renderDeviceId => {
        const f = fixture({ saved: selected(renderDeviceId) }); await mount();
        expect(spotifyPlaybackSetup.store.getState().status).toMatchObject({ state: 'selection-required', driverInstalled: true });
        expect(Array.from(select('renderEndpoint').options).map(option => option.value)).not.toContain(renderDeviceId);
        await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
        expect(f.calls.every(call => ['hello', 'devices'].includes(call.action))).toBe(true);
    });
    it.each([
        { configuration: { ready: false, issues: ['RENDER_CHANNELS_MISMATCH'],
            render: { ...speaker, mixFormat: { ...mixFormat, channels: 16 } }, temporaryFormatLeaseEligible: false },
        state: 'format-mismatch', code: 'CABLE_FORMAT_REQUIRED', failure: 'cable-format-required' },
        { configuration: { ready: false, issues: ['CABLE_IS_DEFAULT_RENDER'], temporaryFormatLeaseEligible: false,
            route: { ready: false, spotifyOnlyObserved: false, spotifySessionPresent: true } },
        state: 'routing-required', code: 'CABLE_IS_DEFAULT_RENDER', failure: 'cable-setup-required' },
        { configuration: { ready: false, issues: ['BASE_CABLE_ENDPOINT_REQUIRED'], temporaryFormatLeaseEligible: false,
            render: { ...speaker, baseIdentity: { ...baseIdentity, ownerInstanceId: 'ROOT\\MEDIA\\0002' } } },
        state: 'routing-required', code: 'BASE_CABLE_ENDPOINT_REQUIRED', failure: 'cable-setup-required' },
    ])('keeps observed $code blocked even when every confirmation is saved', async ({ configuration, state, code, failure }) => {
        const f = fixture({ saved: selected(speaker.id), configuration });
        await mount();
        expect(spotifyPlaybackSetup.store.getState().status).toMatchObject({ state, code });
        await expect(f.setup.getSelection()).rejects.toThrow(failure);
        expect(f.calls.some(call => call.action === 'format-probe')).toBe(false);
    });
});

describe('existing lease boundary, without executing a native lease', () => {
    it.each(['start', 'probe'] as const)('records that explicit %s currently requests format-probe even at valid stereo 44100', async operation => {
        const f = fixture({ saved: selected(speaker.id) }); await mount();
        expect(spotifyPlaybackSetup.store.getState().status).toMatchObject({ state: 'stopped', probe: {
            channels: 2, captureSampleRate: 44100, renderMixSampleRate: 44100, temporaryFormatLeaseEligible: true } });
        expect(f.calls.some(call => call.action === 'format-probe')).toBe(false);
        expect(button(operation)).toBeUndefined();
        // Retain direct legacy API coverage after removing the daily probe/start UI gate.
        await act(async () => { await spotifyPlaybackSetup.run({ operation }); }); await flush();
        expect(f.calls.filter(call => call.action === 'format-probe')).toEqual([expect.objectContaining({
            action: 'format-probe', captureDeviceId: capture.id, renderDeviceId: speaker.id, temporaryFormatLease: true })]);
        expect(spotifyPlaybackSetup.store.getState().status).toMatchObject({ state: 'format-mismatch', code: 'FORMAT_LEASE_FAILED' });
        expect(f.saved().enabled).toBe(false); expect(f.connectImpl).not.toHaveBeenCalled();
    });
    it('records that an already enabled 44100 selection still returns the lease-request field for capture-open', async () => {
        const f = fixture({ saved: selected(speaker.id), enabled: true }); await mount();
        expect(await f.setup.getSelection()).toEqual({ deviceId: 'desktop', captureDeviceId: capture.id,
            renderDeviceId: speaker.id, temporaryFormatLease: true });
        expect(f.calls.some(call => ['format-probe', 'capture-open'].includes(call.action))).toBe(false);
        expect(f.io.writeFile).not.toHaveBeenCalled(); expect(f.connectImpl).not.toHaveBeenCalled();
    });
});
