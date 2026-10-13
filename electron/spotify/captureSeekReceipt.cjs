'use strict';
const { sessionId } = require('./cableCaptureProtocol.cjs');
const { failure } = require('./ownedRouteProtocol.cjs');

// Private main-process evidence. It is never accepted from renderer input or
// reconstructed from requested fields; the capture host returned the exact ACK.
function captureSeekReceipt(value, { session, generation, seekTransaction } = {}) {
  const boundary = value?.resetBoundary;
  if (value?.state !== 'seek-parked' || value.session !== session || !sessionId(session)
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || generation != null && value.generation !== generation
    || !sessionId(value.seekTransaction) || seekTransaction != null && value.seekTransaction !== seekTransaction
    || !sessionId(value.seekToken) || value.expiresInMs !== 5000 || value.captureStopped !== true
    || value.captureReset !== true || value.oldGenerationRetired !== true || value.retainedInitialized !== true
    || value.formatLeaseReleased !== false || boundary?.previousSession !== session || boundary.previousGeneration !== value.generation
    || !Number.isSafeInteger(boundary.resetSequence) || boundary.resetSequence < 1
    || !Number.isSafeInteger(boundary.stoppedAndResetAtUnixMs) || boundary.stoppedAndResetAtUnixMs <= 0)
    throw failure('ROUTE_PROTOCOL_INVALID');
  return Object.freeze({ ...value, resetBoundary: Object.freeze({ ...boundary }) });
}
module.exports = { captureSeekReceipt };
