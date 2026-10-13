const { audioError } = require('./errors.cjs');

// electron/nativeAudio/livePcmPrebuffer.cjs — strict IPC and per-generation validation.
const DEFAULT_LIVE_PCM_PREBUFFER_MS = 350;
function validateLivePcmPrebufferMs(value = DEFAULT_LIVE_PCM_PREBUFFER_MS) {
    if (!Number.isInteger(value) || value < 25 || value > 1000)
        throw audioError('INVALID_REQUEST', 'Live PCM prebuffer must be an integer from 25 to 1000 ms');
    return value;
}
module.exports = { DEFAULT_LIVE_PCM_PREBUFFER_MS, validateLivePcmPrebufferMs };
