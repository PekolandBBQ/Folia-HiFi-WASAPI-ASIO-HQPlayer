'use strict';
const { command, fail } = require('./command-schema.cjs');

// Exact method mapping for an explicitly injected object. This is NOT a user
// authorization or qualification boundary. A future real forensic invocation
// still needs its own authorization. No globals, network, or fallback lookup.
function preparePlayerApiCall(getPlayerAPI, callPath, input) {
  const checked = command(input);
  if (typeof getPlayerAPI !== 'function' || !['origin', 'wrapper'].includes(callPath)) throw fail('INVALID_ADAPTER');
  const api = getPlayerAPI();
  if (!api || !['object', 'function'].includes(typeof api)) throw fail('PLAYER_API_UNAVAILABLE');
  const method = callPath === 'origin'
    ? { pause: 'pause', resume: 'resume', seek: 'seekTo', select: 'play' }[checked.operation]
    : { pause: 'pause', resume: 'play', seek: 'seek', select: 'playUri' }[checked.operation];
  // Resolve accessors before handing an invocation to the dispatch barrier.
  // An accessor may throw. No method has then been invoked by this mapper.
  const fn = api[method];
  if (typeof fn !== 'function') throw fail('PLAYER_METHOD_UNAVAILABLE');
  const args = checked.operation === 'seek' ? [checked.args.positionMs]
    : checked.operation === 'select' ? callPath === 'origin'
      ? [{ uri: checked.args.uri }, {}, {}] : [checked.args.uri, {}, {}] : [];
  return Object.freeze({
    invoke: () => Reflect.apply(fn, api, args),
    callSource: `player-api-${callPath}`,
    completionContract: 'unknown',
  });
}
module.exports = { preparePlayerApiCall };
