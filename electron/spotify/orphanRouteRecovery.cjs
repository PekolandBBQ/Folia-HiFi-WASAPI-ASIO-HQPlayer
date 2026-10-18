'use strict';
const { execFile } = require('node:child_process');
const { resolveOwnedRouteComponent } = require('./ownedRouteHost.cjs');
// Restore a retained previous Folia transaction, never a guessed per-app default.
async function recoverOrphanRoute({ componentDirectory, source, current, log, execute = execFile, resolveComponent = resolveOwnedRouteComponent }) {
  current();
  const before = await source.sample(); current();
  if (before.isPlaying) {
    await source.request('pause', { deviceId: before.deviceId, trackId: before.uri?.slice(14) }, current, { matchTrackBeforeDispatch: true });
    const until = Date.now() + 3000;
    let paused;
    do { current(); paused = await source.sample(); if (paused.deviceId !== before.deviceId || paused.uri !== before.uri) throw Object.assign(Error('SESSION_CHANGED'), { code: 'SESSION_CHANGED' });
      if (!paused.isPlaying) break; await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    if (paused.isPlaying) throw Object.assign(Error('ORPHAN_ROUTE_SOURCE_NOT_PAUSED'), { code: 'ORPHAN_ROUTE_SOURCE_NOT_PAUSED' });
  }
  const executable = await resolveComponent(componentDirectory); current();
  const result = await new Promise((resolve, reject) => execute(executable, ['--recover-orphan-route'], { windowsHide: true, timeout: 30000, maxBuffer: 16384 }, (error, stdout) => {
    let value; try { value = JSON.parse(stdout); } catch {}
    if (!error && value?.restored === true && value.globalDefaultsWritten === false) return resolve(value);
    const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(value?.code || '') ? value.code : 'ORPHAN_ROUTE_RECOVERY_FAILED';
    reject(Object.assign(Error(code), { code, stage: 'previous-route-recovery' }));
  }));
  log('spotify-orphan-route-restored', result); current();
  return result;
}
// Both warm inspection and cold identity inspection share the same recovery boundary.
async function prepareWithOrphanRecovery(prepare, recover, current = () => {}) {
  try { return await prepare(); }
  catch (error) {
    if ((error.failureCode || error.nativeCode || error.code) !== 'ORIGINAL_ENDPOINT_UNSAFE' || error.stage !== 'route-inspect') throw error;
    current(); await recover(); current();
    return prepare();
  }
}
module.exports = { recoverOrphanRoute, prepareWithOrphanRecovery };
