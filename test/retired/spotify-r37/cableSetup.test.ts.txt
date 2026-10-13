import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpotifyPlaybackSetupController } from '@/services/onlineMusic/spotifyPlaybackSetup';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';

vi.mock('@/services/onlineMusic/omni', () => ({ omni: { hasProviderPlaybackSetup: () => false } }));
afterEach(() => useStatusMessageStore.setState({ message: null }));

// Fixed-device setup persists only explicit selections and never writes Windows audio settings.
const require = createRequire(import.meta.url);
const { createCableSetup } = require('../../../electron/spotify/cableSetup.cjs');
const selection = { connectDeviceId: 'desktop', captureDeviceId: 'capture', renderDeviceId: 'render',
  internal44100Confirmed: true, spotifyOnlyConfirmed: true, defaultsConfirmed: true };
function fixture(options: any = {}) {
  const files = new Map<string, string>();
  const io = { readFile: vi.fn(async (file: string) => {
    if (!files.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return files.get(file);
  }), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async (file: string, data: string) => files.set(file, data)),
  rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
  unlink: vi.fn(async (file: string) => files.delete(file)), stat: vi.fn(async () => ({ isFile: () => true })) };
  const endpoints = ['capture', 'render'].map(flow => ({ id: flow, name: 'CABLE ' + flow, flow, supportedBaseCable: true }));
  const captureHost: any = { devices: vi.fn(async () => ({ endpoints, spotifyRunning: true })), formatProbe: vi.fn(), inspectRoute: vi.fn(async () => ({
    ready: true, issues: [], capture: { mixFormat: { sampleRate: 44100, channels: 2 } },
    render: { mixFormat: { sampleRate: 44100, channels: 2 } }, route: { spotifyOnlyObserved: true },
    sessions: [{ executablePath: 'PRIVATE_PATH', processId: 321 }],
  })) };
  const control = { listDevices: vi.fn(async () => [{ id: 'desktop', name: 'Desktop', selectable: true, isActive: true, type: 'Computer' }]) };
  const revokePlayback = vi.fn(async (_options?: any) => {}), openPath = vi.fn(async () => ''), openExternal = vi.fn(async () => {});
  const args = { directory: '/profile/spotify', driverDirectory: '/owned/vendor', io, captureHost, control,
    revokePlayback, openPath, openExternal, platform: 'win32', ...options };
  return { setup: createCableSetup(args), args, files, io, captureHost, control, revokePlayback, openPath, openExternal };
}
const command = (operation: string, extra = {}) => ({ action: 'playbackSetup', operation, ...extra });
describe('r19 automatic route playback admission', () => {
  const lifecycle = () => ({ offer: vi.fn(async () => ({ trialAvailable: true })), setTrialEnabled: vi.fn(),
    availability: vi.fn(), inspect: vi.fn() });
  it('keeps passive status and saving observational, and admits the profile only on an actual track request', async () => {
    const routeLifecycle = lifecycle(), f = fixture({ routeLifecycle });
    const status = await f.setup.request(command('saveSelection', { selection }));
    expect(status).toMatchObject({ state: 'stopped', code: 'AUTOMATIC_ROUTE_ON_PLAY', automaticRoute: { enabled: true, eligible: true } });
    expect(routeLifecycle.setTrialEnabled).not.toHaveBeenCalled();
    expect(routeLifecycle.availability).not.toHaveBeenCalled(); expect(routeLifecycle.inspect).not.toHaveBeenCalled();
    expect(f.captureHost.inspectRoute).not.toHaveBeenCalled(); expect(f.captureHost.formatProbe).not.toHaveBeenCalled();
    expect(await f.setup.getSelection()).toEqual({ deviceId: 'desktop', captureDeviceId: 'capture', renderDeviceId: 'render',
      temporaryFormatLease: true, automaticRouting: true });
    expect(routeLifecycle.setTrialEnabled).toHaveBeenCalledWith(true);
    expect(JSON.parse([...f.files.values()][0]).enabled).toBe(false);
  });
  it('requires only the saved vendor internal-rate fact and once-only client-output acknowledgement', async () => {
    const routeLifecycle = lifecycle(), f = fixture({ routeLifecycle });
    await f.setup.request(command('saveSelection', { selection: { ...selection, defaultsConfirmed: false } }));
    await expect(f.setup.getSelection()).resolves.toMatchObject({ automaticRouting: true });
    expect((await f.setup.request(command('saveSelection', { selection: { ...selection, spotifyOnlyConfirmed: false } }))).code)
      .toBe('SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED');
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    expect((await f.setup.request(command('saveSelection', { selection: { ...selection, internal44100Confirmed: false } }))).code)
      .toBe('CABLE_INTERNAL_RATE_CONFIRMATION_REQUIRED');
  });
  it('preserves old selected endpoints and internal-rate evidence but never upgrades the old explicit-VB acknowledgement', async () => {
    const f = fixture({ routeLifecycle: lifecycle() });
    f.files.set('/profile/spotify/cable-setup.json', JSON.stringify({ schema: 1, enabled: true, selection }));
    expect(await f.setup.request(command('status'))).toMatchObject({ code: 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED',
      selection: { ...selection, spotifyOnlyConfirmed: false } });
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    expect(f.io.writeFile).not.toHaveBeenCalled();
  });
  it('keeps the new one-time acknowledgement outside the original six-field r18 rollback schema', async () => {
    const { validateSelection: validateR18 } = require('./fixtures/r18CableSelection.cjs');
    const f = fixture({ routeLifecycle: lifecycle() });
    await f.setup.request(command('saveSelection', { selection }));
    const stored = JSON.parse([...f.files.values()][0]);
    expect(validateR18(stored.selection)).toEqual({ ...selection, spotifyOnlyConfirmed: false });
    expect(stored).toMatchObject({ automaticRouteSchema: 1, spotifyClientOutputConfirmed: true });
    expect(stored.automaticRouteTrialEnabled).toBeUndefined();
    await f.setup.close(); const again = createCableSetup(f.args);
    expect((await again.request(command('status'))).selection).toEqual(selection);
    await expect(again.getSelection()).resolves.toMatchObject({ automaticRouting: true });
    await again.close();
  });
  it('waits for verified old capture cleanup before saving changed endpoint choices', async () => {
    const f = fixture({ routeLifecycle: lifecycle() });
    await f.setup.request(command('saveSelection', { selection })); const before = [...f.files.values()][0];
    let finish!: () => void;
    f.revokePlayback.mockImplementationOnce((options: any) => {
      expect(options).toEqual({ verifyCaptureStop: true }); return new Promise<void>(resolve => { finish = resolve; });
    });
    const saving = f.setup.request(command('saveSelection', { selection: { ...selection, spotifyOnlyConfirmed: false } }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); expect([...f.files.values()][0]).toBe(before);
    finish(); await saving;
    expect(JSON.parse([...f.files.values()][0]).spotifyClientOutputConfirmed).toBe(false);
  });
  it('passes an inactive saved target to controlled playback but refuses a missing target or renderer admission flag', async () => {
    const f = fixture({ routeLifecycle: lifecycle() });
    await f.setup.request(command('saveSelection', { selection }));
    f.control.listDevices.mockResolvedValue([{ id: 'desktop', name: 'Desktop', selectable: true, isActive: false, type: 'Computer' }]);
    await expect(f.setup.getSelection()).resolves.toMatchObject({ deviceId: 'desktop', automaticRouting: true });
    f.control.listDevices.mockResolvedValue([{ id: 'foreign', name: 'Remote', selectable: true, isActive: true, type: 'Computer' }]);
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    await expect(f.setup.request(command('saveSelection', { selection: { ...selection, automaticRouteTrialEnabled: true } })))
      .rejects.toThrow('invalid-cable-selection');
  });
  it('exposes only the bounded same-desktop recovery receipt and clears it through an explicit read-only check', async () => {
    const routeLifecycle = lifecycle(), f = fixture({ routeLifecycle });
    await f.setup.request(command('saveSelection', { selection }));
    let required = true;
    Object.assign(f.control, {
      inspectColdRecovery: vi.fn(async () => required ? { required: true, recoverable: true, deviceId: 'desktop', originalVolume: 63,
        path: 'PRIVATE_PATH', trackId: 'PRIVATE_TRACK', session: 'PRIVATE_SESSION' } : { required: false, recoverable: false }),
      checkColdRecovery: vi.fn(async (input: any) => { expect(input).toEqual({ deviceId: 'desktop' }); required = false; }),
    });
    const status = await f.setup.request(command('status'));
    expect(status).toMatchObject({ code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED', coldRecovery: {
      required: true, recoverable: true, deviceId: 'desktop', originalVolume: 63 } });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE_/);
    await expect(f.setup.getSelection()).rejects.toThrow('spotify-cold-volume-recovery-required');
    f.revokePlayback.mockClear(); const writes = f.io.writeFile.mock.calls.length;
    const renderer = createSpotifyPlaybackSetupController({ supported: () => true,
      request: input => f.setup.request({ action: 'playbackSetup', ...input }) });
    await renderer.refresh();
    useStatusMessageStore.setState({ message: { type: 'error', text: 'Synthetic recovery required', persistent: true,
      statusKey: 'spotify-cold-volume-recovery-required' } });
    expect(await renderer.run({ operation: 'checkColdRecovery' })).toBe(true);
    expect(renderer.store.getState().status).toMatchObject({ state: 'stopped', code: 'AUTOMATIC_ROUTE_ON_PLAY',
      coldRecovery: { required: false, recoverable: false } });
    expect(useStatusMessageStore.getState().message).toBeNull();
    expect(f.revokePlayback).not.toHaveBeenCalled(); expect(routeLifecycle.setTrialEnabled).not.toHaveBeenCalled();
    expect(routeLifecycle.inspect).not.toHaveBeenCalled(); expect(f.io.writeFile).toHaveBeenCalledTimes(writes);
  });
  it.each([undefined, null, {}, { required: 'false' }, new Error('synthetic inspect failure')])(
    'does not project unknown recovery evidence %j as a verified clear or dismiss the renderer error', async unknown => {
      const f = fixture({ routeLifecycle: lifecycle() }); await f.setup.request(command('saveSelection', { selection }));
      let receipt: any = { required: true, recoverable: true, deviceId: 'desktop', originalVolume: 63 };
      Object.assign(f.control, {
        inspectColdRecovery: async () => { if (receipt instanceof Error) throw receipt; return receipt; },
        checkColdRecovery: async () => { receipt = unknown; },
      });
      const renderer = createSpotifyPlaybackSetupController({ supported: () => true,
        request: input => f.setup.request({ action: 'playbackSetup', ...input }) });
      await renderer.refresh();
      const message = { type: 'error' as const, text: 'Synthetic recovery required', persistent: true,
        statusKey: 'spotify-cold-volume-recovery-required' as const };
      useStatusMessageStore.setState({ message });
      await renderer.run({ operation: 'checkColdRecovery' });
      expect(renderer.store.getState().status?.coldRecovery?.required).not.toBe(false);
      expect(useStatusMessageStore.getState().message).toBe(message);
    });
  it('does not offer receipt recovery for another saved target or expose malformed evidence as valid', async () => {
    const f = fixture({ routeLifecycle: lifecycle() }); await f.setup.request(command('saveSelection', { selection }));
    const receipt: any = { required: true, recoverable: true, deviceId: 'other-desktop', originalVolume: 63 };
    Object.assign(f.control, { inspectColdRecovery: async () => receipt, checkColdRecovery: async () => { throw new Error('blocked'); } });
    expect((await f.setup.request(command('status'))).coldRecovery.recoverable).toBe(false);
    receipt.deviceId = 'desktop'; receipt.originalVolume = 101;
    expect((await f.setup.request(command('status'))).coldRecovery).toEqual({ required: true, recoverable: false, deviceId: 'desktop' });
    await expect(f.setup.request(command('checkColdRecovery'))).rejects.toThrow('blocked');
    expect((await f.setup.request(command('status'))).coldRecovery.required).toBe(true);
  });
});
describe('VB-CABLE explicit setup', () => {
  it('requires selections and does not play, install or alter routing on status', async () => {
    const f = fixture(); const value = await f.setup.request(command('status'));
    expect(value.state).toBe('selection-required'); expect(f.openPath).not.toHaveBeenCalled(); expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.io.writeFile).not.toHaveBeenCalled(); expect(f.revokePlayback).not.toHaveBeenCalled();
  });
  it('supports partial selection, requires actual probe and explicit start', async () => {
    const f = fixture();
    expect((await f.setup.request(command('saveSelection', { selection: { ...selection, captureDeviceId: '' } }))).state).toBe('selection-required');
    expect((await f.setup.request(command('saveSelection', { selection }))).state).toBe('stopped');
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    expect((await f.setup.request(command('start'))).state).toBe('ready');
    expect(await f.setup.getSelection()).toEqual({ deviceId: 'desktop', captureDeviceId: 'capture', renderDeviceId: 'render', temporaryFormatLease: true });
    expect(f.openPath).not.toHaveBeenCalled();
  });
  it('does not count the three confirmations as proof of format', async () => {
    const f = fixture(); f.captureHost.inspectRoute.mockResolvedValue({ ready: true, issues: [],
      capture: { mixFormat: { sampleRate: 48000, channels: 2 } }, render: { mixFormat: { sampleRate: 48000, channels: 2 } }, route: { spotifyOnlyObserved: true } });
    expect((await f.setup.request(command('saveSelection', { selection }))).state).toBe('format-mismatch');
    expect((await f.setup.request(command('start'))).state).toBe('format-mismatch');
    expect([...f.files.values()].some(text => text.includes('"enabled":true'))).toBe(false);
  });
  it('requires internal-rate, Spotify-only and default-device confirmations independently', async () => {
    for (const key of ['internal44100Confirmed', 'spotifyOnlyConfirmed', 'defaultsConfirmed']) {
      const f = fixture(); await f.setup.request(command('saveSelection', { selection: { ...selection, [key]: false } }));
      expect((await f.setup.request(command('start'))).state).toBe('routing-required');
    }
  });
  it('rejects shared/default/feedback route instead of choosing another device', async () => {
    const f = fixture(); f.captureHost.inspectRoute.mockResolvedValue({ ready: false, issues: ['CABLE_IS_DEFAULT_RENDER'],
      capture: { mixFormat: { sampleRate: 44100, channels: 2 } }, render: { mixFormat: { sampleRate: 44100, channels: 2 } }, route: { spotifyOnlyObserved: false } });
    const value = await f.setup.request(command('saveSelection', { selection }));
    expect(value.state).toBe('routing-required'); expect(value.probe.defaultRenderIsCable).toBe(true);
    expect(value.selection).toEqual(selection); expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('persists only selected IDs and confirmations; public status omits process paths', async () => {
    const f = fixture(); const value = await f.setup.request(command('saveSelection', { selection }));
    expect(JSON.stringify(value)).not.toContain('PRIVATE_PATH'); expect(JSON.stringify(value)).not.toContain('processId');
    expect(JSON.parse([...f.files.values()][0])).toEqual({ schema: 1, enabled: false, selection });
  });
  it('restores explicit selection across restart without writing credentials or reinstalling', async () => {
    const f = fixture(); await f.setup.request(command('saveSelection', { selection })); await f.setup.request(command('start'));
    await f.setup.close(); const again = createCableSetup(f.args);
    expect((await again.request(command('status'))).state).toBe('ready');
    expect(f.openPath).not.toHaveBeenCalled(); expect(f.files.size).toBe(1);
  });
  it('stops active source before committing new selection or stopped state', async () => {
    const f = fixture(); await f.setup.request(command('saveSelection', { selection })); await f.setup.request(command('start'));
    const before = f.revokePlayback.mock.calls.length;
    expect((await f.setup.request(command('stop'))).state).toBe('stopped');
    expect(f.revokePlayback).toHaveBeenCalledTimes(before + 1);
    expect(JSON.parse([...f.files.values()][0]).enabled).toBe(false);
  });
  it('uses fixed main-owned vendor paths and settings URI only on explicit actions', async () => {
    const f = fixture(); await f.setup.request(command('openDriver')); await f.setup.request(command('openCablePanel')); await f.setup.request(command('openSoundSettings'));
    expect(f.openPath.mock.calls).toEqual([['/owned/vendor/VBCABLE_Setup_x64.exe'], ['/owned/vendor/VBCABLE_ControlPanel.exe']]);
    expect(f.openExternal.mock.calls).toEqual([['ms-settings:apps-volume']]);
    await expect(f.setup.request(command('openDriver', { path: '/foreign.exe' }))).rejects.toThrow('invalid-cable-setup');
  });
  it('does not swallow failed vendor launch or overwrite malformed saved configuration', async () => {
    const f = fixture(); f.openPath.mockResolvedValue('Windows rejected launch');
    await expect(f.setup.request(command('openDriver'))).rejects.toThrow('cable-vendor-open-failed');
    const g = fixture(); g.files.set('/profile/spotify/cable-setup.json', '{malformed');
    await expect(g.setup.request(command('saveSelection', { selection }))).rejects.toThrow('cable-settings-invalid');
    expect(g.files.get('/profile/spotify/cable-setup.json')).toBe('{malformed');
  });
  it('reports unsupported cloud platform without starting the Windows helper', async () => {
    const f = fixture({ platform: 'linux' }); expect((await f.setup.request(command('status'))).state).toBe('unsupported');
    expect(f.captureHost.devices).not.toHaveBeenCalled(); await expect(f.setup.request(command('openDriver'))).rejects.toThrow('windows-required');
  });
  it('rejects audio preparation during setup without creating a mutation/clear deadlock', async () => {
    const f = fixture(); let release!: () => void;
    f.revokePlayback.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const saving = f.setup.request(command('saveSelection', { selection }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-busy'); release(); await saving;
  });
  it('rejects a late observation after account/session clear rather than publishing ready', async () => {
    const f = fixture(); await f.setup.request(command('saveSelection', { selection }));
    let resolve!: (value: any) => void;
    f.captureHost.devices.mockImplementation(() => new Promise<any>(done => { resolve = done; }));
    const pending = f.setup.request(command('status')); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    f.setup.clear(); resolve({ endpoints: [], spotifyRunning: false });
    await expect(pending).rejects.toThrow('request-cancelled');
  });
  it('negotiates formats only on an explicit probe/start, then marks idle readback honestly', async () => {
    const f = fixture();
    const idle = { ready: false, issues: ['CAPTURE_RATE_MISMATCH', 'RENDER_RATE_MISMATCH'], temporaryFormatLeaseEligible: true,
      capture: { mixFormat: { sampleRate: 48000, channels: 2 } }, render: { mixFormat: { sampleRate: 48000, channels: 2 } },
      route: { spotifyOnlyObserved: true } };
    f.captureHost.inspectRoute.mockResolvedValue(idle);
    f.captureHost.formatProbe.mockResolvedValue({ state: 'released', verified: true, formatLease: { state: 'released' },
      configuration: { ...idle, ready: true, issues: [], capture: { mixFormat: { sampleRate: 44100, channels: 2 } },
        render: { mixFormat: { sampleRate: 44100, channels: 2 } }, formatLease: { verified: true, state: 'released' } } });
    await f.setup.request(command('saveSelection', { selection })); await f.setup.request(command('status'));
    expect(f.captureHost.formatProbe).not.toHaveBeenCalled();
    expect((await f.setup.request(command('start'))).state).toBe('ready');
    expect(f.captureHost.formatProbe).toHaveBeenCalledTimes(1);
    expect(f.captureHost.formatProbe).toHaveBeenCalledWith({ ...selection, temporaryFormatLease: true });
    const status = await f.setup.request(command('status'));
    expect(status.state).toBe('ready'); expect(status.code).toBe('FORMAT_LEASE_ON_PLAY');
    expect(status.probe.captureSampleRate).toBe(48000); expect(status.probe.formatLeaseApplied).toBe(false);
    expect((await f.setup.getSelection()).temporaryFormatLease).toBe(true);
    expect(f.captureHost.formatProbe).toHaveBeenCalledTimes(1);
  });
  it('keeps setup incomplete when either endpoint lease is rejected, preserving user selection', async () => {
    const f = fixture(); f.captureHost.inspectRoute.mockResolvedValue({ temporaryFormatLeaseEligible: true,
      ready: false, issues: ['CAPTURE_RATE_MISMATCH'], capture: { mixFormat: { sampleRate: 48000, channels: 2 } },
      render: { mixFormat: { sampleRate: 44100, channels: 2 } }, route: { spotifyOnlyObserved: true } });
    f.captureHost.formatProbe.mockResolvedValue({ state: 'configuration-required', verified: false, errorCode: 'FORMAT_LEASE_LOCKED' });
    await f.setup.request(command('saveSelection', { selection }));
    const status = await f.setup.request(command('start'));
    expect(status.state).toBe('format-mismatch'); expect(status.code).toBe('FORMAT_LEASE_LOCKED');
    expect(status.selection).toEqual(selection); expect(JSON.parse([...f.files.values()][0]).enabled).toBe(false);
  });
  it('refuses an inactive official desktop without attempting transfer or a format lease', async () => {
    const f = fixture(); f.control.listDevices.mockResolvedValue([{ id: 'desktop', name: 'Desktop', selectable: true, isActive: false, type: 'Computer' }]);
    const status = await f.setup.request(command('saveSelection', { selection }));
    expect(status.state).toBe('selection-required'); expect(status.code).toBe('DEVICE_INACTIVE');
    expect(f.captureHost.formatProbe).not.toHaveBeenCalled(); expect(f.captureHost.inspectRoute).not.toHaveBeenCalled();
  });
  it('keeps inactive status honest while allowing an enabled saved route to be restored by active playback', async () => {
    const f = fixture(); await f.setup.request(command('saveSelection', { selection })); await f.setup.request(command('start'));
    const saved = [...f.files.values()][0], writes = f.io.writeFile.mock.calls.length;
    await f.setup.close(); const again = createCableSetup(f.args);
    f.control.listDevices.mockResolvedValue([{ id: 'desktop', name: 'Desktop', selectable: true, isActive: false, type: 'Computer' }]);
    expect(await again.request(command('status'))).toMatchObject({ state: 'selection-required', code: 'DEVICE_INACTIVE', selection });
    const inspections = f.captureHost.inspectRoute.mock.calls.length;
    expect(await again.getSelection()).toEqual({ deviceId: 'desktop', captureDeviceId: 'capture', renderDeviceId: 'render', temporaryFormatLease: true });
    expect(f.captureHost.inspectRoute).toHaveBeenCalledTimes(inspections + 1);
    expect(await again.request(command('status'))).toMatchObject({ state: 'selection-required', code: 'DEVICE_INACTIVE' });
    expect([...f.files.values()][0]).toBe(saved); expect(f.io.writeFile).toHaveBeenCalledTimes(writes);
    expect(f.captureHost.formatProbe).not.toHaveBeenCalled(); expect(f.openPath).not.toHaveBeenCalled(); expect(f.openExternal).not.toHaveBeenCalled();
    await again.close();
  });
  it('does not enable an inactive route or replace a missing saved desktop as part of active preparation', async () => {
    const f = fixture(); await f.setup.request(command('saveSelection', { selection }));
    f.control.listDevices.mockResolvedValue([{ id: 'desktop', name: 'Desktop', selectable: true, isActive: false, type: 'Computer' }]);
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    expect(JSON.parse([...f.files.values()][0]).enabled).toBe(false);
    f.control.listDevices.mockResolvedValue([{ id: 'different-desktop', name: 'Desktop', selectable: true, isActive: true, type: 'Computer' }]);
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    expect(JSON.parse([...f.files.values()][0]).selection).toEqual(selection);
  });
  it('still requires an observed safe local route before returning an inactive saved target', async () => {
    const f = fixture(); await f.setup.request(command('saveSelection', { selection })); await f.setup.request(command('start'));
    f.control.listDevices.mockResolvedValue([{ id: 'desktop', name: 'Desktop', selectable: true, isActive: false, type: 'Computer' }]);
    f.captureHost.inspectRoute.mockResolvedValue({ ready: false, issues: ['SPOTIFY_ROUTE_NOT_FOUND'],
      capture: { mixFormat: { sampleRate: 44100, channels: 2 } }, render: { mixFormat: { sampleRate: 44100, channels: 2 } },
      route: { spotifyOnlyObserved: false } });
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    expect(JSON.parse([...f.files.values()][0])).toEqual({ schema: 1, enabled: true, selection });
  });
});

// Diagnostic wording must never change the original explicit setup gates.
describe('confirmation and route diagnostic distinctions', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])('keeps partial confirmation mask %i blocked without auto-writes or inferred internal rate', async mask => {
    const f = fixture(), partial = { ...selection, internal44100Confirmed: Boolean(mask & 1),
      spotifyOnlyConfirmed: Boolean(mask & 2), defaultsConfirmed: Boolean(mask & 4) };
    const saved = await f.setup.request(command('saveSelection', { selection: partial }));
    expect(saved).toMatchObject({ state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED',
      driverInstalled: true, selection: partial, probe: { routeVerified: true, captureSampleRate: 44100 } });
    const writes = f.io.writeFile.mock.calls.length;
    const started = await f.setup.request(command('start'));
    expect(started.state).toBe('routing-required'); expect(started.code).toBe('CABLE_CONFIRMATION_REQUIRED');
    await expect(f.setup.getSelection()).rejects.toThrow('cable-setup-required');
    await f.setup.close(); const reopened = createCableSetup(f.args);
    expect(await reopened.request(command('status'))).toMatchObject({ state: 'routing-required',
      code: 'CABLE_CONFIRMATION_REQUIRED', selection: partial });
    expect(f.io.writeFile).toHaveBeenCalledTimes(writes);
    expect(JSON.parse([...f.files.values()][0])).toEqual({ schema: 1, enabled: false, selection: partial });
    expect(f.captureHost.formatProbe).not.toHaveBeenCalled(); expect(f.openPath).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled(); await reopened.close();
  });
  it.each(['CABLE_IS_DEFAULT_RENDER', 'CABLE_SHARED_WITH_OTHER_AUDIO', 'FOLIA_FEEDBACK_ROUTE',
    'SPOTIFY_ROUTE_NOT_FOUND', 'ROUTE_IDENTITY_UNAVAILABLE', undefined])('keeps route failure %s distinct from missing confirmations and driver failure', async code => {
    const f = fixture(), partial = { ...selection, internal44100Confirmed: false };
    f.captureHost.inspectRoute.mockResolvedValue({ ready: false, issues: code ? [code] : [],
      capture: { mixFormat: { sampleRate: 44100, channels: 2 } }, render: { mixFormat: { sampleRate: 44100, channels: 2 } },
      route: { spotifyOnlyObserved: false } });
    const saved = await f.setup.request(command('saveSelection', { selection: partial }));
    expect(saved).toMatchObject({ state: 'routing-required', code: code || 'ROUTE_OBSERVATION_FAILED',
      driverInstalled: true, selection: partial, probe: { routeVerified: false } });
    const writes = f.io.writeFile.mock.calls.length;
    expect(await f.setup.request(command('start'))).toMatchObject({ state: 'routing-required', code: code || 'ROUTE_OBSERVATION_FAILED' });
    expect(f.io.writeFile).toHaveBeenCalledTimes(writes); expect(f.openPath).not.toHaveBeenCalled();
  });
  it('does not label an unsuccessful route observation as a missing confirmation even when all boxes are true', async () => {
    const f = fixture(); f.captureHost.inspectRoute.mockResolvedValue({ ready: false, issues: [],
      capture: { mixFormat: { sampleRate: 44100, channels: 2 } }, render: { mixFormat: { sampleRate: 44100, channels: 2 } },
      route: { spotifyOnlyObserved: true } });
    expect(await f.setup.request(command('saveSelection', { selection }))).toMatchObject({ state: 'routing-required', code: 'ROUTE_OBSERVATION_FAILED' });
    expect((await f.setup.request(command('start'))).state).toBe('routing-required');
    expect(JSON.parse([...f.files.values()][0]).enabled).toBe(false);
  });
  it('keeps a route-probe exception separate from capture-helper unavailability and endpoint absence', async () => {
    const f = fixture(); f.captureHost.inspectRoute.mockRejectedValue(new Error('PRIVATE_ERROR'));
    expect(await f.setup.request(command('saveSelection', { selection }))).toMatchObject({
      state: 'failed', code: 'ROUTE_PROBE_FAILED', driverInstalled: true });
    expect((await f.setup.request(command('start'))).code).toBe('ROUTE_PROBE_FAILED');
    expect(JSON.parse([...f.files.values()][0]).enabled).toBe(false);
  });
});
