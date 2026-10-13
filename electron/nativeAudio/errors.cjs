// electron/nativeAudio/errors.cjs — stable public codes; private bilingual diagnostics.
const CODES = new Set(['HQPLAYER_CONFIRM_EXISTING', 'HQPLAYER_MULTIPLE_INSTANCES', 'STRICT_DECODE_FAILED', 'HQPLAYER_SETTINGS_FAILED', 'HQPLAYER_PATH_INVALID', 'HQPLAYER_UNAVAILABLE', 'HQPLAYER_CONTROL_UNAVAILABLE', 'HQPLAYER_COMMAND_REJECTED', 'HQPLAYER_SOURCE_REJECTED', 'COMPONENT_CRASHED', 'COMPONENT_TIMEOUT', 'COMPONENT_UNAVAILABLE',
    'COMPONENT_INTEGRITY', 'COMPONENT_INCOMPATIBLE', 'COMPONENT_UPDATE_FAILED', 'ROLLBACK_UNAVAILABLE',
    'HQPLAYER_RAW_FORMAT_UNVERIFIED', 'SOURCE_RESTORE_UNCONFIRMED', 'SOURCE_UNAVAILABLE', 'SOURCE_EXPIRED', 'SOURCE_TOO_LARGE', 'DECODE_FAILED',
    'DEVICE_UNAVAILABLE', 'HELPER_RESTART_REQUIRED', 'FORMAT_LEASE_READBACK_MISMATCH', 'FORMAT_UNSUPPORTED', 'INVALID_REQUEST', 'CANCELLED', 'NATIVE_REQUEST_FAILED']);
function audioError(code, detail) {
    const error = new Error(detail || code);
    error.code = CODES.has(code) ? code : 'NATIVE_REQUEST_FAILED';
    return error;
}
function errorCode(error) { return ['FORMAT_LEASE_READBACK_MISMATCH', 'HELPER_RESTART_REQUIRED'].includes(error?.nativeCode) ? error.nativeCode
    : CODES.has(error?.code) ? error.code : 'NATIVE_REQUEST_FAILED'; }
function sourceLifecycleError(error) {
    if (['FORMAT_LEASE_READBACK_MISMATCH', 'HELPER_RESTART_REQUIRED'].includes(error?.nativeCode)) return audioError(error.nativeCode);
    // A replaced Spotify reader is a cancelled command, not a source outage.
    if (error?.message === 'Spotify: request-cancelled') return audioError('CANCELLED');
    if (['ROUTE_RESTORE_UNCONFIRMED', 'ROUTE_SOURCE_PAUSE_UNCONFIRMED', 'ROUTE_HELPER_EXIT_UNCONFIRMED'].includes(error?.code)
        || error?.message === 'Spotify: automatic-route-restore-unconfirmed') return audioError('SOURCE_RESTORE_UNCONFIRMED');
    if (CODES.has(error?.code)) return error;
    return audioError('SOURCE_UNAVAILABLE');
}
function diagnostic(error) {
    const detail = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[URL omitted]')
        .replace(/(cookie|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
    console.error(`[原生音频错误 / Native audio error] ${errorCode(error)}: ${detail}`);
}
module.exports = { audioError, errorCode, diagnostic, sourceLifecycleError };
