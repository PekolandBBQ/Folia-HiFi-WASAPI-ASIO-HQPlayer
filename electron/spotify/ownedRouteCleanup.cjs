'use strict';
const { failure, requireLease } = require('./ownedRouteProtocol.cjs');

// Only an authenticated, exact pre-restore native receipt may make cleanup retryable.
const retryable = new WeakSet();
function retainedCleanupFailure(receipt, record) {
  if (!receipt || receipt.state !== 'recoveryRequired' || receipt.cleanupRetryable !== true
    || receipt.restoreWritesStarted !== false || !['PCM_STOP_NOT_CONFIRMED', 'SOURCE_NOT_PAUSED',
      'SOURCE_BROKER_UNAVAILABLE', 'SOURCE_BROKER_FAILED', 'EMPTY_PLAYER_NATIVE_QUIESCENCE_UNCONFIRMED',
      'EMPTY_PLAYER_NATIVE_QUIESCENCE_EXPIRED'].includes(receipt.code)
    || !['heldPaused', 'active'].includes(receipt.lease?.state)) return null;
  try { requireLease(receipt, record, receipt.lease.state); } catch { return null; }
  const error = failure('ROUTE_RESTORE_UNCONFIRMED'); retryable.add(error); return error;
}
const isRetryableRouteCleanup = error => error instanceof Error && retryable.has(error);
module.exports = { retainedCleanupFailure, isRetryableRouteCleanup };
