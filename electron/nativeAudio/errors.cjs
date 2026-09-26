// electron/nativeAudio/errors.cjs — stable public codes; private bilingual diagnostics.
const CODES = new Set(['COMPONENT_CRASHED', 'COMPONENT_TIMEOUT', 'COMPONENT_UNAVAILABLE',
    'COMPONENT_INTEGRITY', 'COMPONENT_INCOMPATIBLE', 'COMPONENT_UPDATE_FAILED', 'ROLLBACK_UNAVAILABLE',
    'SOURCE_UNAVAILABLE', 'SOURCE_EXPIRED', 'SOURCE_TOO_LARGE', 'DECODE_FAILED',
    'DEVICE_UNAVAILABLE', 'FORMAT_UNSUPPORTED', 'INVALID_REQUEST', 'CANCELLED', 'NATIVE_REQUEST_FAILED']);
function audioError(code, detail) {
    const error = new Error(detail || code);
    error.code = CODES.has(code) ? code : 'NATIVE_REQUEST_FAILED';
    return error;
}
function errorCode(error) { return CODES.has(error?.code) ? error.code : 'NATIVE_REQUEST_FAILED'; }
function diagnostic(error) {
    const detail = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[URL omitted]')
        .replace(/(cookie|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
    console.error(`[原生音频错误 / Native audio error] ${errorCode(error)}: ${detail}`);
}
module.exports = { audioError, errorCode, diagnostic };
