'use strict';
const { sessionId } = require('./cableCaptureProtocol.cjs');
const { VALIDATION_PROFILE, COMPATIBILITY_PROFILE } = require('./ownedRouteTrial.cjs');

// electron/spotify/ownedRouteProtocol.cjs: narrow, fail-closed contract for the owned Windows routing service.
const NATIVE_FAILURE_CODES = Object.freeze([
  'APP_ROUTE_WINDOWS_UNSUPPORTED', 'APP_ROUTE_X64_REQUIRED', 'APP_ROUTE_INTERFACE_UNAVAILABLE', 'APP_ROUTE_READ_UNAVAILABLE',
  'ORIGINAL_POLICY_PROOF_REQUIRED', 'RECOVERY_ORIGINAL_BINDING_REQUIRED', 'WINDOWS_PRODUCT_JOURNAL_REQUIRED',
  'NATIVE_PRODUCT_ADAPTER_UNQUALIFIED', 'PRODUCT_DISCOVERY_UNQUALIFIED', 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN',
  'SPOTIFY_AUDIO_PROCESS_AMBIGUOUS', 'SPOTIFY_DISCOVERY_TIMEOUT', 'COMPLETE_SPOTIFY_DISCOVERY_REQUIRED',
  'SPOTIFY_INSTANCE_CHANGED', 'SPOTIFY_CANDIDATE_SET_CHANGED', 'ORIGINAL_POLICY_VALUES_INVALID',
  'ORIGINAL_POLICY_ENDPOINT_UNRESOLVED', 'ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS', 'ORIGINAL_ENDPOINT_UNSAFE',
  'ORIGINAL_PHYSICAL_OWNER_UNPROVEN', 'ORIGINAL_EXPLICIT_ENDPOINT_CHANGED', 'NON_BASE_DEFAULT_OUTPUT_REQUIRED',
  'ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN', 'INSPECTED_ORIGINALS_CHANGED', 'POLICY_CHANGED_BEFORE_APPLY',
  'EXTERNAL_POLICY_CONFLICT', 'COMMUNICATIONS_POLICY_CHANGED', 'EXACT_BASE_PAIR_REQUIRED',
  'EXACT_BASE_CAPTURE_RENDER_OWNER_MISMATCH', 'BASE_PAIR_CHANGED', 'BASE_OTHER_WRITER_PRESENT',
  'SOURCE_PAUSE_CONFIRMATION_REQUIRED', 'SOURCE_NOT_PAUSED', 'SOURCE_TRACK_CHANGED',
  'SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH', 'SOURCE_RESUMED_DURING_PAUSE_PROOF', 'PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED',
  'PCM_STOP_NOT_CONFIRMED', 'SOURCE_BROKER_UNAVAILABLE', 'SOURCE_BROKER_FAILED',
  'EMPTY_PLAYER_RESTORE_SCOPE_INVALID', 'EMPTY_PLAYER_NATIVE_PROOF_REQUIRED',
  'EMPTY_PLAYER_NATIVE_QUIESCENCE_UNCONFIRMED', 'EMPTY_PLAYER_NATIVE_QUIESCENCE_EXPIRED',
  'SOURCE_STATUS_REQUIRED', 'SOURCE_PAUSE_NOT_CONFIRMED', 'SOURCE_PAUSE_DEVICE_MISMATCH',
  'RECOVERY_PLAYBACK_OWNERSHIP_UNCONFIRMED', 'PRODUCT_CONTROL_AUTHORITY_LOST', 'PRODUCT_PARENT_APPLY_AUTHORITY_LOST',
  'SUPERVISOR_CANCELLED', 'APPLY_READBACK_MISMATCH', 'RESTORE_READBACK_MISMATCH',
  'SESSION_OBSERVATION_UNTRUSTED', 'JOURNAL_COMMIT_FAILED_NO_MORE_POLICY_WRITES', 'PRODUCT_PREPARED_ACK_MISMATCH',
  'PREPARED_RETAIN_ACK_INVALID', 'JOURNAL_STORAGE_IDENTITY_UNSAFE', 'PRODUCT_JOURNAL_PARENT_VOLUME_CHANGED',
  'PRODUCT_JOURNAL_EXISTING_ROOT_UNREACHABLE', 'PRODUCT_JOURNAL_FIXED_LOCAL_ROOT_REQUIRED', 'PRODUCT_JOURNAL_PARENT_REQUIRED',
  'PRODUCT_JOURNAL_PARENT_OPEN_FAILED', 'PRODUCT_JOURNAL_ROOT_CREATE_FAILED', 'PRODUCT_JOURNAL_CREATED_HANDLE_REQUIRED',
  'JOURNAL_SECURITY_CHANGED', 'PRODUCT_OPERATION_FAILED',
  'OWNED_SILENT_RENDER_LEASE_INVALID', 'OWNED_SILENT_RENDER_LEASE_LOST',
  'OWNED_SILENT_RENDER_LEASE_UNSUPPORTED', 'OWNED_SILENT_RENDER_LEASE_ALREADY_BOUND',
  'RESTORE_OBSERVATION_INVALID', 'RESTORE_OBSERVATION_CHANGED', 'RESTORE_OBSERVATION_REPLAYED',
  'PREPARATION_OBSERVATION_INVALID', 'PREPARATION_OBSERVATION_REPLAYED',
  'PREPARATION_OBSERVATION_CHANGED_DURING_SCAN', 'PREPARATION_OBSERVATION_FORBIDDEN',
  'PREPARED_SELECTION_UNSUPPORTED', 'PREPARED_SELECTION_INVALID_STATE',
  'PREPARED_SELECTION_PROOF_REQUIRED', 'PREPARED_SELECTION_IN_PROGRESS',
  'PREPARED_TARGET_ACTIVITY_UNSUPPORTED', 'PREPARED_TARGET_ACTIVITY_INVALID_STATE', 'PREPARED_TARGET_ACTIVITY_EXPIRED',
  'PREPARED_TARGET_ACTIVITY_REQUIRED', 'SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET',
  'PAUSED_PROOF_TRANSFER_INVALID', 'PAUSED_PROOF_TRANSFER_EXPIRED', 'PAUSED_PROOF_TRANSFER_SUPERSEDED', 'PAUSED_PROOF_TRANSFER_UNSUPPORTED',
  'SEEK_PARK_UNSUPPORTED', 'SEEK_PARK_STATE_INVALID', 'SEEK_PARK_TOKEN_INVALID', 'SEEK_PARK_EXPIRED',
  'SEEK_PARK_RECEIPT_INVALID', 'SEEK_PARK_EVIDENCE_REQUIRED',
  'PAUSED_ROUTE_STATE_INVALID', 'PAUSED_ROUTE_UNSUPPORTED', 'CAPTURE_INTERVAL_EPOCH_MISMATCH',
  'SOURCE_EPOCH_MISMATCH', 'CAPTURE_INTERVAL_NOT_STOPPED', 'ROUTE_OBSERVER_STOP_UNCONFIRMED', 'OWNED_SILENT_RENDER_LEASE_NOT_STOPPED',
]);
const CODES = new Set([...NATIVE_FAILURE_CODES, 'ROUTE_HELPER_UNAVAILABLE', 'ROUTE_COMPONENT_INVALID', 'ROUTE_HELPER_UNQUALIFIED',
  'ROUTE_PROTOCOL_INVALID', 'ROUTE_CONTROL_TIMEOUT', 'ROUTE_HELPER_CLOSED', 'ROUTE_HELPER_EXIT_UNCONFIRMED', 'ROUTE_HELPER_ABNORMAL_EXIT',
  'ROUTE_RESTORE_UNCONFIRMED', 'ROUTE_SOURCE_DEFAULT_REQUIRED', 'ROUTE_PROOF_UNCONFIRMED', 'ROUTE_LEASE_LOST',
  'ROUTE_BUSY', 'ROUTE_SOURCE_PAUSE_UNCONFIRMED', 'ROUTE_TRIAL_OPT_IN_REQUIRED', 'ROUTE_TRIAL_PLATFORM_MISMATCH',
  'NO_POLICY_WRITES', 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN', 'SPOTIFY_AUDIO_PROCESS_AMBIGUOUS', 'SOURCE_DEFAULT_POLICY_REQUIRED', 'ORIGINAL_POLICY_UNSAFE',
  'ORIGINAL_POLICY_VALUES_INVALID', 'ORIGINAL_POLICY_ENDPOINT_UNRESOLVED', 'ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS',
  'ORIGINAL_ENDPOINT_UNSAFE', 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN', 'ORIGINAL_EXPLICIT_ENDPOINT_CHANGED',
  'NON_BASE_DEFAULT_OUTPUT_REQUIRED', 'ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN',
  'CANCELLED', 'SPOTIFY_PROCESS_CHANGED', 'NATIVE_PRODUCT_ADAPTER_UNQUALIFIED']);
