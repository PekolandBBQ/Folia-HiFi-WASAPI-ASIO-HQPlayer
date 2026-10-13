'use strict';
const { createSourceCore } = require('./sourceCore.cjs');
const { data, fail } = require('../vendor/stage05/commands/command-schema.cjs');

// runtime/spicetifySource.cjs: shipping candidate admission remains unconditionally closed.
const CLOSED = Object.freeze({
  authorize: async () => { throw fail('DESKTOP_SOURCE_UNQUALIFIED'); },
  stamp: () => null,
  snapshot: async () => { throw fail('DESKTOP_SOURCE_UNQUALIFIED'); },
  devices: async () => { throw fail('DESKTOP_SOURCE_UNQUALIFIED'); },
  validate: () => false,
  completeMutation: async () => { throw fail('SOURCE_EFFECT_UNKNOWN'); },
  assertDispatch: () => { throw fail('DESKTOP_SOURCE_UNQUALIFIED'); },
});
function createSpicetifySource(input) {
  const { port, now, timeoutMs } = data(input, ['port', 'now', 'timeoutMs']);
  const source = createSourceCore({ port, authority: CLOSED, ...(now ? { now } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  return Object.freeze({ ...source, inspect: () => ({ ...source.inspect(), productionAdmission: 'CLOSED',
    liveLocalTargetSemantics: 'unverified', liveAsyncEffectScope: 'unverified' }) });
}
module.exports = { createSpicetifySource };
