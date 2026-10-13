'use strict';

const OPERATIONS = Object.freeze(['pause', 'resume', 'seek', 'select']);
const MAX_DURATION_MS = 3600000;
function fail(code) { return Object.assign(new Error(code), { code }); }
function data(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('INVALID_INPUT');
  const own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== 'string' || !keys.includes(key))) throw fail('INVALID_INPUT');
  const out = {};
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail('INVALID_INPUT');
    out[key] = descriptor.value;
  }
  return out;
}
function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function context(input) {
  const value = data(input, ['ownerId', 'intentId', 'connectionEpoch']);
  if (!identifier(value.ownerId) || !identifier(value.intentId)
    || !Number.isSafeInteger(value.connectionEpoch) || value.connectionEpoch < 1) throw fail('INVALID_CONTEXT');
  return Object.freeze(value);
}
function command(input) {
  const value = data(input, ['operation', 'args']);
  if (!OPERATIONS.includes(value.operation)) throw fail('OPERATION_DENIED');
  const keys = value.operation === 'seek' ? ['positionMs', 'durationMs']
    : value.operation === 'select' ? ['uri'] : [];
  const args = data(value.args === undefined ? {} : value.args, keys);
  if (value.operation === 'seek' && (!Number.isSafeInteger(args.durationMs)
    || args.durationMs < 1 || args.durationMs > MAX_DURATION_MS
    || !Number.isSafeInteger(args.positionMs) || args.positionMs < 0 || args.positionMs >= args.durationMs))
    throw fail('INVALID_POSITION');
  if (value.operation === 'select' && (typeof args.uri !== 'string'
    || !/^spotify:track:[A-Za-z0-9]{22}$/.test(args.uri))) throw fail('INVALID_URI');
  return Object.freeze({ operation: value.operation, args: Object.freeze(args) });
}

// Bounded fact/reference projection only; no raw metadata, usernames or credentials.
function observation(input) {
  const value = data(input, ['kind', 'bridgeSeq', 'receivedAt', 'sourceTimestamp', 'uri', 'isPaused',
    'positionMs', 'durationMs', 'receiptId']);
  if (!['raw-update', 'cached-snapshot', 'native-evidence-reference'].includes(value.kind)) throw fail('INVALID_EVIDENCE');
  for (const key of ['bridgeSeq', 'positionMs', 'durationMs']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < (key === 'positionMs' ? 0 : 1)
      || key !== 'bridgeSeq' && value[key] > MAX_DURATION_MS)) throw fail('INVALID_EVIDENCE');
  }
  for (const key of ['receivedAt', 'sourceTimestamp']) {
    if (value[key] !== undefined && value[key] !== null && (!Number.isFinite(value[key]) || value[key] < 0)) throw fail('INVALID_EVIDENCE');
  }
  if (value.uri !== undefined && (typeof value.uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(value.uri))
    || value.isPaused !== undefined && typeof value.isPaused !== 'boolean'
    || value.receiptId !== undefined && !identifier(value.receiptId)) throw fail('INVALID_EVIDENCE');
  return Object.freeze(value);
}
module.exports = { OPERATIONS, MAX_DURATION_MS, fail, data, context, command, observation };
