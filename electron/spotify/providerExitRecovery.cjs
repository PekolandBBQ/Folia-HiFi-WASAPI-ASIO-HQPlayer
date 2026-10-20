'use strict';
const { isRetryableRouteCleanup } = require('./ownedRouteCleanup.cjs');

// electron/spotify/providerExitRecovery.cjs: pending Spotify-only restoration must not own another provider's output.
async function deferSourceRestore({ error, owner, captureHost, enabled, diagnostic }) {
  const code = error?.nativeCode || error?.code;
  if (!enabled || !owner?.route) throw error;
  // Process-only route recovery belongs to Spotify. Other providers need our
  // local capture/output stopped, not a successful command to a remote phone.
  // Keep uncertain native restoration and its journal owned for Spotify re-entry.
  if (typeof captureHost.verifyStopped !== 'function') throw error;
  await captureHost.verifyStopped();
  owner.exitDeferred = true;
  owner.exitFailure = error;
  owner.localCaptureStopped = true;
  try { diagnostic({ phase: 'provider-exit-deferred', session: owner.record?.session, routeSession: owner.session,
    nativeCode: code, sourceCode: owner.record?.cleanupFailure?.cause?.code || owner.record?.cleanupFailure?.code, captureStopped: true,
    routeRestored: false, restoreWritesStarted: isRetryableRouteCleanup(error) ? false : null,
    detail: '本机 Spotify 采集已停止；控制状态暂不可用，原路由恢复记录保留，其他音源可继续播放。' }); } catch { /* Diagnostics do not own playback. */ }
  return { released: false, pendingRestore: true };
}
module.exports = { deferSourceRestore };
