'use strict';
const { ownData, projectSoloistAuthDiagnostic } = require('./soloistAuthDiagnostics.cjs');
const { sourceErrorCode } = require('../debug/privatePreviewDiagnosticSchema.cjs');

// Observe the original read only: no polling, transport, retry, or replacement promise.
function createSoloistAuthReadObserver({ onObservation = () => {}, limit = 160, continuous = false, now = Date.now } = {}) {
  if (typeof onObservation !== 'function' || typeof now !== 'function' || typeof continuous !== 'boolean'
    || !Number.isInteger(limit) || limit < 1 || limit > 160) throw new TypeError('Invalid auth observer options');
  let count = 0; const retained = [];
  const time = () => {
    try { const value = now(); return Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
    catch { return undefined; }
  };
  const emit = value => {
    try { Promise.resolve(onObservation(value)).catch(() => {}); } catch { /* Observers cannot affect the original read. */ }
  };
  function begin() {
    if ((!continuous && count >= limit) || count >= 2147483647) return null;
    const observation = ++count, startedAt = time();
    const slot = { event: Object.freeze({ observation, stage: 'read', phase: 'request' }) };
    retained.push(slot); if (retained.length > limit) retained.shift(); emit(slot.event);
    return (ok, value) => {
      try {
        const event = { observation, stage: 'read', phase: 'result', ok }, endedAt = time();
        if (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt && endedAt - startedAt <= 604800000)
          event.elapsedMs = endedAt - startedAt;
        if (ok) {
          const auth = ownData(value, 'authState');
          const authenticated = ownData(auth, 'logged_in'), active = ownData(auth, 'is_active');
          if (typeof authenticated === 'boolean') event.authenticated = authenticated;
          if (typeof active === 'boolean') event.active = active;
        } else {
          event.errorCode = sourceErrorCode(value);
          if (event.errorCode === 'AUTH_SCHEMA_INVALID') {
            const diagnostic = projectSoloistAuthDiagnostic(ownData(value, 'diagnostic'));
            if (diagnostic) Object.assign(event, diagnostic);
          }
        }
        slot.event = Object.freeze(event); emit(slot.event);
      } catch { /* Malformed observer input cannot replace success or rejection. */ }
    };
  }
  function observe(value) {
    const finish = begin();
    if (finish) {
      try { Promise.resolve(value).then(result => finish(true, result), error => finish(false, error)).catch(() => {}); }
      catch { /* The existing caller remains responsible for its original value. */ }
    }
    return value;
  }
  function wrap(readFresh) {
    if (typeof readFresh !== 'function') throw new TypeError('Invalid auth reader');
    return function observedRead(...args) {
      let result;
      try { result = Reflect.apply(readFresh, this, args); }
      catch (error) { const finish = begin(); finish?.(false, error); throw error; }
      return observe(result);
    };
  }
  return Object.freeze({ observe, wrap, snapshot: () => Object.freeze(retained.map(slot => slot.event)) });
}
module.exports = { createSoloistAuthReadObserver };
