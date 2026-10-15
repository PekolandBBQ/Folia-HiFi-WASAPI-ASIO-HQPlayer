'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const recoveryContext = new AsyncLocalStorage();

// Retry observations, or an entire preparation which first retires its old owner.
// Never replay an arbitrary Play/Seek/route-write inside a failed transaction.
const transient = new Set([
  'PLAYBACK_STATE_UNCONFIRMED', 'SEEK_UNCONFIRMED', 'CONTROL_TIMEOUT', 'API_UNAVAILABLE',
  'SOURCE_EFFECT_UNKNOWN', 'SOURCE_OBSERVATION_STALE', 'SOURCE_BROKER_UNAVAILABLE', 'SOURCE_BROKER_FAILED',
  'ROUTE_SOURCE_PAUSE_UNCONFIRMED', 'CAPTURE_STOP_TIMEOUT', 'PCM_STOP_NOT_CONFIRMED',
  'PREPARED_TARGET_ACTIVITY_EXPIRED', 'PREPARED_TARGET_ACTIVITY_REQUIRED',
  'PREPARED_SELECTION_INVALID_STATE', 'SESSION_OBSERVATION_UNTRUSTED',
  'PAUSED_SOURCE_OBSERVATION_TIMEOUT', 'PAUSED_SOURCE_OBSERVATION_STALE',
  'PAUSED_SOURCE_SCAN_INCOMPLETE', 'PAUSED_SOURCE_SESSIONS_STILL_ACTIVE',
  'PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED', 'SOURCE_NOT_PAUSED',
  'SOURCE_RESUMED_DURING_PAUSE_PROOF', 'SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH',
  'CAPTURE_HELPER_CLOSED', 'ROUTE_HELPER_CLOSED', 'CAPTURE_BOOTSTRAP_TIMEOUT',
  'HQPLAYER_CONTROL_UNAVAILABLE', 'HQPLAYER_COMMAND_REJECTED',
  'ROUTE_CONTROL_TIMEOUT', 'ROUTE_BUSY', 'ROUTE_OBSERVATION_FAILED',
  'CAPTURE_CONTROL_TIMEOUT', 'CAPTURE_CONTROL_BUSY', 'CAPTURE_BUSY',
  'CAPTURE_START_TIMEOUT', 'CAPTURE_INITIALIZE_TIMEOUT', 'CAPTURE_PIPE_TIMEOUT',
]);
const codeOf = error => error?.failureCode || error?.cause?.nativeCode || error?.cause?.code || error?.nativeCode || error?.code;
const canRetry = error => transient.has(codeOf(error));
function cancelled() { return Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }); }
async function retryPlayback(action, { signal, check = () => {}, wait = (ms, s) => delay(ms, undefined, { signal: s }),
  report = () => {}, operation = 'preparation' } = {}) {
  if (!recoveryContext.getStore()) return recoveryContext.run({ used: 0 }, () =>
    retryPlayback(action, { signal, check, wait, report, operation }));
  const budget = recoveryContext.getStore();
  const current = () => {
    check();
    if (signal?.aborted) {
      if (signal.reason?.code && typeof signal.reason.code === 'string' || signal.reason?.name === 'TimeoutError') throw signal.reason;
      throw cancelled();
    }
  };
  const emit = fields => { try { report({ operation, ...fields }); } catch { /* Logging cannot block recovery. */ } };
  for (let attempt = 0; ; attempt++) {
    current();
    try {
      const value = await action(attempt); current();
      if (attempt) emit({ phase: 'recovered', retryCount: attempt });
      return value;
    } catch (error) {
      current();
      if (!canRetry(error)) throw error;
      if (budget.used === 3) {
        error.retryCount = 3; error.retriesExhausted = true;
        emit({ phase: 'exhausted', retryCount: 3, code: codeOf(error) });
        throw error;
      }
      const retryIndex = budget.used++;
      emit({ phase: 'retry', retryCount: budget.used, code: codeOf(error) });
      try { await wait([150, 350, 700][retryIndex], signal); }
      catch (error) { current(); throw error; }
    }
  }
}
module.exports = { retryPlayback, canRetry, codeOf, transient };
