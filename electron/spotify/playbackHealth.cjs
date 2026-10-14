'use strict';
const { failureDetails } = require('./failureDetails.cjs');
// Runtime observation is separate from installed/configured/connected status; no probe starts playback.
let state = { state: 'untested' };
function failed(error, operation) {
 if (['CANCELLED','SUPERSEDED','STALE_SESSION'].includes(error?.nativeCode || error?.code) || error?.message === 'Spotify: request-cancelled') return;
 state = { state: 'failed', ...failureDetails(error, operation), at: Date.now() };
}
module.exports = { get: () => ({ ...state }), failed, prepared: () => { state = { state: 'prepared', at: Date.now() }; } };
