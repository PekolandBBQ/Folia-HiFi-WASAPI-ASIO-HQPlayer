'use strict';
// Trusted IPC boundary for explicit playback setup. All paths and launch
// options are main-owned; only a private key value may come from the form.
const KEY_PAGE = 'https://developer.spotify.com/dashboard/soloist';
const OPERATIONS = new Set(['status', 'saveKey', 'start', 'stop', 'keyPage']);
const fail = () => Object.assign(new Error('Spotify: invalid-playback-setup'), { code: 'invalid-response' });
function createSoloistSetupHandler({ appliance, openExternal, revokePlayback = async () => {} }) {
    if (!appliance || !['publicStatus', 'saveKey', 'startSetup', 'stopSetup'].every(key => typeof appliance[key] === 'function')
        || typeof openExternal !== 'function' || typeof revokePlayback !== 'function') throw fail();
    return async (input, onProgress) => {
        if (!input || input.action !== 'playbackSetup' || !OPERATIONS.has(input.operation)
            || Object.keys(input).some(key => !['action', 'operation', 'keyValue', 'requestId'].includes(key))
            || input.requestId != null && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId))
            || input.operation !== 'saveKey' && input.keyValue != null) throw fail();
        if (input.operation === 'keyPage') { await openExternal(KEY_PAGE); return appliance.publicStatus(); }
        if (input.operation === 'status') return appliance.publicStatus();
        if (input.operation === 'saveKey') {
            if (typeof input.keyValue !== 'string' || !/^spak_[A-Za-z0-9]{20,128}$/.test(input.keyValue)) throw fail();
            try { await revokePlayback(); } catch (error) {
                try { await appliance.stopSetup(); } catch { /* Preserve the first cleanup failure. */ }
                throw error;
            }
            return appliance.saveKey(input.keyValue);
        }
        if (input.operation === 'stop') {
            let failure;
            try { await revokePlayback(); } catch (error) { failure = error; }
            try { await appliance.stopSetup(); } catch (error) { failure ||= error; }
            if (failure) throw failure;
            return appliance.publicStatus();
        }
        return appliance.startSetup({ onProgress: value => onProgress?.({
            stage: value.stage === 'official-download' ? 'download' : value.stage === 'sdk-installing' ? 'validate' : 'connect',
            ...(Number.isFinite(value.loaded) ? { loaded: value.loaded } : {}),
            ...(Number.isFinite(value.total) && value.total > 0 ? { total: value.total } : {}) }) });
    };
}
module.exports = { createSoloistSetupHandler, KEY_PAGE };
