'use strict';

// electron/spotify/cableCaptureProtocol.cjs: fixed capture contract and sanitized main-process failures.
const RATE = 44100, FRAME_BYTES = 8, QUEUE_BYTES = RATE * FRAME_BYTES * 2;
// One fixed main/native contract: a 75-second proof deadline plus the normal two-second packet margin.
const BOOTSTRAP_TIMEOUT_MS = 75000, BOOTSTRAP_QUEUE_BYTES = RATE * FRAME_BYTES * 77;
const BOOTSTRAP_HOST_BYTES = BOOTSTRAP_QUEUE_BYTES + QUEUE_BYTES;
const BOOTSTRAP_CAPABILITY = 'bounded-bootstrap-buffer-v1';
const START_PROOF_CAPABILITY = 'post-start-route-proof-v1';
const CODES = new Set(['PROCESS_CAPTURE_UNSUPPORTED', 'CANCELLED', 'CAPTURE_UNSUPPORTED_PLATFORM', 'CAPTURE_HELPER_UNAVAILABLE',
  'CAPTURE_HELPER_CLOSED', 'CAPTURE_HELPER_EXIT_UNCONFIRMED', 'CAPTURE_CONTROL_TIMEOUT', 'CAPTURE_CONTROL_BUSY', 'CAPTURE_PROTOCOL_INVALID',
  'CAPTURE_CONFIGURATION_REQUIRED', 'CAPTURE_PIPE_TIMEOUT', 'CAPTURE_PIPE_FAILED', 'CAPTURE_PIPE_CLOSED',
  'CAPTURE_FRAME_INVALID', 'CAPTURE_OVERFLOW', 'CAPTURE_READER_USED', 'CAPTURE_READ_PENDING',
  'CAPTURE_REQUEST_FAILED', 'CAPTURE_CLOSED', 'CAPTURE_START_TIMEOUT', 'CAPTURE_STOP_TIMEOUT',
  'CAPTURE_INITIALIZE_TIMEOUT', 'CAPTURE_BOOTSTRAP_TIMEOUT', 'CAPTURE_DEVICE_FAILED', 'PROCESS_LIMIT',
  'CAPTURE_PIPE_NOT_CONNECTED', 'CAPTURE_FORMAT_CHANGED', 'CAPTURE_FORMAT_UNSUPPORTED',
  'CAPTURE_FORMAT_INVALID', 'CAPTURE_RATE_MISMATCH', 'CAPTURE_CHANNELS_MISMATCH',
  'CAPTURE_CHANNEL_LAYOUT_UNSUPPORTED', 'CAPTURE_DEVICE_BUFFER_TOO_LARGE', 'CAPTURE_PACKET_TOO_LARGE',
  'CAPTURE_PACKET_INVALID', 'CAPTURE_TIMESTAMP_ERROR', 'CAPTURE_DISCONTINUITY', 'CAPTURE_SAMPLE_NONFINITE',
  'CAPTURE_PADDING_NONZERO', 'CAPTURE_BUFFER_INVALID', 'BASE_CABLE_ENDPOINT_REQUIRED',
  'RENDER_RATE_MISMATCH', 'RENDER_CHANNELS_MISMATCH', 'ENDPOINT_UNAVAILABLE', 'CABLE_IS_DEFAULT_RENDER',
  'FOLIA_FEEDBACK_ROUTE', 'CABLE_SHARED_WITH_OTHER_AUDIO', 'ROUTE_IDENTITY_UNAVAILABLE',
  'SPOTIFY_ROUTE_NOT_FOUND', 'ROUTE_SESSION_LIMIT', 'ROUTE_OBSERVATION_FAILED', 'STALE_GENERATION',
  'HELPER_RESTART_REQUIRED', 'PROTOCOL_INCOMPATIBLE', 'INVALID_REQUEST', 'FORMAT_LEASE_LOCKED', 'FORMAT_LEASE_UNSUPPORTED',
  'FORMAT_LEASE_FAILED', 'FORMAT_LEASE_PERIOD_INVALID', 'FORMAT_LEASE_READBACK_MISMATCH', 'FORMAT_LEASE_READBACK_FAILED',
  'FORMAT_LEASE_ENDPOINT_MISMATCH', 'FORMAT_LEASE_CLOSED', 'FORMAT_LEASE_IDENTITY_UNAVAILABLE', 'FORMAT_LEASE_IDENTITY_LIMIT',
  'CAPTURE_SEEK_INVALID', 'CAPTURE_SEEK_EXPIRED', 'CAPTURE_SEEK_IDENTITY_CHANGED', 'CAPTURE_SEEK_NOT_PLAYING',
  'CAPTURE_POSITION_EPOCH_INVALID', 'CAPTURE_POSITION_SOURCE_ACTIVE',
  'CAPTURE_BUSY', 'SPOTIFY_PROCESS_CHANGED', 'SPOTIFY_PROCESS_AMBIGUOUS']);
