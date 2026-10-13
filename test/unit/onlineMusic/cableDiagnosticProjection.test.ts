import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

// The capture exporter accepts bounded measurements and discards all device/account/content identity.
const require = createRequire(import.meta.url);
const { projectEvent, projectBuildInfo, projectConfigurationIssueCodes, buildReference, SOURCE_FILES } = require('../../../electron/debug/privatePreviewDiagnosticSchema.cjs');
const { reportCableSetup, reportCableHelper, reportOwnedRoute } = require('../../../electron/spotify/cableDiagnostics.cjs');
const { installPreviewDiagnosticSink } = require('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { observeSpotifyOperation } = require('../../../electron/spotify/privatePreviewObserver.cjs');
const { NATIVE_FAILURE_CODES } = require('../../../electron/spotify/ownedRouteProtocol.cjs');
const { publicError } = require('../../../electron/spotify/cableAudioFacts.cjs');
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function journal() {
  const values: any[] = [];
  cleanups.push(installPreviewDiagnosticSink({ enabled: () => true,
    record: (type: string, fields: any) => { values.push({ type, fields }); return true; } }));
  return values;
}
it('retains every fixed native rejection reason without allowing exception detail or changing terminal evidence', () => {
  for (const code of NATIVE_FAILURE_CODES) {
    expect(projectEvent('spotify.capture', { phase: 'failed', errorCode: code }).fields.errorCode).toBe(code);
    expect(projectEvent('spotify.capture', { phase: 'failed', errorCode: code + ':PRIVATE_PATH' }).fields.errorCode).toBeUndefined();
  }
  expect(publicError({ code: 'PRODUCT_JOURNAL_ROOT_CREATE_FAILED', message: 'PRIVATE_PATH' }).message).toContain('automatic-route-storage-unavailable');
  expect(publicError({ code: 'ORIGINAL_ENDPOINT_UNSAFE', message: 'PRIVATE_RAW_POLICY' }).message).toContain('spotify-original-route-unsafe');
});
it('records owned-route stages and restoration proof without endpoint, process, role value or track identity', () => {
  const values = journal();
  reportOwnedRoute({ phase: 'held-paused', session: 'private-route-session', generation: 1, ready: false,
    exactOriginalRolesRestored: false, processId: 4321, endpointId: 'PRIVATE_ENDPOINT', sourceUri: 'PRIVATE_TRACK',
    originalRoles: [{ role: 0, original: 'PRIVATE_SAVED_ENDPOINT' }] });
  reportOwnedRoute({ phase: 'failed', generation: 1, ready: false, exactOriginalRolesRestored: false,
    errorCode: 'ROUTE_SOURCE_PAUSE_UNCONFIRMED', message: 'PRIVATE_EXCEPTION' });
  expect(values[0]).toMatchObject({ type: 'spotify.route-lease', fields: { phase: 'held-paused', generation: 1, ready: false,
    exactOriginalRolesRestored: false } });
  expect(values[1].fields.errorCode).toBe('ROUTE_SOURCE_PAUSE_UNCONFIRMED');
  expect(JSON.stringify(values)).not.toMatch(/PRIVATE|private-route-session|4321|sourceUri|originalRoles/);
});
it('retains useful capture measurements while dropping private and unbounded values', () => {
  let getterRead = false;
  const input = { phase: 'sample', sessionRef: 1, generation: 2, captureSampleRate: 44100, renderSampleRate: 44100,
    captureChannels: 2, captureBits: 32, capturedFrames: 44100, deliveredFrames: 43800, queuedBytes: 2400,
    queueCapacityBytes: 705600, formatLeaseApplied: true, routeSpotifyOnly: true, sampleRateConversion: false,
    sourceCodec: 'FLAC', sourceLossless: true, sourceBitPerfect: true, processId: 999, path: 'private/path',
    endpointId: 'private-device', token: 'private-token', pcm: [1, 2, 3], durationMs: Infinity,
    get renderChannels() { getterRead = true; return 2; } };
  expect(projectEvent('spotify.capture', input)).toEqual({ type: 'spotify.capture', fields: {
    phase: 'sample', sessionRef: 1, generation: 2, captureSampleRate: 44100, renderSampleRate: 44100,
    captureChannels: 2, captureBits: 32, capturedFrames: 44100, deliveredFrames: 43800, queuedBytes: 2400,
    queueCapacityBytes: 705600, formatLeaseApplied: true, routeSpotifyOnly: true } });
  expect(getterRead).toBe(false);
});
it('keeps exact fixed error codes and phase, never raw upstream messages', () => {
  const value = projectEvent('spotify.capture', { phase: 'failed', errorCode: 'FORMAT_LEASE_LOCKED',
    message: 'PRIVATE_WINDOWS_PATH', stack: 'PRIVATE_PROCESS' });
  expect(value.fields).toEqual({ phase: 'failed', errorCode: 'FORMAT_LEASE_LOCKED' });
  expect(projectEvent('spotify.capture', { phase: 'failed', errorCode: 'token=private' }).fields).toEqual({ phase: 'failed' });
});
it('retains simultaneous native format and route codes through the helper journal without identities', () => {
  const values = journal();
  const configurationIssueCodes = projectConfigurationIssueCodes({
    issues: ['RENDER_RATE_MISMATCH', 'FOLIA_FEEDBACK_ROUTE', 'ROUTE_IDENTITY_UNAVAILABLE', 'RENDER_RATE_MISMATCH', 'PRIVATE_TOKEN'],
    endpointId: 'PRIVATE_ENDPOINT', processId: 1234, executablePath: 'PRIVATE_PATH' });
  reportCableHelper({ phase: 'result', operation: 'inspect-route', ok: true, configurationIssueCodes,
    configuration: { issues: ['PRIVATE_TOKEN'], sessions: ['PRIVATE_SESSION'] } });
  expect(values).toEqual([{ type: 'spotify.capture-helper', fields: { phase: 'result', operation: 'inspect-route', ok: true,
    configurationIssueCodes: 'FOLIA_FEEDBACK_ROUTE RENDER_RATE_MISMATCH ROUTE_IDENTITY_UNAVAILABLE' } }]);
  expect(JSON.stringify(values)).not.toMatch(/PRIVATE_|endpointId|processId|executablePath|"configuration"/);
});
it('distinguishes observed empty issues from unknown, missing, and oversized lists', () => {
  expect(projectConfigurationIssueCodes({ issues: [] })).toBe('');
  expect(projectConfigurationIssueCodes({})).toBeUndefined();
  expect(projectConfigurationIssueCodes({ issues: ['PRIVATE_UNKNOWN'] })).toBeUndefined();
  expect(projectConfigurationIssueCodes({ issues: ['FOLIA_FEEDBACK_ROUTE', 'PRIVATE_UNKNOWN'] })).toBe('FOLIA_FEEDBACK_ROUTE');
  expect(projectConfigurationIssueCodes({ issues: Array(32).fill('RENDER_RATE_MISMATCH') })).toBe('RENDER_RATE_MISMATCH');
  expect(projectConfigurationIssueCodes({ issues: Array(33).fill('RENDER_RATE_MISMATCH') })).toBeUndefined();
  expect(projectConfigurationIssueCodes({ issues: { 0: 'RENDER_RATE_MISMATCH', length: 1 } })).toBeUndefined();
  for (const value of ['PRIVATE_UNKNOWN', 'FOLIA_FEEDBACK_ROUTE PRIVATE_UNKNOWN', 'RENDER_RATE_MISMATCH FOLIA_FEEDBACK_ROUTE',
    'FOLIA_FEEDBACK_ROUTE FOLIA_FEEDBACK_ROUTE', ['FOLIA_FEEDBACK_ROUTE'], 'FOLIA_FEEDBACK_ROUTE '.repeat(33)]) {
    expect(projectEvent('spotify.capture-helper', { phase: 'result', configurationIssueCodes: value }).fields).toEqual({ phase: 'result' });
  }
});
it('does not invoke configuration, list-element, or helper-field getters', () => {
  let getterRead = false;
  const getter = () => { getterRead = true; throw new Error('PRIVATE_GETTER'); };
  expect(projectConfigurationIssueCodes(Object.defineProperty({}, 'issues', { get: getter }))).toBeUndefined();
  const issues = ['FOLIA_FEEDBACK_ROUTE', 'ignored']; Object.defineProperty(issues, '1', { get: getter });
  expect(projectConfigurationIssueCodes({ issues })).toBe('FOLIA_FEEDBACK_ROUTE');
  const fields = Object.defineProperty({ phase: 'result' }, 'configurationIssueCodes', { get: getter });
  expect(projectEvent('spotify.capture-helper', fields).fields).toEqual({ phase: 'result' });
  const values = journal(); reportCableHelper(fields);
  expect(values[0].fields).toEqual({ phase: 'result' }); expect(getterRead).toBe(false);
});
it('attributes the driver and native helper without exporting paths or claiming source encoding', () => {
  const value = projectBuildInfo({ spotifyPlaybackBackend: 'vb-cable', captureHelperVersion: '0.1.0',
    captureHelperSha256: 'a'.repeat(64), bundledDriverSha256: 'b'.repeat(64), capturePath: 'PRIVATE', driverLicenseUser: 'PRIVATE' });
  expect(value).toEqual({ spotifyPlaybackBackend: 'vb-cable', captureHelperVersion: '0.1.0',
    captureHelperSha256: 'a'.repeat(64), bundledDriverSha256: 'b'.repeat(64) });
});
it('binds the routing binary, fixed private profile and every route module into the runtime build reference', () => {
  const modules = ['ownedRouteHost', 'ownedRouteLifecycle', 'ownedRouteAudio', 'ownedRouteProtocol', 'ownedRouteTrial', 'nativeComponentPath', 'desktopColdBootstrap', 'desktopColdRecovery']
    .map(name => `electron/spotify/${name}.cjs`);
  for (const name of modules) expect(SOURCE_FILES).toContain(name);
  const sourceHashes = Object.fromEntries(modules.map(name => [name, 'a'.repeat(64)]));
  const build: any = { routeHelperVersion: '0.19.0-dev.1', routeHelperSha256: 'b'.repeat(64), routeProductionQualified: false,
    routeValidationProfile: 'folia-r19-owned-route-28000-x64-v1', sourceHashes };
  expect(projectBuildInfo({ ...build, privateToken: 'DROP', routePath: 'DROP' })).toEqual(build);
  const original = buildReference(build);
  for (const key of ['routeHelperVersion', 'routeHelperSha256', 'routeProductionQualified', 'routeValidationProfile']) {
    const changed = { ...build }; delete changed[key]; expect(buildReference(changed)).not.toBe(original);
  }
  for (const name of modules) expect(buildReference({ ...build, sourceHashes: { ...sourceHashes, [name]: 'c'.repeat(64) } })).not.toBe(original);
  expect(projectBuildInfo({ routeProductionQualified: true, routeValidationProfile: 'caller-selected', routeHelperSha256: 'token=private',
    routeHelperVersion: 'C:\\private\\service.exe' })).toEqual({});
});
it('distinguishes active endpoints from unverified installation and omits private selection identity', () => {
  const values = journal();
  reportCableSetup({ state: 'selection-required', code: 'DEVICE_INACTIVE', driverInstalled: true,
    driverInstallerAvailable: true, spotifyRunning: true, selection: { connectDeviceId: 'PRIVATE_DESKTOP',
      captureDeviceId: 'PRIVATE_CAPTURE', renderDeviceId: 'PRIVATE_RENDER' },
    devices: { capture: [{ id: 'PRIVATE_CAPTURE', name: 'PRIVATE_NAME' }], render: [{ id: 'PRIVATE_RENDER' }],
      spotify: [{ id: 'PRIVATE_DESKTOP', isActive: false }] },
    probe: { captureMixSampleRate: 48000, renderMixSampleRate: 48000, channels: 2, temporaryFormatLeaseEligible: true },
    processPath: 'PRIVATE_PATH', token: 'PRIVATE_TOKEN' }, { operation: 'openCablePanel', operationRef: 3 });
  expect(values).toHaveLength(1);
  expect(values[0]).toMatchObject({ type: 'spotify.cable-setup', fields: { operation: 'openCablePanel', operationRef: 3,
    state: 'selection-required', errorCode: 'DEVICE_INACTIVE', captureEndpointCount: 1, renderEndpointCount: 1,
    endpointPairDetected: true, spotifyRunning: true, driverInstallerAvailable: true, connectSelected: true,
    captureSelected: true, renderSelected: true, selectedSpotifyListed: true, selectedSpotifyActive: false,
    captureMixSampleRate: 48000, renderMixSampleRate: 48000, channels: 2, temporaryFormatLeaseEligible: true,
    vendorLaunchAcknowledged: true, installationVerification: 'unknown' } });
  expect(JSON.stringify(values)).not.toMatch(/PRIVATE_|driverInstalled|processPath|deviceId|token/);
});
it('emits one setup detail row for a nested IPC and service call, without claiming a failed launch succeeded', async () => {
  const values = journal(), input = { action: 'playbackSetup', operation: 'openDriver' };
  await observeSpotifyOperation('ipc', input, () => observeSpotifyOperation('service', input, async () => ({
    backend: 'vb-cable', state: 'driver-missing', devices: { capture: [], render: [], spotify: [] } })));
  expect(values.filter(value => value.type === 'spotify.cable-setup')).toHaveLength(1);
  const count = values.length;
  await expect(observeSpotifyOperation('service', input, async () => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'setup-required' }); }))
    .rejects.toThrow('PRIVATE_PATH');
  expect(values.slice(count).some(value => value.type === 'spotify.cable-setup')).toBe(false);
  expect(JSON.stringify(values)).not.toContain('PRIVATE_PATH');
  await observeSpotifyOperation('service', { action: 'playbackSetup', operation: 'status' }, async () => ({ state: 'unconfigured' }));
  expect(values.filter(value => value.type === 'spotify.cable-setup')).toHaveLength(1);
});
it('does not invoke setup getters or accept unsupported verification and helper values', () => {
  const values = journal(); let getterRead = false;
  reportCableSetup({ state: 'failed', get devices() { getterRead = true; throw new Error('PRIVATE_PATH'); },
    get probe() { getterRead = true; throw new Error('PRIVATE_PATH'); } }, { operation: 'status' });
  reportCableHelper({ phase: 'result', operation: 'devices', ok: false, errorCode: 'ENDPOINT_UNAVAILABLE', hresult: -2004287484,
    processPlatform: 'PRIVATE_PLATFORM', processArchitecture: 'PRIVATE_ARCH', protocolMajor: Infinity,
    helperPlatform: 'PRIVATE_PATH', token: 'PRIVATE_TOKEN', captureEndpointCount: 99999,
    get singleCaptureMixSampleRate() { getterRead = true; return 44100; } });
  expect(getterRead).toBe(false);
  expect(values[1]).toEqual({ type: 'spotify.capture-helper', fields: { phase: 'result', operation: 'devices', ok: false,
    errorCode: 'ENDPOINT_UNAVAILABLE', hresult: -2004287484 } });
  expect(projectEvent('spotify.cable-setup', { operation: 'status', installationVerification: 'installed',
    endpointId: 'PRIVATE_ENDPOINT', driverInstalled: true }).fields).toEqual({ operation: 'status' });
  expect(JSON.stringify(values)).not.toContain('PRIVATE_');
});
it('exports bounded separate endpoint and vendor-interface failures without claiming absence or source fidelity', () => {
  const values = journal();
  reportCableHelper({ phase: 'inventory', operation: 'devices', endpointInventoryState: 'failed',
    endpointActiveCount: 1, endpointDisabledCount: 2, endpointNotPresentCount: 0, endpointUnpluggedCount: 0,
    endpointUnreadableCount: 1, endpointHresult: -2147467259, controlInterfaceState: 'failed',
    controlInterfaceCount: 0, controlInterfaceActiveCount: 0, controlInterfaceWin32Error: 5,
    controlInterfaceFailureStage: 'enumerate', driverInstalled: false, sourceLossless: true,
    sourceBitPerfect: true, interfacePath: 'PRIVATE_INTERFACE', message: 'PRIVATE_ERROR' });
  expect(values[0].fields).toMatchObject({ endpointInventoryState: 'failed', endpointActiveCount: 1,
    endpointDisabledCount: 2, endpointUnreadableCount: 1, endpointHresult: -2147467259,
    controlInterfaceState: 'failed', controlInterfaceCount: 0, controlInterfaceActiveCount: 0,
    controlInterfaceWin32Error: 5, controlInterfaceFailureStage: 'enumerate' });
  expect(JSON.stringify(values)).not.toMatch(/PRIVATE_|driverInstalled|sourceLossless|sourceBitPerfect/);
  expect(projectEvent('spotify.capture-helper', { phase: 'inventory', endpointInventoryState: 'PRIVATE_STATE',
    endpointActiveCount: 257, endpointHresult: Infinity, controlInterfaceCount: 65,
    controlInterfaceActiveCount: -1, controlInterfaceWin32Error: -1,
    controlInterfaceFailureStage: 'PRIVATE_PATH' }).fields).toEqual({ phase: 'inventory' });
});
it('records only the fixed official transfer endpoint and status, never its saved target or body', () => {
  expect(projectEvent('spotify.http', { endpoint: 'playback-transfer', method: 'PUT', httpStatus: 204,
    deviceId: 'PRIVATE_SAVED_TARGET', body: { device_ids: ['PRIVATE_SAVED_TARGET'], play: false },
    url: 'PRIVATE_URL', token: 'PRIVATE_TOKEN' })).toEqual({ type: 'spotify.http', fields: {
      endpoint: 'playback-transfer', method: 'PUT', httpStatus: 204 } });
});

