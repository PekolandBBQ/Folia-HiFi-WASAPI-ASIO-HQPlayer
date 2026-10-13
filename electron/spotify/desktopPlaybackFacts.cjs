'use strict';

// electron/spotify/desktopPlaybackFacts.cjs: validate public Spotify control facts, never infer local process ownership.
const fail = code => Object.assign(new Error(code), { code });
const errorCodes = new Set(['DESKTOP_SOURCE_UNQUALIFIED', 'SOURCE_EFFECT_UNKNOWN', 'SOURCE_OPERATION_UNSUPPORTED', 'SOURCE_OBSERVATION_STALE', 'AUTH_REQUIRED', 'SCOPES_UNKNOWN', 'SCOPE_REQUIRED', 'SESSION_CHANGED',
  'DEVICE_NOT_SELECTED', 'DEVICE_NOT_LISTED', 'DEVICE_NOT_COMPUTER', 'DEVICE_RESTRICTED', 'DUPLICATE_DEVICE_ID',
  'DEVICE_ID_MISMATCH', 'DEVICE_INACTIVE', 'PLAYBACK_UNAVAILABLE', 'TRACK_NOT_CURRENT', 'STALE_SESSION',
  'CANCELLED', 'SUPERSEDED', 'CLOSED', 'API_FORBIDDEN', 'RATE_LIMITED', 'API_UNAVAILABLE', 'CONTROL_TIMEOUT',
  'PREPARATION_READ_DEFERRED', 'CONTROL_REJECTED', 'PLAYBACK_STATE_UNCONFIRMED', 'SEEK_UNCONFIRMED', 'PROTOCOL_INVALID', 'ROUTE_SOURCE_PAUSE_UNCONFIRMED', 'BOOTSTRAP_VOLUME_UNAVAILABLE',
  'BOOTSTRAP_VOLUME_UNCONFIRMED', 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED', 'BOOTSTRAP_IDENTITY_UNCONFIRMED',
  'PREPARED_TARGET_ACTIVITY_UNSUPPORTED', 'PREPARED_TARGET_ACTIVITY_INVALID_STATE',
  'PREPARED_TARGET_ACTIVITY_EXPIRED', 'PREPARED_TARGET_ACTIVITY_REQUIRED', 'SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET',
  'SESSION_OBSERVATION_UNTRUSTED', 'PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED', 'EXTERNAL_POLICY_CONFLICT', 'SPOTIFY_INSTANCE_CHANGED', 'BASE_OTHER_WRITER_PRESENT']);
const failureCode = error => error?.name === 'AbortError' ? 'CANCELLED' : error?.name === 'TimeoutError' ? 'CONTROL_TIMEOUT'
  : errorCodes.has(error?.code) ? error.code : 'API_UNAVAILABLE';
const validDeviceId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);
const validTrackId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const validSessionId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const sameStamp = (a, b) => Number.isSafeInteger(a?.epoch) && Number.isSafeInteger(a?.revision)
  && a.epoch === b?.epoch && a.revision === b?.revision;
const position = (value, duration) => Number.isSafeInteger(value) && value >= 0 && value < duration;

function normalizeDevices(body) {
  if (!Array.isArray(body?.devices) || body.devices.length > 256) throw fail('PROTOCOL_INVALID');
  const seen = new Set();
  return body.devices.map(device => {
    if (!device || typeof device !== 'object') throw fail('PROTOCOL_INVALID');
    if (device.id != null && !validDeviceId(device.id)) throw fail('PROTOCOL_INVALID');
    if (device.id != null && seen.has(device.id)) throw fail('DUPLICATE_DEVICE_ID');
    if (device.id != null) seen.add(device.id);
    const type = typeof device.type === 'string' ? device.type.toLowerCase() : '';
    return { id: device.id ?? null,
      name: typeof device.name === 'string' ? device.name.slice(0, 256) : '', type,
      isActive: device.is_active === true, restricted: device.is_restricted !== false,
      selectable: validDeviceId(device.id) && type === 'computer' && device.is_restricted === false };
  });
}

function requireDevice(body, deviceId) {
  if (!validDeviceId(deviceId)) throw fail('DEVICE_NOT_SELECTED');
  const device = normalizeDevices(body).find(candidate => candidate.id === deviceId);
  if (!device) throw fail('DEVICE_NOT_LISTED');
  if (device.restricted) throw fail('DEVICE_RESTRICTED');
  if (!device.selectable) throw fail('DEVICE_NOT_COMPUTER');
  // Recovery needs an observed inactive flag, not an absent/malformed value
  // normalized to false for display in the device list.
  if (typeof body.devices.find(candidate => candidate.id === deviceId).is_active !== 'boolean') throw fail('PROTOCOL_INVALID');
  return device;
}

function playbackFacts(body, expected, { matchTrack = true, allowInactive = false, now = Date.now } = {}) {
  if (!body) throw fail('PLAYBACK_UNAVAILABLE');
  if (!validDeviceId(body.device?.id) || body.device.id !== expected.deviceId) throw fail('DEVICE_ID_MISMATCH');
  // Only the muted bootstrap's read-only baseline may describe an inactive,
  // explicitly non-playing exact target. It is never source-pause/route proof.
  if (body.device.is_active !== true && !(allowInactive && !matchTrack
    && body.device.is_active === false && body.is_playing === false)) throw fail('DEVICE_INACTIVE');
  if (body.device.is_restricted !== false) throw fail('DEVICE_RESTRICTED');
  if (typeof body.is_playing !== 'boolean') throw fail('PROTOCOL_INVALID');
  const track = body.item;
  if (matchTrack && (body.currently_playing_type && body.currently_playing_type !== 'track'
    || track?.type !== 'track' || track.uri !== `spotify:track:${expected.trackId}`)) throw fail('TRACK_NOT_CURRENT');
  // A final track may remain selected and paused exactly at its duration.
  // This is cleanup evidence only; command positions still use strict position().
  const endedPaused = body.is_playing === false && Number.isSafeInteger(expected.durationMs)
    && body.progress_ms === expected.durationMs;
  if (matchTrack && ((!position(body.progress_ms, expected.durationMs) && !endedPaused)
    || !Number.isSafeInteger(track.duration_ms) || Math.abs(track.duration_ms - expected.durationMs) > 1000)) throw fail('PROTOCOL_INVALID');
  const disallows = body.actions?.disallows;
  const observedTrackId = typeof track?.uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(track.uri) ? track.uri.slice(14) : null;
  return { deviceId: expected.deviceId, trackId: matchTrack ? expected.trackId : observedTrackId,
    positionMs: matchTrack ? body.progress_ms : 0, durationMs: expected.durationMs,
    isPlaying: body.is_playing, observedAt: now(),
    ...(allowInactive ? { isActive: body.device.is_active } : {}),
    ...(Number.isSafeInteger(body.timestamp) && body.timestamp >= 0 ? { serverTimestamp: body.timestamp } : {}),
    disallows: { pausing: disallows?.pausing === true, resuming: disallows?.resuming === true, seeking: disallows?.seeking === true } };
}

module.exports = { fail, failureCode, validDeviceId, validTrackId, validSessionId, sameStamp, position,
  normalizeDevices, requireDevice, playbackFacts };
