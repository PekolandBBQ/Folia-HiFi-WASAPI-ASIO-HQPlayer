'use strict';

// Only bounded auth-schema metadata may cross the private guest control boundary.
const stages = Object.freeze(['initial-auth', 'state-auth', 'seek-auth']);
const reasons = Object.freeze(['frame-type', 'top-level-type', 'event-type', 'logged-in-type', 'is-active-type']);
const frames = Object.freeze(['CONTINUATION', 'TEXT', 'BINARY', 'PING', 'PONG', 'CLOSE', 'CLOSING', 'CLOSED', 'ERROR', 'UNKNOWN']);
const types = Object.freeze(['missing', 'null', 'boolean', 'number', 'string', 'array', 'object', 'unknown']);
const required = Object.freeze(['stage', 'reason', 'frameType', 'topLevelType', 'eventType', 'loggedInType', 'isActiveType']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Data descriptors avoid evaluating accessors on errors supplied by an observer.
function ownData(value, key) {
  if (!record(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function projectSoloistAuthDiagnostic(value) {
  if (!record(value)) return null;
  const names = Object.keys(value);
  if (names.length < required.length || names.length > required.length + 1
    || required.some(key => !names.includes(key)) || names.some(key => !required.includes(key) && key !== 'closeCode')) return null;
  const result = Object.fromEntries(required.map(key => [key, ownData(value, key)]));
  if (!stages.includes(result.stage) || !reasons.includes(result.reason) || !frames.includes(result.frameType)
    || ['topLevelType', 'eventType', 'loggedInType', 'isActiveType'].some(key => !types.includes(result[key]))) return null;
  if (names.includes('closeCode')) {
    const code = ownData(value, 'closeCode');
    if (!Number.isInteger(code) || code < 0 || code > 65535) return null;
    result.closeCode = code;
  }
  return Object.freeze(result);
}
module.exports = { projectSoloistAuthDiagnostic, ownData };