const failure = code => {
  const safe = CODES.has(code) ? code : 'CAPTURE_REQUEST_FAILED';
  return Object.assign(new Error(safe), { code: safe });
};
const endpointId = id => typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
const sessionId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
// Internal own-child evidence, never renderer input or a PID-wide writer exemption.
function requireOwnedSilentRenderLease(value, { session, generation, renderDeviceId, processId } = {}) {
  const names = ['captureSession', 'captureGeneration', 'endpointId', 'sessionInstanceId', 'groupingId', 'processId', 'startedAtUtcTicks'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length
    || Object.keys(value).some(name => !names.includes(name))) throw failure('CAPTURE_PROTOCOL_INVALID');
  const copy = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure('CAPTURE_PROTOCOL_INVALID');
    copy[name] = descriptor.value;
  }
  if (!sessionId(copy.captureSession) || copy.captureSession !== session
    || !Number.isSafeInteger(copy.captureGeneration) || copy.captureGeneration < 1 || copy.captureGeneration !== generation
    || !endpointId(copy.endpointId) || copy.endpointId !== renderDeviceId
    || typeof copy.sessionInstanceId !== 'string' || !copy.sessionInstanceId.length || copy.sessionInstanceId.length > 4096
    || /[\u0000-\u001f\u007f]/.test(copy.sessionInstanceId)
    || !sessionId(copy.groupingId) || copy.groupingId === '00000000-0000-0000-0000-000000000000'
    || !Number.isInteger(processId) || processId < 1 || processId > 2147483647 || copy.processId !== processId
    || typeof copy.startedAtUtcTicks !== 'string' || !/^[1-9][0-9]{0,18}$/.test(copy.startedAtUtcTicks)
    || BigInt(copy.startedAtUtcTicks) > 3155378975999999999n) throw failure('CAPTURE_PROTOCOL_INVALID');
  return Object.freeze(copy);
}
function selectionFields(value) {
  if (!endpointId(value?.captureDeviceId) || !endpointId(value?.renderDeviceId)
    || value.captureDeviceId === value.renderDeviceId
    || value.outputDeviceId != null && !endpointId(value.outputDeviceId)
    || value.temporaryFormatLease != null && typeof value.temporaryFormatLease !== 'boolean'
    || value.bootstrapMode != null && value.bootstrapMode !== 'paused-source'
    || value.bootstrapDelivery != null && !['discard', 'buffer'].includes(value.bootstrapDelivery)) throw failure('CAPTURE_CONFIGURATION_REQUIRED');
  if (value.outputDeviceId === value.renderDeviceId) throw failure('FOLIA_FEEDBACK_ROUTE');
  if (value.expectedSpotifyProcessId != null || value.expectedSpotifyStartedAtUnixMs != null) {
    if (!Number.isInteger(value.expectedSpotifyProcessId) || value.expectedSpotifyProcessId < 1 || value.expectedSpotifyProcessId > 2147483647
      || !Number.isSafeInteger(value.expectedSpotifyStartedAtUnixMs) || value.expectedSpotifyStartedAtUnixMs < 1)
      throw failure('CAPTURE_CONFIGURATION_REQUIRED');
  }
  if (value.bootstrapMode === 'paused-source' && (!['discard', 'buffer'].includes(value.bootstrapDelivery)
    || value.expectedSpotifyProcessId == null || typeof value.expectedSpotifyStartTimeUtcTicks !== 'string'
    || !/^[1-9][0-9]{0,18}$/.test(value.expectedSpotifyStartTimeUtcTicks))) throw failure('CAPTURE_CONFIGURATION_REQUIRED');
  return { captureDeviceId: value.captureDeviceId, renderDeviceId: value.renderDeviceId,
    ...(value.outputDeviceId != null ? { outputDeviceId: value.outputDeviceId } : {}),
    ...(value.temporaryFormatLease === true ? { temporaryFormatLease: true } : {}),
    ...(value.expectedSpotifyProcessId != null ? { expectedSpotifyProcessId: value.expectedSpotifyProcessId,
      expectedSpotifyStartedAtUnixMs: value.expectedSpotifyStartedAtUnixMs } : {}),
    ...(value.bootstrapMode === 'paused-source' ? { bootstrapMode: value.bootstrapMode, bootstrapDelivery: value.bootstrapDelivery,
      expectedSpotifyStartTimeUtcTicks: value.expectedSpotifyStartTimeUtcTicks } : {}) };
}
function processBinding(configuration) {
  if (!Array.isArray(configuration?.sessions) || configuration.sessions.length > 256) throw failure('ROUTE_IDENTITY_UNAVAILABLE');
  const candidates = new Map();
  for (const value of configuration.sessions) {
    if (value?.state === 'expired' || value?.identityReadable !== true || value?.processName?.toLowerCase?.() !== 'spotify'
      || typeof value.executablePath !== 'string' || value.executablePath.length > 32768
      || value.executablePath.replaceAll('\\', '/').split('/').at(-1).toLowerCase() !== 'spotify.exe') continue;
    if (!Number.isInteger(value.processId) || value.processId < 1 || value.processId > 2147483647
      || !Number.isSafeInteger(value.startedAtUnixMs) || value.startedAtUnixMs < 1) throw failure('ROUTE_IDENTITY_UNAVAILABLE');
    candidates.set(`${value.processId}:${value.startedAtUnixMs}:${value.executablePath.toLowerCase()}`, value);
  }
  if (!candidates.size) throw failure('SPOTIFY_ROUTE_NOT_FOUND');
  if (candidates.size !== 1) throw failure('SPOTIFY_PROCESS_AMBIGUOUS');
  const value = [...candidates.values()][0];
  return { expectedSpotifyProcessId: value.processId, expectedSpotifyStartedAtUnixMs: value.startedAtUnixMs };
}
function requireConfiguration(value, selection) {
  if (value?.ready !== true) throw failure('CAPTURE_CONFIGURATION_REQUIRED');
  if (!Array.isArray(value.issues) || value.issues.length || value.sampleRateConversion !== false
    || value.selectedSampleRate !== RATE || value.selectedChannels !== 2 || value.preparedFormat !== 's32le'
    || value.route?.ready !== true || value.route.spotifyOnlyObserved !== true || value.route.spotifySessionPresent !== true)
    throw failure('CAPTURE_PROTOCOL_INVALID');
  for (const [key, flow, id] of [['capture', 'capture', selection.captureDeviceId], ['render', 'render', selection.renderDeviceId]]) {
    const endpoint = value[key];
    if (endpoint?.id !== id || endpoint.flow !== flow || endpoint.supportedBaseCable !== true
      || endpoint.mixFormat?.sampleRate !== RATE || endpoint.mixFormat.channels !== 2) throw failure('CAPTURE_PROTOCOL_INVALID');
  }
  return value;
}
function requireBootstrapConfiguration(value, selection) {
  if (value?.bootstrapReady !== true || !Array.isArray(value.issues) || value.issues.length > 1
    || value.issues.some(code => code !== 'SPOTIFY_ROUTE_NOT_FOUND') || value.sampleRateConversion !== false
    || value.selectedSampleRate !== RATE || value.selectedChannels !== 2 || value.preparedFormat !== 's32le')
    throw failure('CAPTURE_PROTOCOL_INVALID');
  for (const [key, flow, id] of [['capture', 'capture', selection.captureDeviceId], ['render', 'render', selection.renderDeviceId]]) {
    const endpoint = value[key];
    if (endpoint?.id !== id || endpoint.flow !== flow || endpoint.supportedBaseCable !== true
      || endpoint.mixFormat?.sampleRate !== RATE || endpoint.mixFormat.channels !== 2) throw failure('CAPTURE_PROTOCOL_INVALID');
  }
  if (value.ready === true) requireConfiguration(value, selection);
  else if (value.issues.length !== 1 || value.route?.spotifySessionPresent !== false) throw failure('CAPTURE_PROTOCOL_INVALID');
  return value;
}
function requireSnapshot(value, record, state, expectedDelivery) {
  if (value?.state === 'configuration-required') throw failure(value.errorCode || 'CAPTURE_CONFIGURATION_REQUIRED');
  if (value?.errorCode != null) throw failure(value.errorCode);
  if (value?.session !== record.session || value.generation !== record.generation || value.pipeName !== record.pipeName
    || value.state !== state || value.sampleRate !== RATE || value.channels !== 2 || value.bitDepth !== 32
    || value.sampleFormat !== 's32le' || value.sampleRateConversion !== false
    || value.actualMixFormat?.sampleRate !== RATE || value.actualMixFormat.channels !== 2
    || state === 'running' && (value.pipeConnected !== true || value.startValidated !== true)) throw failure('CAPTURE_PROTOCOL_INVALID');
  const epoch = record.positionEpoch;
  if (epoch ? value.positionEpoch?.positionIntentId !== epoch.positionIntentId || value.positionEpoch?.cutSequence !== epoch.cutSequence
    : value.positionEpoch != null) throw failure('CAPTURE_PROTOCOL_INVALID');
  // A cut receipt starts a new observed counter epoch. Keep the previous
  // snapshot intact; only compare counters that belong to the same epoch.
  const previousFrames = epoch && record.state?.positionEpoch?.cutSequence !== epoch.cutSequence
    ? epoch.capturedFramesAtCut : record.state?.capturedFrames;
  const buffered = record.selection.bootstrapMode === 'paused-source' && record.selection.bootstrapDelivery === 'buffer';
  if (!buffered && value.queueCapacityBytes !== QUEUE_BYTES) throw failure('CAPTURE_PROTOCOL_INVALID');
  if (buffered) {
    if (value.bootstrapTimeoutMs !== BOOTSTRAP_TIMEOUT_MS || value.bootstrapQueueCapacityBytes !== BOOTSTRAP_QUEUE_BYTES
      || !Number.isSafeInteger(value.queueCapacityBytes) || value.queueCapacityBytes < QUEUE_BYTES
      || value.queueCapacityBytes > BOOTSTRAP_HOST_BYTES || value.queueCapacityBytes % FRAME_BYTES)
      throw failure('CAPTURE_PROTOCOL_INVALID');
    const live = expectedDelivery === 'live' || record.promoted;
    if (live ? !Number.isSafeInteger(value.bootstrapPrefixFrames) || value.bootstrapPrefixFrames < 0
      || value.bootstrapPrefixFrames * FRAME_BYTES > BOOTSTRAP_QUEUE_BYTES
      || value.bootstrapPrefixFrames > value.capturedFrames
      || value.queueCapacityBytes > value.bootstrapPrefixFrames * FRAME_BYTES + QUEUE_BYTES
      : value.bootstrapPrefixFrames !== null || value.queueCapacityBytes !== BOOTSTRAP_QUEUE_BYTES)
      throw failure('CAPTURE_PROTOCOL_INVALID');
    if (record.promoted && value.bootstrapPrefixFrames !== record.state?.bootstrapPrefixFrames)
      throw failure('CAPTURE_PROTOCOL_INVALID');
  }
  if (record.selection.bootstrapMode === 'paused-source') {
    const delivery = expectedDelivery || (record.promoted ? 'live' : record.selection.bootstrapDelivery === 'discard' ? 'discarding' : 'buffering');
    if (value.bootstrapMode !== 'paused-source' || value.bootstrapDelivery !== record.selection.bootstrapDelivery
      || value.deliveryState !== delivery || value.spotifyProcess?.startedAtUtcTicks !== record.selection.expectedSpotifyStartTimeUtcTicks
      || !Number.isSafeInteger(value.capturedFrames) || value.capturedFrames < 0
      || Number.isSafeInteger(previousFrames) && value.capturedFrames < previousFrames
      || !Number.isSafeInteger(value.queuedBytes) || value.queuedBytes < 0 || value.queuedBytes > value.queueCapacityBytes)
      throw failure('CAPTURE_PROTOCOL_INVALID');
    if (delivery !== 'live' && (value.deliveredFrames !== 0 || delivery === 'discarding' && value.queuedBytes !== 0))
      throw failure('CAPTURE_PROTOCOL_INVALID');
    if (delivery === 'live') requireConfiguration(value.configuration, record.selection);
    else requireBootstrapConfiguration(value.configuration, record.selection);
  } else requireConfiguration(value.configuration, record.selection);
  if (record.selection.expectedSpotifyProcessId != null && (value.spotifyProcess?.processId !== record.selection.expectedSpotifyProcessId
    || value.spotifyProcess?.startedAtUnixMs !== record.selection.expectedSpotifyStartedAtUnixMs)) throw failure('SPOTIFY_PROCESS_CHANGED');
  if (record.selection.temporaryFormatLease === true && (value.configuration.formatLease?.state !== 'held'
    || value.configuration.formatLease.verified !== true || value.configuration.formatLease.persistentSettingsChanged !== false))
    throw failure('CAPTURE_PROTOCOL_INVALID');
  return value;
}
module.exports = { RATE, FRAME_BYTES, QUEUE_BYTES, BOOTSTRAP_TIMEOUT_MS, BOOTSTRAP_QUEUE_BYTES, BOOTSTRAP_HOST_BYTES, BOOTSTRAP_CAPABILITY, START_PROOF_CAPABILITY, failure, endpointId, sessionId, selectionFields, processBinding,
  requireConfiguration, requireBootstrapConfiguration, requireSnapshot, requireOwnedSilentRenderLease };