const failure = code => Object.assign(new Error(CODES.has(code) ? code : 'ROUTE_PROOF_UNCONFIRMED'),
  { code: CODES.has(code) ? code : 'ROUTE_PROOF_UNCONFIRMED' });
// Persisted policy strings are raw ABI values, not MMDevice endpoint IDs. Native verifies their mapping.
const rawPolicyValue = value => value === null || typeof value === 'string' && value.length > 0
  && value.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(value);
// Failure evidence is independent of routing authority. Native identities and
// arbitrary exception/property text are never copied into the project journal.
const OWNER_DIAGNOSTIC_ENUMS = Object.freeze({
  stage: 'topology-enumerator topology-endpoint topology-activate topology-connector-count topology-connector topology-connected topology-adapter-id topology-adapter topology-properties topology-instance-id topology-release owner-locate owner-device-id owner-class-guid owner-hardware-ids owner-service owner-status owner-enumerator owner-bus-type owner-parent owner-identity owner-repeat'.split(' '),
  reason: 'api-failed unavailable wrong-type malformed out-of-bounds disconnected ambiguous unsupported virtual mismatch cycle depth-limit not-started has-problem changed release-failed'.split(' '),
  originalKind: ['default', 'explicit'],
  property: ['class-guid', 'hardware-ids', 'service', 'enumerator', 'bus-type', 'device-id'],
  bus: ['usb', 'hdaudio', 'pci', 'vendor', 'virtual', 'unknown'],
});
function physicalOwnerDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  try {
    for (const [key, allowed] of Object.entries(OWNER_DIAGNOSTIC_ENUMS)) {
      const field = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (typeof field === 'string' && allowed.includes(field)) result[key] = field;
    }
    if (!result.stage || !result.reason) return undefined;
    for (const [key, minimum, maximum] of [['role', 0, 1], ['depth', 0, 3],
      ['nativeResult', 0, 4294967295], ['hresult', -2147483648, 2147483647],
      ['propertyType', 0, 4294967295], ['propertyLength', 0, 4096]]) {
      const field = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (Number.isSafeInteger(field) && field >= minimum && field <= maximum) result[key] = field;
    }
    return result;
  } catch { return undefined; }
}
// Transport/startup categories are evidence only. Never widen restore authority
// or copy exception text from the native helper into project diagnostics.
const OPERATION_DIAGNOSTIC_STAGES = Object.freeze(['worker-start', 'inspect-request']);
const OPERATION_DIAGNOSTIC_CAUSES = Object.freeze([
  'unknown', 'request-cancelled', 'worker-start-failed', 'worker-image-invalid', 'worker-identity-unconfirmed',
  'worker-image-mismatch', 'worker-process-identity-changed', 'worker-sid-unavailable',
  'worker-unavailable', 'worker-eof', 'worker-protocol-invalid', 'worker-stderr-limit',
  'journal-context-unavailable', 'journal-root-unavailable', 'journal-root-unsafe', 'journal-security-rejected',
  'access-denied', 'io-failed', 'invalid-data', 'json-invalid', 'object-disposed', 'platform-unsupported', 'win32-failed',
]);
function operationFailureDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    if (Object.keys(value).some(key => !['stage', 'cause'].includes(key))) return undefined;
    const stage = Object.getOwnPropertyDescriptor(value, 'stage')?.value;
    const cause = Object.getOwnPropertyDescriptor(value, 'cause')?.value;
    if (!OPERATION_DIAGNOSTIC_STAGES.includes(stage) || !OPERATION_DIAGNOSTIC_CAUSES.includes(cause)) return undefined;
    return { stage, cause };
  } catch { return undefined; }
}
function qualified(value, { allowTrial = false } = {}) {
  const admitted = value?.productionQualified === true && value.supported === true
    || value?.runtimeCompatible === true && value.supported === true && value.canOperate === true
      && value.implementationAvailable === true && value.compatibilityProfile === COMPATIBILITY_PROFILE
    || allowTrial && value?.productionQualified === false && value.trialAuthorized === true
      && value.validationProfile === VALIDATION_PROFILE && value.implementationAvailable === true && value.canOperate === true;
  return value?.protocolMajor === 1 && value.componentVersion === '0.19.0-dev.27' && value.platform === 'win32-x64' && value.contract === 'folia-owned-route-v1'
    && admitted
    && value.heldPausedAcquire === true && value.completeSessionProof === true
    && value.notificationCoherent === true && value.retainedJournalRecovery === true && value.intervalIsolation === true
    && value.providerRouteLifetime === true && value.boundedSeekPark === true && value.boundedPausedProofTransfer === true && value.indefiniteHeldPause === true && value.freshResumeInterval === true
    && value.ownedSilentRenderLease === true && value.preparedSelection === true && value.preparedTargetActivity === true && value.boundedPreparationObservation === true && value.boundedRestoreObservation === true
    && Array.isArray(value.blockers) && value.blockers.length === 0
    && Array.isArray(value.operations)
    && ['hello', 'inspect', 'validateHeld', 'acquire', 'rebindPreparedSelection', 'authorizePreparedSelection', 'verifyPreparedTargetActive', 'completePreparedSelection', 'suspendPaused', 'resumePreparation', 'seekPark', 'seekResumePreparation', 'seekCancelToPaused', 'armCaptureInterval', 'authorizeResume', 'status', 'heartbeat', 'release', 'close'].every(name => value.operations.includes(name));
}
function identity(value) {
  if (!Number.isInteger(value?.pid) || value.pid < 1 || value.pid > 2147483647
    || typeof value.startTimeUtcTicks !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.startTimeUtcTicks)
    || !Number.isSafeInteger(value.startedAtUnixMs) || value.startedAtUnixMs < 1) throw failure('ROUTE_PROTOCOL_INVALID');
  return { expectedSpotifyProcessId: value.pid, expectedSpotifyStartTimeUtcTicks: value.startTimeUtcTicks,
    expectedSpotifyStartedAtUnixMs: value.startedAtUnixMs };
}
function preflight(value, selection) {
  if (!selection || value?.captureDeviceId !== selection.captureDeviceId || value?.renderDeviceId !== selection.renderDeviceId)
    throw failure('ROUTE_PROTOCOL_INVALID');
  if (!Array.isArray(value.originalRoles) || value.originalRoles.length !== 2
    || value.originalRoles.some((entry, index) => entry?.role !== index || !rawPolicyValue(entry.original)))
    throw failure('ROUTE_PROTOCOL_INVALID');
  if (value.originalPolicySafe !== true) throw failure('ORIGINAL_POLICY_UNSAFE');
  if (value.sourceOutputDefault !== value.originalRoles.every(entry => entry.original === null)) throw failure('ROUTE_PROTOCOL_INVALID');
  if (value.baseCableVerified !== true || value.noOtherWriters !== true)
    throw failure('ROUTE_PROOF_UNCONFIRMED');
  return { ...identity(value.process), expectedOriginalRoles: value.originalRoles.map(entry => ({ ...entry })) };
}
function requireLease(value, expected, state) {
  const lease = value?.lease;
  if (!sessionId(expected.session) || !Number.isSafeInteger(expected.generation) || expected.generation < 1
    || !lease || lease.session !== expected.session || lease.generation !== expected.generation
    || typeof lease.leaseId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(lease.leaseId)
    || expected.leaseId && lease.leaseId !== expected.leaseId || lease.state !== state
    || lease.captureDeviceId !== expected.selection.captureDeviceId || lease.renderDeviceId !== expected.selection.renderDeviceId
    || !Array.isArray(lease.originalRoles) || lease.originalRoles.length !== 2
    || lease.originalRoles.some((entry, index) => entry?.role !== index || !rawPolicyValue(entry.original)))
    throw failure('ROUTE_PROTOCOL_INVALID');
  if (expected.originalRoles && JSON.stringify(lease.originalRoles) !== JSON.stringify(expected.originalRoles))
    throw failure('ROUTE_PROTOCOL_INVALID');
  const binding = identity(lease.process);
  if (expected.binding && (binding.expectedSpotifyProcessId !== expected.binding.expectedSpotifyProcessId
    || binding.expectedSpotifyStartTimeUtcTicks !== expected.binding.expectedSpotifyStartTimeUtcTicks))
    throw failure('SPOTIFY_PROCESS_CHANGED');
  return lease;
}
module.exports = { CODES, NATIVE_FAILURE_CODES, failure, rawPolicyValue, qualified, identity, preflight, requireLease,
  physicalOwnerDiagnostic, operationFailureDiagnostic };



