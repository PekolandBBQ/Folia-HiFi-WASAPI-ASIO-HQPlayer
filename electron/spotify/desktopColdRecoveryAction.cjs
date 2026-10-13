'use strict';
const { fail, playbackFacts } = require('./desktopPlaybackFacts.cjs');
const { volumeDevice } = require('./desktopColdBootstrap.cjs');

// electron/spotify/desktopColdRecoveryAction.cjs: explicit recovery of a settled v2 receipt after route restoration is verified.
function createDesktopColdRecoveryAction({ recovery, request, beginConfirmation, beginReadConfirmation,
  withinConfirmation, checkConfirmation, hasUnsettledWrites, wait, now, intervalMs }) {
  const blocked = () => fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
  return async function restore(record, receipt) {
    const saved = receipt.value;
    if (saved.version !== 2 || saved.deviceId !== record.deviceId || saved.volumeRequestPending
      || saved.playbackRequestPending || hasUnsettledWrites()) throw blocked();
    let baseline, timestampFloor;
    function exactPaused(body) {
      const durationMs = body?.item?.duration_ms;
      if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3600000) throw blocked();
      const facts = playbackFacts(body, { ...record, trackId: saved.trackId, durationMs }, { now });
      if (facts.isPlaying || baseline && (facts.positionMs !== baseline.positionMs || facts.durationMs !== baseline.durationMs)
        || timestampFloor != null && (facts.serverTimestamp == null || facts.serverTimestamp < timestampFloor)) throw blocked();
      if (facts.serverTimestamp != null) timestampFloor = facts.serverTimestamp;
      baseline ||= facts;
      return facts;
    }
    const source = confirmation => withinConfirmation(confirmation, async () => exactPaused(
      await request('state', record, { signal: confirmation.signal })));
    async function sample(confirmation) {
      await source(confirmation);
      const body = await withinConfirmation(confirmation, () => request('devices', record, { signal: confirmation.signal }));
      const device = volumeDevice(body, saved.deviceId);
      if (!device.is_active || device.volume_percent !== 0 && device.volume_percent !== saved.originalVolume) throw blocked();
      checkConfirmation(record, confirmation);
      return device.volume_percent;
    }
    // Both source/device pairs must finish before any write, including after a
    // restart. A receipt alone never grants authority to pause or select a source.
    const before = beginReadConfirmation(record, 2);
    const firstVolume = await sample(before);
    await withinConfirmation(before, () => wait(Math.min(intervalMs, before.deadline - now()), before.signal));
    const secondVolume = await sample(before);
    if (firstVolume !== secondVolume || hasUnsettledWrites()) throw blocked();
    if (secondVolume === saved.originalVolume) {
      await recovery.clearSnapshot(receipt, () => checkConfirmation(record, before));
      return { required: false, recoverable: false };
    }
    // The final device observation cannot authorize a later resumed source.
    await source(before);
    checkConfirmation(record, before);
    if (hasUnsettledWrites()) throw blocked();
    await recovery.adoptSettled(record, receipt);
    const mutation = beginConfirmation(record);
    await recovery.setVolumePending(record, true);
    checkConfirmation(record, mutation);
    // Exactly one PUT. A timeout retains the pending marker even if the producer
    // later responds; neither a retry nor a subsequent read erases that uncertainty.
    await withinConfirmation(mutation, () => request('volume', record, {
      volumePercent: saved.originalVolume, signal: mutation.signal,
    }));
    checkConfirmation(record, mutation);
    await recovery.setVolumePending(record, false);
    const after = beginReadConfirmation(record, 2);
    let matched = false;
    for (;;) {
      const volume = await sample(after);
      if (volume === saved.originalVolume && matched) {
        if (hasUnsettledWrites()) throw blocked();
        checkConfirmation(record, after);
        record.mutationPending = false;
        await recovery.clear(record, () => checkConfirmation(record, after));
        return { required: false, recoverable: false };
      }
      matched = volume === saved.originalVolume;
      await withinConfirmation(after, () => wait(Math.min(intervalMs, after.deadline - now()), after.signal));
    }
  };
}
module.exports = { createDesktopColdRecoveryAction };