it('preserves the fixed cleanup-uncertainty code without accepting lookalikes or private errors', () => {
  const { failure } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
  expect(failure('CAPTURE_HELPER_EXIT_UNCONFIRMED').code).toBe('CAPTURE_HELPER_EXIT_UNCONFIRMED');
  expect(failure('CAPTURE_HELPER_EXIT_UNCONFIRMED: PRIVATE').code).toBe('CAPTURE_REQUEST_FAILED');
  expect(projectEvent('spotify.capture-helper', { phase: 'failed', operation: 'close', ok: false,
    errorCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED', message: 'PRIVATE', pid: 123, killed: true, exitCode: 0 }).fields)
    .toEqual({ phase: 'failed', operation: 'close', ok: false, errorCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED' });
  expect(projectEvent('spotify.capture-helper', { phase: 'failed', operation: 'close',
    errorCode: 'CAPTURE_HELPER_EXIT_UNCONFIRMED: PRIVATE' }).fields).toEqual({ phase: 'failed', operation: 'close' });
});

it('keeps the native Base-owner rejection fixed while dropping lookalikes, owner data and accessor values', () => {
  const { failure } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
  const { diagnosticCode, publicError } = require('../../../electron/spotify/cableAudioFacts.cjs');
  const values = journal(); let getterRead = false;
  const error = failure('BASE_CABLE_ENDPOINT_REQUIRED');
  expect(diagnosticCode(error)).toBe('BASE_CABLE_ENDPOINT_REQUIRED');
  expect(publicError(error)).toMatchObject({ code: 'setup-required', message: 'Spotify: cable-configuration-required' });
  reportCableHelper({ phase: 'result', operation: 'capture-open', ok: false, errorCode: error.code,
    ownerInstanceId: 'PRIVATE_OWNER', message: 'PRIVATE_ERROR', get hresult() { getterRead = true; return 123; } });
  expect(values[0]).toEqual({ type: 'spotify.capture-helper', fields: { phase: 'result', operation: 'capture-open',
    ok: false, errorCode: 'BASE_CABLE_ENDPOINT_REQUIRED' } });
  reportCableHelper({ phase: 'result', operation: 'capture-open', ok: false,
    errorCode: 'BASE_CABLE_ENDPOINT_REQUIRED: PRIVATE_OWNER' });
  expect(values[1].fields.errorCode).toBe('UNKNOWN');
  reportCableHelper({ phase: 'result', operation: 'capture-open', ok: false,
    get errorCode() { getterRead = true; return 'BASE_CABLE_ENDPOINT_REQUIRED'; },
    get ownerInstanceId() { getterRead = true; return 'PRIVATE_OWNER'; } });
  expect(values[2].fields).toEqual({ phase: 'result', operation: 'capture-open', ok: false });
  expect(failure('BASE_CABLE_ENDPOINT_REQUIRED: PRIVATE_OWNER').code).toBe('CAPTURE_REQUEST_FAILED');
  expect(getterRead).toBe(false); expect(JSON.stringify(values)).not.toMatch(/PRIVATE_|ownerInstanceId|hresult/);
});

it('records saved confirmations separately from observed 44100 Hz endpoints without inferring internal rate', () => {
  const values = journal();
  reportCableSetup({ state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED',
    selection: { internal44100Confirmed: false, spotifyOnlyConfirmed: true, defaultsConfirmed: false },
    probe: { captureMixSampleRate: 44100, renderMixSampleRate: 44100, channels: 2, routeVerified: true } }, { operation: 'status' });
  expect(values[0].fields).toMatchObject({ errorCode: 'CABLE_CONFIRMATION_REQUIRED',
    internal44100Confirmed: false, spotifyOnlyConfirmed: true, defaultsConfirmed: false,
    captureMixSampleRate: 44100, renderMixSampleRate: 44100, routeVerified: true, installationVerification: 'unknown' });
  expect(values[0].fields).not.toHaveProperty('internalSampleRate');
  reportCableSetup({ state: 'routing-required', code: 'ROUTE_OBSERVATION_FAILED',
    probe: { captureMixSampleRate: 44100, renderMixSampleRate: 44100, routeVerified: false } }, { operation: 'status' });
  expect(values[1].fields).toMatchObject({ errorCode: 'ROUTE_OBSERVATION_FAILED', routeVerified: false });
  expect(values[1].fields).not.toHaveProperty('internal44100Confirmed');
  expect(values[1].fields).not.toHaveProperty('spotifyOnlyConfirmed');
  expect(values[1].fields).not.toHaveProperty('defaultsConfirmed');
});
it('does not invoke confirmation getters or accept truthy non-boolean confirmation claims', () => {
  const values = journal(); let getterRead = false;
  reportCableSetup({ state: 'routing-required', selection: {
    get internal44100Confirmed() { getterRead = true; return true; }, spotifyOnlyConfirmed: 'true', defaultsConfirmed: 1,
  } }, { operation: 'status' });
  expect(getterRead).toBe(false);
  for (const key of ['internal44100Confirmed', 'spotifyOnlyConfirmed', 'defaultsConfirmed']) expect(values[0].fields).not.toHaveProperty(key);
});
