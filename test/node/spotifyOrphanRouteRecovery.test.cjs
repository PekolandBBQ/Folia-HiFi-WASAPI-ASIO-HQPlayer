'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverOrphanRoute } = require('../../electron/spotify/orphanRouteRecovery.cjs');
// Exercise orchestration without touching real policy endpoints or retained journals.
const paused = { isPlaying: false, deviceId: 'desktop', uri: 'spotify:track:123' };
function options(overrides = {}) {
  return { componentDirectory: 'fixture', source: { sample: async () => paused }, current() {}, log() {},
    resolveComponent: async () => 'fixture.exe', ...overrides };
}
test('paused recovery invokes only the journal recovery command', async () => {
  let invocation;
  const result = await recoverOrphanRoute(options({ execute: (exe, args, settings, callback) => {
    invocation = { exe, args, settings }; callback(null, JSON.stringify({ restored: true, globalDefaultsWritten: false }));
  } }));
  assert.equal(result.restored, true);
  assert.deepEqual(invocation.args, ['--recover-orphan-route']);
  assert.equal(invocation.settings.windowsHide, true);
});
test('changed Spotify selection stops recovery before native writes', async () => {
  let samples = 0, nativeCalled = false;
  await assert.rejects(recoverOrphanRoute(options({ source: {
    sample: async () => ++samples === 1 ? { ...paused, isPlaying: true } : { ...paused, uri: 'spotify:track:456' }, request: async () => {},
  }, execute: () => { nativeCalled = true; } })), { code: 'SESSION_CHANGED' });
  assert.equal(nativeCalled, false);
});
test('native failure retains exact code and recovery stage', async () => {
  await assert.rejects(recoverOrphanRoute(options({ execute: (_exe, _args, _settings, callback) =>
    callback(Error('exit 3'), JSON.stringify({ code: 'ORPHAN_ROUTE_RECORD_NOT_FOUND' })) })),
  { code: 'ORPHAN_ROUTE_RECORD_NOT_FOUND', stage: 'previous-route-recovery' });
});
test('unconfirmed recovery is not accepted as restored', async () => {
  await assert.rejects(recoverOrphanRoute(options({ execute: (_exe, _args, _settings, callback) =>
    callback(null, JSON.stringify({ restored: true, globalDefaultsWritten: true })) })), { code: 'ORPHAN_ROUTE_RECOVERY_FAILED' });
});
