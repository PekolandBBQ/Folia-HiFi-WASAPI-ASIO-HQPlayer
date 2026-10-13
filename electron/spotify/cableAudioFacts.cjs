'use strict';
const { spotifyError } = require('./errors.cjs');
const { failure: captureFailure } = require('./cableCaptureProtocol.cjs');
const { CODES: ROUTE_CODES } = require('./ownedRouteProtocol.cjs');

// electron/spotify/cableAudioFacts.cjs: catalog identity and safe public error mapping for desktop capture.
const fail = code => Object.assign(new Error(code), { code });
const validTrack = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const position = (value, duration) => Number.isSafeInteger(value) && value >= 0 && value < duration;
const sameStamp = (a, b) => Number.isSafeInteger(a?.epoch) && Number.isSafeInteger(a?.revision)
  && a.epoch === b?.epoch && a.revision === b?.revision;
function metadataFacts(value, requested) {
  if (!value || value.type !== 'track' || !validTrack(value.id) || value.uri !== `spotify:track:${value.id}`
    || value.id !== requested && (value.linked_from?.id !== requested || value.linked_from?.uri !== `spotify:track:${requested}`
      || value.linked_from?.type !== 'track')) throw fail('METADATA_INVALID');
  if (!Number.isSafeInteger(value.duration_ms) || value.duration_ms < 1 || value.duration_ms > 3600000) throw fail('METADATA_INVALID');
  if (value.is_playable === false) throw fail('TRACK_UNAVAILABLE');
  return { trackId: value.id, durationMs: value.duration_ms };
}
function requireFacts(value, record, playing) {
  if (value?.deviceId !== record.selection.deviceId) throw fail('DEVICE_ID_MISMATCH');
  if (value.trackId !== record.resolvedTrackId) throw fail('TRACK_NOT_CURRENT');
  const endedPaused = playing === false && value.positionMs === record.durationMs;
  if (value.durationMs !== record.durationMs || !position(value.positionMs, record.durationMs) && !endedPaused
    || value.isPlaying !== playing) throw fail('PLAYBACK_STATE_UNCONFIRMED');
  return value;
}
const CONTROL_CODES = new Set(['AUTH_REQUIRED', 'SCOPES_UNKNOWN', 'SCOPE_REQUIRED', 'SESSION_CHANGED',
  'DEVICE_NOT_SELECTED', 'DEVICE_NOT_LISTED', 'DEVICE_NOT_COMPUTER', 'DEVICE_RESTRICTED', 'DUPLICATE_DEVICE_ID',
  'DEVICE_ID_MISMATCH', 'DEVICE_INACTIVE', 'PLAYBACK_UNAVAILABLE', 'TRACK_NOT_CURRENT', 'STALE_SESSION',
  'CANCELLED', 'SUPERSEDED', 'CLOSED', 'API_FORBIDDEN', 'RATE_LIMITED', 'API_UNAVAILABLE', 'CONTROL_TIMEOUT',
  'CONTROL_REJECTED', 'PLAYBACK_STATE_UNCONFIRMED', 'SEEK_UNCONFIRMED', 'PROTOCOL_INVALID',
  'BOOTSTRAP_VOLUME_UNAVAILABLE', 'BOOTSTRAP_VOLUME_UNCONFIRMED', 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED', 'BOOTSTRAP_IDENTITY_UNCONFIRMED']);
const diagnosticCode = error => error?.code === 'setup-required' || CONTROL_CODES.has(error?.code) || ROUTE_CODES.has(error?.code)
  ? error.code : captureFailure(error?.code).code;
function publicError(error) {
  const code = error?.code;
  if (code === 'HELPER_RESTART_REQUIRED') return Object.assign(spotifyError('unavailable', 'cable-capture-restart-required'), { nativeCode: code });
  if (code === 'FORMAT_LEASE_READBACK_MISMATCH') return Object.assign(spotifyError('setup-required', 'cable-format-changed'), { nativeCode: code });
  if (code === 'BOOTSTRAP_VOLUME_UNAVAILABLE') return spotifyError('unsupported', 'spotify-cold-volume-unavailable');
  if (code === 'BOOTSTRAP_VOLUME_UNCONFIRMED') return spotifyError('unavailable', 'spotify-cold-volume-unconfirmed');
  if (code === 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED') return spotifyError('setup-required', 'spotify-cold-volume-recovery-required');
  if (code === 'BOOTSTRAP_IDENTITY_UNCONFIRMED') return spotifyError('unavailable', 'spotify-cold-identity-unconfirmed');
  if (code === 'ROUTE_TRIAL_PLATFORM_MISMATCH') return spotifyError('unsupported', 'automatic-route-platform-unsupported');
  if (code === 'SPOTIFY_AUDIO_PROCESS_AMBIGUOUS') return spotifyError('setup-required', 'spotify-audio-process-ambiguous');
  if (code === 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN') return spotifyError('setup-required', 'spotify-audio-process-unproven');
  if (ROUTE_CODES.has(code) && (code.startsWith('JOURNAL_') || code.startsWith('PRODUCT_JOURNAL_')))
    return spotifyError('setup-required', 'automatic-route-storage-unavailable');
  if (['ORIGINAL_POLICY_UNSAFE', 'ORIGINAL_POLICY_VALUES_INVALID', 'ORIGINAL_POLICY_ENDPOINT_UNRESOLVED',
    'ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS', 'ORIGINAL_ENDPOINT_UNSAFE', 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN',
    'ORIGINAL_EXPLICIT_ENDPOINT_CHANGED', 'NON_BASE_DEFAULT_OUTPUT_REQUIRED', 'ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN',
    'INSPECTED_ORIGINALS_CHANGED', 'POLICY_CHANGED_BEFORE_APPLY', 'EXTERNAL_POLICY_CONFLICT', 'COMMUNICATIONS_POLICY_CHANGED'].includes(code))
    return spotifyError('setup-required', 'spotify-original-route-unsafe');
  if (['ROUTE_HELPER_UNAVAILABLE', 'ROUTE_HELPER_UNQUALIFIED', 'NATIVE_PRODUCT_ADAPTER_UNQUALIFIED', 'ROUTE_COMPONENT_INVALID'].includes(code))
    return spotifyError('setup-required', 'automatic-route-unavailable');
  if (code === 'ROUTE_SOURCE_DEFAULT_REQUIRED') return spotifyError('setup-required', 'spotify-output-default-required');
  if (['ROUTE_RESTORE_UNCONFIRMED', 'ROUTE_HELPER_EXIT_UNCONFIRMED', 'ROUTE_SOURCE_PAUSE_UNCONFIRMED'].includes(code))
    return spotifyError('unavailable', 'automatic-route-restore-unconfirmed');
  if (code === 'setup-required') {
    const reason = ['cable-setup-required', 'cable-format-required', 'cable-setup-busy', 'spotify-cold-volume-recovery-required']
      .find(value => error?.message === 'Spotify: ' + value);
    return spotifyError('setup-required', reason || 'cable-configuration-required');
  }
  if (['CANCELLED', 'STALE_SESSION', 'STALE_GENERATION', 'SUPERSEDED', 'CLOSED'].includes(code)) return spotifyError('unavailable', 'request-cancelled');
  if (['AUTH_REQUIRED', 'SESSION_CHANGED'].includes(code)) return spotifyError('auth-required', code === 'SESSION_CHANGED' ? 'session-changed' : 'auth-required');
  if (['SCOPES_UNKNOWN', 'SCOPE_REQUIRED'].includes(code)) return spotifyError('auth-required', 'playback-scope-required');
  if (['TRACK_NOT_CURRENT', 'DEVICE_ID_MISMATCH', 'DEVICE_INACTIVE', 'SPOTIFY_PROCESS_CHANGED'].includes(code))
    return spotifyError('unavailable', 'external-playback-change');
  if (code === 'RATE_LIMITED') return spotifyError('unavailable', 'rate-limited');
  if (code === 'TRACK_UNAVAILABLE') return spotifyError('not-playable', 'track-unavailable');
  if (['METADATA_INVALID', 'INVALID_AUDIO_REQUEST', 'INVALID_POSITION'].includes(code)) return spotifyError('invalid-response',
    code === 'INVALID_POSITION' ? 'invalid-position' : code === 'INVALID_AUDIO_REQUEST' ? 'invalid-audio-request' : 'track-metadata-mismatch');
  if (['CAPTURE_CONFIGURATION_REQUIRED', 'CAPTURE_UNSUPPORTED_PLATFORM', 'CAPTURE_HELPER_UNAVAILABLE',
    'DEVICE_NOT_SELECTED', 'DEVICE_NOT_LISTED', 'DEVICE_NOT_COMPUTER', 'DEVICE_RESTRICTED', 'DUPLICATE_DEVICE_ID',
    'BASE_CABLE_ENDPOINT_REQUIRED', 'RENDER_RATE_MISMATCH', 'RENDER_CHANNELS_MISMATCH', 'ENDPOINT_UNAVAILABLE',
    'CAPTURE_RATE_MISMATCH', 'CAPTURE_CHANNELS_MISMATCH', 'CAPTURE_FORMAT_UNSUPPORTED', 'CAPTURE_FORMAT_CHANGED',
    'CAPTURE_CHANNEL_LAYOUT_UNSUPPORTED', 'CABLE_IS_DEFAULT_RENDER', 'FOLIA_FEEDBACK_ROUTE',
    'CABLE_SHARED_WITH_OTHER_AUDIO', 'ROUTE_IDENTITY_UNAVAILABLE', 'SPOTIFY_ROUTE_NOT_FOUND', 'FORMAT_LEASE_LOCKED',
    'FORMAT_LEASE_UNSUPPORTED', 'FORMAT_LEASE_FAILED', 'FORMAT_LEASE_PERIOD_INVALID', 'FORMAT_LEASE_READBACK_MISMATCH',
    'FORMAT_LEASE_READBACK_FAILED', 'FORMAT_LEASE_ENDPOINT_MISMATCH', 'FORMAT_LEASE_CLOSED',
    'FORMAT_LEASE_IDENTITY_UNAVAILABLE', 'FORMAT_LEASE_IDENTITY_LIMIT', 'SPOTIFY_PROCESS_AMBIGUOUS'].includes(code))
    return spotifyError('setup-required', 'cable-configuration-required');
  if (code === 'API_FORBIDDEN') return spotifyError('unsupported', 'playback-forbidden');
  if (code === 'CAPTURE_BOOTSTRAP_TIMEOUT') return spotifyError('unavailable', 'cable-capture-bootstrap-timeout');
  if (code === 'CAPTURE_OVERFLOW') return spotifyError('unavailable', 'cable-capture-overflow');
  if (['PLAYBACK_STATE_UNCONFIRMED', 'SEEK_UNCONFIRMED', 'CONTROL_REJECTED'].includes(code)) return spotifyError('unavailable', 'cable-playback-unconfirmed');
  return spotifyError('unavailable', 'cable-preparation-failed');
}
module.exports = { fail, validTrack, position, sameStamp, metadataFacts, requireFacts, publicError, diagnosticCode };
