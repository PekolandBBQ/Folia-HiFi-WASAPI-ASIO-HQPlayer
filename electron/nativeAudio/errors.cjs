// electron/nativeAudio/errors.cjs — stable public codes; private bilingual diagnostics.
const CODES = new Set(['PROCESS_CAPTURE_UNSUPPORTED', 'SYSTEM_OUTPUT_PHYSICAL_UNAVAILABLE', 'SYSTEM_OUTPUT_SELECTION_CHANGED', 'SYSTEM_OUTPUT_READBACK_FAILED', 'SYSTEM_OUTPUT_CHANGE_FAILED', 'CABLE_IS_DEFAULT_RENDER', 'SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET', 'STALE_SESSION', 'FORMAT_LEASE_LOCKED', 'FOLIA_FEEDBACK_ROUTE', 'CABLE_SHARED_WITH_OTHER_AUDIO', 'ROUTE_OBSERVATION_FAILED', 'BOOTSTRAP_IDENTITY_UNCONFIRMED', 'CONTROL_TIMEOUT', 'SOURCE_EFFECT_UNKNOWN', 'HQPLAYER_CONFIRM_EXISTING', 'HQPLAYER_MULTIPLE_INSTANCES', 'STRICT_DECODE_FAILED', 'HQPLAYER_SETTINGS_FAILED', 'HQPLAYER_PATH_INVALID', 'HQPLAYER_UNAVAILABLE', 'HQPLAYER_CONTROL_UNAVAILABLE', 'HQPLAYER_COMMAND_REJECTED', 'HQPLAYER_SOURCE_REJECTED', 'COMPONENT_CRASHED', 'COMPONENT_TIMEOUT', 'COMPONENT_UNAVAILABLE',
    'COMPONENT_INTEGRITY', 'COMPONENT_INCOMPATIBLE', 'COMPONENT_UPDATE_FAILED', 'ROLLBACK_UNAVAILABLE',
    'HQPLAYER_RAW_FORMAT_UNVERIFIED', 'SOURCE_RESTORE_UNCONFIRMED', 'SOURCE_UNAVAILABLE', 'SOURCE_EXPIRED', 'SOURCE_TOO_LARGE', 'DECODE_FAILED',
    'DEVICE_UNAVAILABLE', 'HELPER_RESTART_REQUIRED', 'FORMAT_LEASE_READBACK_MISMATCH', 'FORMAT_UNSUPPORTED', 'INVALID_REQUEST', 'CANCELLED', 'NATIVE_REQUEST_FAILED']);
function audioError(code, detail) {
    const error = new Error(detail || code);
    error.code = CODES.has(code) ? code : 'NATIVE_REQUEST_FAILED';
    return error;
}
function errorCode(error) { return CODES.has(error?.nativeCode) ? error.nativeCode
    : CODES.has(error?.code) ? error.code : 'NATIVE_REQUEST_FAILED'; }
function sourceLifecycleError(error) {
    const project = code => {
        const result = audioError(code);
        // Keep bounded diagnostic fields across each source/output boundary. Never copy a raw message into IPC.
        for (const key of ['nativeCode', 'failureCode'])
            if (typeof error?.[key] === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(error[key])) result[key] = error[key];
        if (typeof error?.stage === 'string' && /^[a-z0-9-]{1,64}$/.test(error.stage)) result.stage = error.stage;
        result.cause = error;
        result.sourceFailure = true;
        return result;
    };
    // A replaced Spotify reader is a cancelled command, not a source outage.
    if (error?.message === 'Spotify: request-cancelled') return audioError('CANCELLED');
    if (['ROUTE_RESTORE_UNCONFIRMED', 'ROUTE_SOURCE_PAUSE_UNCONFIRMED', 'ROUTE_HELPER_EXIT_UNCONFIRMED'].includes(error?.code)
        || error?.message === 'Spotify: automatic-route-restore-unconfirmed') return project('SOURCE_RESTORE_UNCONFIRMED');
    if (CODES.has(error?.nativeCode)) return project(error.nativeCode);
    if (CODES.has(error?.code)) return error;
    return project('SOURCE_UNAVAILABLE');
}
function diagnostic(error) {
    const detail = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[URL omitted]')
        .replace(/(cookie|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
    const fields = [error?.nativeCode, error?.failureCode, error?.stage].filter(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value));
    console.error(`[原生音频错误 / Native audio error] ${errorCode(error)}${fields.length ? ` [${fields.join(' / ')}]` : ''}: ${detail}`);
}
module.exports = { audioError, errorCode, diagnostic, sourceLifecycleError };
