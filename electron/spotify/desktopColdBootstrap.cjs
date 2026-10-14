'use strict';
const { createColdVolumeReceipt } = require('./desktopColdRecovery.cjs');
const { fail, requireDevice, validTrackId } = require('./desktopPlaybackFacts.cjs');
const { reportSpotifyPlaybackControl, reportSpotifyColdBootstrap } = require('./requestDiagnostics.cjs');

// electron/spotify/desktopColdBootstrap.cjs: one muted cold selection inside the existing playback lease and mutation queue.
function volumeDevice(body, id) {
  requireDevice(body, id);
  const device = body.devices.find(item => item.id === id);
  if (device.supports_volume !== true || !Number.isInteger(device.volume_percent)
    || device.volume_percent < 0 || device.volume_percent > 100) throw fail('BOOTSTRAP_VOLUME_UNAVAILABLE');
  return device;
}

function createDesktopColdBootstrap({ directory, request, beginConfirmation, beginReadConfirmation, withinConfirmation, checkConfirmation, wait, now, intervalMs }) {
  const recovery = createColdVolumeReceipt(directory);
  const { assertClear, retain, clear } = recovery;
  function checkedVolumeDevice(record, body, requireActive = false, emptyBaseline = false) {
    try {
      const device = volumeDevice(body, record.deviceId);
      if (requireActive && !device.is_active) throw fail('DEVICE_INACTIVE');
      if (emptyBaseline && body.devices.some(item => item.id !== record.deviceId && item.is_active !== false))
        throw fail('PLAYBACK_STATE_UNCONFIRMED');
      return device;
    } catch (error) { record.coldPreselectConflict = true; throw error; }
  }
  async function readVolume(record, confirmation, requireActive = false, emptyBaseline = false) {
    const body = await withinConfirmation(confirmation,
      () => request('devices', record, { signal: confirmation.signal }));
    return checkedVolumeDevice(record, body, requireActive, emptyBaseline).volume_percent;
  }
  // A faster failing GET cannot begin compensation before its paired source has
  // checked identity. Both settle inside the existing shared confirmation budget.
  async function readPair(confirmation, source, devices) {
    const results = await withinConfirmation(confirmation, () => Promise.allSettled([
      Promise.resolve().then(source), Promise.resolve().then(devices),
    ]));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results.map(result => result.value);
  }
  function requireKnownVolume(record, volume) {
    if (volume !== 0 && volume !== record.coldVolumeReceipt.originalVolume) {
      record.coldPreselectConflict = true; throw fail('BOOTSTRAP_VOLUME_UNCONFIRMED');
    }
    return volume;
  }
  // Persist uncertainty before a playback action can dispatch. A cleanup pause
  // may park an observed source, but cannot erase an older command's pending flag.
  async function playbackMutation(record, action, cleanupPause = false) {
    const wasPending = record.coldVolumeReceipt.playbackRequestPending;
    if (wasPending && !cleanupPause) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    await recovery.setPlaybackPending(record, true);
    const result = await action();
    if (!wasPending) await recovery.setPlaybackPending(record, false);
    return result;
  }
  // Serialize each volume PUT with fresh device-list confirmation. Even a 204 is
  // only an acknowledgment; API readback is not a claim about physical silence.
  async function setVolume(record, volumePercent, verifySource, { emptyBaseline = false, observe } = {}) {
    let confirmation = beginConfirmation(record);
    await recovery.setVolumePending(record, true);
    checkConfirmation(record, confirmation, 'BOOTSTRAP_VOLUME_UNCONFIRMED');
    record.coldVolumeInvoked = true;
    record.coldVolumeRequestPending = true;
    const acknowledgment = await withinConfirmation(confirmation,
      () => request('volume', record, { volumePercent, signal: confirmation.signal }));
    checkConfirmation(record, confirmation, 'BOOTSTRAP_VOLUME_UNCONFIRMED');
    await recovery.setVolumePending(record, false);
    record.coldVolumeRequestPending = false;
    // Only a settled restoration starts this bounded read-only window. The PUT
    // keeps its original deadline and unknown writes keep their durable marker.
    if (volumePercent !== 0) confirmation = beginReadConfirmation(record, 2);
    let observedOnce = false;
    for (;;) {
      checkConfirmation(record, confirmation, 'BOOTSTRAP_VOLUME_UNCONFIRMED');
      let source, observed;
      if (emptyBaseline) {
        // GET204 is only an empty account state. Corroborate it with the exact
        // device in the same bounded sample; neither response is pause proof.
        // Overlap existing reads so one empty-state RTT cannot starve volume
        // confirmation. Each sample keeps the same two GETs and deadline.
        [source, observed] = await withinConfirmation(confirmation, () => Promise.all([
          verifySource(confirmation.signal), readVolume(record, confirmation, false, true),
        ]));
      } else if (volumePercent !== 0) {
        // Restoration finishes receipt ownership. Keep its final volume read
        // newer than the paused-source read, including external volume changes.
        if (verifySource) source = await withinConfirmation(confirmation, () => verifySource(confirmation.signal));
        observed = await readVolume(record, confirmation);
      } else {
        // The volume write has settled. Observe both facts in one bounded sample;
        // keep the next independent sample and all mutation gates serialized.
        [source, observed] = await readPair(confirmation,
          () => verifySource?.(confirmation.signal),
          async () => requireKnownVolume(record, await readVolume(record, confirmation)));
      }
      requireKnownVolume(record, observed);
      confirmation.observationCount++;
      checkConfirmation(record, confirmation, 'BOOTSTRAP_VOLUME_UNCONFIRMED');
      observe?.({ observationCount: confirmation.observationCount,
        observedEmpty: source === null, volumeMatched: observed === volumePercent });
      if (observed === volumePercent && observedOnce) {
        record.mutationPending = false;
        if (acknowledgment?.acknowledgment === 'UNCONFIRMED') reportSpotifyPlaybackControl('playback-volume', 'PUT', 200,
          { phase: 'state-confirmed', observationCount: confirmation.observationCount, deviceMatched: true });
        return;
      }
      observedOnce = observed === volumePercent;
      await withinConfirmation(confirmation, () => wait(Math.min(intervalMs, confirmation.deadline - now()), confirmation.signal));
    }
  }
  function requirePausedSource(record, state, expected) {
    if (state.deviceId !== record.deviceId || state.isPlaying || !validTrackId(state.trackId)
      || expected && (state.trackId !== expected.trackId
        || expected.positionMs != null && state.positionMs !== expected.positionMs
        || expected.durationMs != null && state.durationMs !== expected.durationMs)
      || record.coldTimestampFloor != null && (state.serverTimestamp == null || state.serverTimestamp < record.coldTimestampFloor))
      { record.coldPreselectConflict = true; throw fail('PLAYBACK_STATE_UNCONFIRMED'); }
    if (state.serverTimestamp != null) record.coldTimestampFloor = state.serverTimestamp;
    return state;
  }
  // Pair fresh, complete paused-source and volume observations inside one deadline.
  // Neither a GET204 baseline nor the display-only matchTrack:false facts are pause proof.
  async function pausedVolumePair(record, actions, expected, allowOriginal = false) {
    const confirmation = beginConfirmation(record);
    let first, previousVolume, result;
    for (let observation = 0; observation < 2; observation++) {
      let state, volume;
      try {
        const source = async () => requirePausedSource(record,
          await actions.readPausedSource(record, confirmation.signal), first || expected);
        const devices = async () => {
          const body = await request('devices', record, { signal: confirmation.signal });
          const device = checkedVolumeDevice(record, body, true), observed = device.volume_percent;
          if (observed !== 0 && !(allowOriginal && observed === record.coldVolumeReceipt.originalVolume)
            || observation && observed !== previousVolume) {
            record.coldPreselectConflict = true; throw fail('BOOTSTRAP_VOLUME_UNCONFIRMED');
          }
          return observed;
        };
        if (allowOriginal) {
          // Recovery has no subsequent native mute proof before restoring volume.
          // Keep the device sample after the source sample at that boundary.
          state = await withinConfirmation(confirmation, source);
          volume = await withinConfirmation(confirmation, devices);
        } else [state, volume] = await readPair(confirmation, source, devices);
      }
      catch (error) {
        if (['PLAYBACK_STATE_UNCONFIRMED', 'DEVICE_ID_MISMATCH', 'DEVICE_INACTIVE', 'DEVICE_RESTRICTED',
          'TRACK_NOT_CURRENT', 'PROTOCOL_INVALID'].includes(error?.code)) record.coldPreselectConflict = true;
        throw error;
      }
      checkConfirmation(record, confirmation);
      first = state; previousVolume = volume; result = { state, volume };
      if (!observation) await withinConfirmation(confirmation,
        () => wait(Math.min(intervalMs, confirmation.deadline - now()), confirmation.signal));
    }
    return result;
  }
  // Before any select invocation there is no late play command to compensate.
  // Unknown transfer/volume completion still blocks; restoration never seeks or selects.
  async function restoreBeforeSelect(record, actions) {
    if (record.coldSelectInvoked || record.coldTransferPending || record.coldVolumeRequestPending || record.coldPreselectConflict
      || record.coldVolumeReceipt.volumeRequestPending || record.coldVolumeReceipt.playbackRequestPending
      || !validTrackId(record.coldPausedRestoreTrack)) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    const observed = await pausedVolumePair(record, actions, { trackId: record.coldPausedRestoreTrack }, true);
    const originalVolume = record.coldVolumeReceipt.originalVolume;
    const stillPaused = async () => requirePausedSource(record, await actions.readPausedSource(record), observed.state);
    // The last paired observation ends on a device read. Recheck the source
    // before any audible-volume PUT, not only afterward inside setVolume.
    await stillPaused();
    if (observed.volume !== originalVolume) {
      await setVolume(record, originalVolume, stillPaused);
    }
    await clear(record);
  }
  async function restore(record, actions) {
    if (record.coldVolumeRequestPending || record.coldVolumeReceipt.volumeRequestPending
      || record.coldVolumeReceipt.playbackRequestPending) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    const requireFresh = state => {
      if (record.coldTimestampFloor != null && (state.serverTimestamp == null || state.serverTimestamp < record.coldTimestampFloor))
        throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
      if (state.serverTimestamp != null) record.coldTimestampFloor = state.serverTimestamp;
      return state;
    };
    const parked = requireFresh(await playbackMutation(record, () => actions.park(record)));
    if (parked.isPlaying || parked.deviceId !== record.deviceId || parked.trackId !== record.trackId)
      throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    const confirmation = beginConfirmation(record);
    const observedVolume = await readVolume(record, confirmation), originalVolume = record.coldVolumeReceipt.originalVolume;
    if (observedVolume !== 0 && observedVolume !== originalVolume) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    const stillPaused = async () => {
      const state = requireFresh(await actions.read(record));
      if (state.isPlaying) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    };
    await stillPaused();
    if (observedVolume === originalVolume && originalVolume !== 0) {
      // A failed acknowledgment/cancellation may follow a completed restoration.
      // Fresh paused/source and original-volume readback can finish this same lease.
      if (await readVolume(record, confirmation) !== originalVolume) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
      await stillPaused();
    } else await setVolume(record, originalVolume, stillPaused);
    await clear(record);
    return parked;
  }
  async function run(record, actions) {
    await assertClear();
    let stage = 'baseline', muteObservationCount = 0, continuationEntered = false;
    record.coldSelectInvoked = false;
    record.coldVolumeInvoked = false;
    record.coldSelectionConfirmed = false;
    record.coldActivationConfirmed = false;
    const report = (phase, facts = {}) => reportSpotifyColdBootstrap(record.session, stage, phase, {
      selectInvoked: record.coldSelectInvoked,
      selectConfirmed: record.coldSelectionConfirmed, activationConfirmed: record.coldActivationConfirmed,
      receiptRetained: !!record.coldVolumeReceipt,
      ...(stage === 'mute' ? { observationCount: muteObservationCount } : {}), ...facts });
    // The active click authorizes restoring the saved local target. Freeze the
    // initial account state, including another Connect device, before any write.
    const baseline = await actions.baseline();
    record.coldBaselineEmpty = baseline === null;
    record.coldActivationTrack = baseline?.trackId;
    report('observed', { baselineEmpty: baseline === null });
    if (baseline?.deviceId === record.deviceId && baseline.isPlaying === false && validTrackId(baseline.trackId)) {
      record.coldPausedRestoreTrack = baseline.trackId;
      record.coldTimestampFloor = baseline.serverTimestamp;
    }
    const sameBaseline = async signal => {
      const state = await actions.baseline(signal);
      if ((state === null) !== (baseline === null) || state?.trackId !== baseline?.trackId
        || state?.deviceId !== baseline?.deviceId || state?.isPlaying !== baseline?.isPlaying
        || state?.isActive !== baseline?.isActive) {
        record.coldPreselectConflict = true; throw fail('PLAYBACK_STATE_UNCONFIRMED');
      }
      return state;
    };
    const confirmation = beginConfirmation(record);
    const initialDevice = checkedVolumeDevice(record, await withinConfirmation(confirmation,
      () => request('devices', record, { signal: confirmation.signal })), false, baseline === null);
    record.coldInitialTargetActive = initialDevice.is_active;
    const originalVolume = initialDevice.volume_percent;
    await retain(record, originalVolume);
    try {
      await sameBaseline();
      stage = 'mute';
      await setVolume(record, 0, sameBaseline, { emptyBaseline: baseline === null,
        observe: facts => { muteObservationCount = facts.observationCount; report('observed', facts); } });
      report('completed', { volumeMatched: true });
      await sameBaseline();
      record.coldActivationTrack = baseline?.trackId;
      stage = 'activate';
      await recovery.crossPlaybackBoundary(record);
      const activated = await playbackMutation(record, () => actions.activate());
      record.coldActivationConfirmed = true;
      report('observed', { baselineEmpty: baseline === null, observedEmpty: activated === null,
        ...(activated ? { deviceMatched: activated.deviceId === record.deviceId, paused: !activated.isPlaying } : {}) });
      if (baseline === null && activated !== null) {
        if (activated.deviceId !== record.deviceId || activated.isPlaying || !validTrackId(activated.trackId))
          { record.coldPreselectConflict = true; throw fail('PLAYBACK_STATE_UNCONFIRMED'); }
        record.coldActivationTrack = activated.trackId;
        record.coldPausedRestoreTrack = activated.trackId;
        record.coldTimestampFloor = activated.serverTimestamp;
        await pausedVolumePair(record, actions, { trackId: activated.trackId });
      } else if ((activated === null) !== (baseline === null) || activated?.trackId !== baseline?.trackId
        || activated?.isPlaying !== baseline?.isPlaying) {
        record.coldPreselectConflict = true; throw fail('PLAYBACK_STATE_UNCONFIRMED');
      }
      if (record.coldTransferInvoked && baseline?.isPlaying === true && activated?.isPlaying === true
        && activated.deviceId === record.deviceId && activated.trackId === baseline.trackId && validTrackId(baseline.trackId)) {
        record.coldTransferredPlayingTrack = baseline.trackId;
        record.coldTransferredTimestampFloor = activated.serverTimestamp;
      }
      if (activated?.isPlaying === false && validTrackId(activated.trackId)) record.coldPausedRestoreTrack = activated.trackId;
      // Transfer play:false preserves playback intent, so it may already be playing.
      // Require the saved target's previously confirmed mute to remain observable.
      if (await readVolume(record, beginConfirmation(record), true) !== 0) {
        record.coldPreselectConflict = true; throw fail('BOOTSTRAP_VOLUME_UNCONFIRMED');
      }
      report('completed', { volumeMatched: true });
      stage = 'select';
      // Conservative before invocation: even a failed/aborted request might reach Spotify.
      await recovery.crossPlaybackBoundary(record);
      record.coldSelectInvoked = true;
      const selected = await playbackMutation(record, () => actions.select(record));
      record.coldSelectionConfirmed = true;
      report('completed');
      record.coldTimestampFloor = selected.serverTimestamp;
      stage = 'inspect';
      const inspect = beginConfirmation(record);
      try { await withinConfirmation(inspect, () => actions.inspect(selected)); }
      catch (error) {
        checkConfirmation(record, inspect);
        if (['CANCELLED', 'SUPERSEDED', 'STALE_SESSION', 'CLOSED', 'SESSION_CHANGED'].includes(error?.code)) throw error;
        if (error?.name === 'AbortError') throw fail('CANCELLED');
        throw Object.assign(fail('BOOTSTRAP_IDENTITY_UNCONFIRMED'), { cause: error, failureCode: error?.failureCode || error?.nativeCode || error?.code, stage: 'identity-inspect' });
      }
      checkConfirmation(record, inspect);
      report('completed');
      if (actions.continueMuted) {
        // Identity discovery only needs a real pause. The route's later select
        // replaces this position, so keep the same receipt and omit the cold seek.
        const parked = await playbackMutation(record, () => actions.parkMuted(record));
        requirePausedSource(record, parked, { trackId: record.trackId });
        if (actions.hasUnsettledWrites()) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
        // The continuation owns all compensation from here, including rejection
        // before its first route write. Never fall back to cold audible restoration.
        continuationEntered = true;
        return await actions.continueMuted(parked, record.coldVolumeReceipt);
      }
      stage = 'restore';
      const parked = await restore(record, actions);
      report('completed', { volumeMatched: true, paused: true });
      return parked;
    } catch (error) {
      if (continuationEntered) throw error;
      if (!record.coldSelectInvoked && ['PLAYBACK_STATE_UNCONFIRMED', 'DEVICE_ID_MISMATCH', 'DEVICE_INACTIVE',
        'DEVICE_RESTRICTED', 'DEVICE_NOT_LISTED', 'DUPLICATE_DEVICE_ID', 'TRACK_NOT_CURRENT', 'PROTOCOL_INVALID',
        'BOOTSTRAP_VOLUME_UNAVAILABLE'].includes(error?.code)) record.coldPreselectConflict = true;
      report('failed', { errorCode: error });
      // The caller provides a narrow cleanup lease for the same grant/target/track.
      // Its queue blocks replacement selection until this bounded compensation ends.
      if (record.coldVolumeReceipt) {
        try {
          stage = 'cleanup';
          if (!record.coldVolumeInvoked) {
            // No mutation function was entered: remove only this unchanged local
            // receipt. A changed live source grants no pause or volume authority.
            await clear(record);
          } else {
            const cleanup = actions.cleanupRecord();
            // An unconfirmed select may still arrive late. Never restore audible
            // volume after that timeout, even if a subsequent pause was observed.
            if (!record.coldSelectInvoked) {
              // This operation may itself have transferred a known playing source.
              // Pause only that frozen track after confirmed transfer; never pause
              // an originally paused source's later resume or an unknown cold source.
              if (record.coldActivationConfirmed && !record.coldTransferPending && record.coldTransferredPlayingTrack)
                await playbackMutation(cleanup, () => actions.safePauseTransferred(cleanup), true);
              await restoreBeforeSelect(cleanup, actions);
            }
            else {
              await playbackMutation(cleanup, () => actions.safePause(cleanup), true);
              if (!record.coldSelectionConfirmed) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
              await restore(cleanup, actions);
            }
          }
          record.coldVolumeReceipt = undefined;
          report('completed', record.coldVolumeInvoked ? { volumeMatched: true, paused: true } : {});
        } catch (cleanupError) {
          report('failed', { errorCode: cleanupError, causeCode: error });
          throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
        }
      }
      throw error;
    }
  }
  // Route-bound materialization is distinct from cold identity discovery. A
  // selected song is created once under volume0, parked, then handed back while
  // the same routing lease is still owned. Capture/format leases start afterward.
  async function runProtectedSelection(record, actions, retainedHandoff) {
    if (retainedHandoff) {
      // Only the same in-process cold lease can transfer this durable receipt.
      // A renderer flag, copied receipt, stale file or unresolved write cannot.
      const snapshot = await recovery.snapshot();
      if (retainedHandoff.receipt !== record.coldVolumeReceipt || !snapshot
        || snapshot.encoded !== JSON.stringify(record.coldVolumeReceipt) + '\n'
        || record.coldVolumeReceipt.session !== record.session
        || record.coldVolumeReceipt.deviceId !== record.deviceId
        || record.coldVolumeReceipt.trackId !== record.trackId
        || record.coldVolumeReceipt.volumeRequestPending || record.coldVolumeReceipt.playbackRequestPending
        || record.coldVolumeRequestPending || record.coldTransferPending || record.coldPreselectConflict
        || !record.coldSelectionConfirmed) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    } else await assertClear();
    if (actions.hasUnsettledWrites()) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
    record.coldSelectInvoked = false; record.coldVolumeInvoked = !!retainedHandoff;
    record.coldSelectionConfirmed = false; record.coldPreparationCompleted = false;
    record.coldPreselectConflict = false; record.coldVolumeRequestPending = false;
    record.coldTransferPending = false; record.coldBaselineEmpty = false;
    let stage = 'baseline';
    const report = (phase, facts = {}) => reportSpotifyColdBootstrap(record.session, stage, phase, {
      selectInvoked: record.coldSelectInvoked, selectConfirmed: record.coldSelectionConfirmed,
      receiptRetained: !!record.coldVolumeReceipt, ...facts });
    const baseline = requirePausedSource(record, retainedHandoff?.paused || await actions.readPausedSource(record), actions.expectedBaseline);
    record.coldPausedRestoreTrack = baseline.trackId; record.coldActivationTrack = baseline.trackId;
    record.coldInitialTargetActive = true;
    const initialVolume = retainedHandoff ? record.coldVolumeReceipt.originalVolume
      : await readVolume(record, beginConfirmation(record), true);
    if (!retainedHandoff) await retain(record, initialVolume);
    const stillBaseline = async signal => requirePausedSource(record,
      await actions.readPausedSource(record, signal), baseline);
    try {
      stage = 'mute';
      if (!retainedHandoff) {
        await stillBaseline();
        await setVolume(record, 0, stillBaseline);
      }
      await pausedVolumePair(record, actions, baseline);
      report('completed', { volumeMatched: true, paused: true });
      if (actions.hasUnsettledWrites()) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
      stage = 'activate';
      await actions.beforeSelect(baseline);
      report('completed');
      // The native authorization itself reads the same retained receipt and
      // fresh zero-volume source. No captureStarted/interval assertion is used.
      await recovery.crossPlaybackBoundary(record);
      stage = 'select';
      record.coldSelectInvoked = true;
      const selected = await playbackMutation(record, () => actions.select(record));
      record.coldSelectionConfirmed = true; record.coldTimestampFloor = selected.serverTimestamp;
      if (await readVolume(record, beginConfirmation(record), true) !== 0)
        throw fail('BOOTSTRAP_VOLUME_UNCONFIRMED');
      const parked = await playbackMutation(record, () => actions.park(record));
      requirePausedSource(record, parked, { trackId: record.trackId });
      const stable = await pausedVolumePair(record, actions, { trackId: record.trackId, positionMs: parked.positionMs });
      report('completed', { volumeMatched: true, paused: true });
      if (actions.hasUnsettledWrites()) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
      stage = 'inspect';
      await actions.afterPark(stable.state);
      report('completed', { volumeMatched: true, paused: true });
      record.coldPreparationCompleted = true;
      stage = 'restore';
      const stillParked = async signal => requirePausedSource(record,
        await actions.readPausedSource(record, signal), stable.state);
      await stillParked();
      if (actions.hasUnsettledWrites()) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
      await setVolume(record, initialVolume, stillParked);
      await clear(record);
      report('completed', { volumeMatched: true, paused: true });
      return stable.state;
    } catch (error) {
      report('failed', { errorCode: error });
      if (record.coldVolumeReceipt) {
        try {
          stage = 'cleanup';
          if (!record.coldVolumeInvoked) await clear(record);
          else {
            const cleanup = actions.cleanupRecord();
            if (!record.coldSelectInvoked) {
              if (actions.hasUnsettledWrites()) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
              await restoreBeforeSelect(cleanup, actions);
            } else {
              // A later pause cannot retire an older unknown select. Keep the
              // durable pending marker and mute until completion is established.
              await playbackMutation(cleanup, () => actions.safePause(cleanup), true);
              if (!record.coldSelectionConfirmed || !record.coldPreparationCompleted
                || actions.hasUnsettledWrites()) throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
              await restore(cleanup, actions);
            }
          }
          record.coldVolumeReceipt = undefined;
          report('completed', { volumeMatched: true, paused: true });
        } catch (cleanupError) {
          report('failed', { errorCode: cleanupError, causeCode: error });
          throw fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
        }
      }
      throw error;
    }
  }
  // Snapshot is read again from the durable receipt. The response never derives
  // authority from a renderer flag or from pcmStopped alone.
  async function mutedPreparationEvidence(record, preparationSelectedSourceUri, hasUnsettledWrites) {
    const retained = await recovery.snapshot();
    const receipt = record.coldVolumeReceipt;
    const exact = !!retained && !!receipt && retained.encoded === JSON.stringify(receipt) + '\n'
      && receipt.version === 2 && receipt.session === record.session && receipt.deviceId === record.deviceId
      && receipt.trackId === record.trackId && preparationSelectedSourceUri === `spotify:track:${record.trackId}`;
    return { volumeReceiptRetained: exact && !record.coldPreselectConflict,
      volumeRequestPending: !exact || receipt.volumeRequestPending || record.coldVolumeRequestPending === true,
      playbackRequestPending: !exact || receipt.playbackRequestPending || hasUnsettledWrites() };
  }
  const protectCleanupPause = (record, action) => record.coldVolumeReceipt
    ? playbackMutation(record, action, true) : action();
  return { assertClear, run, runProtectedSelection, mutedPreparationEvidence, protectCleanupPause, recovery };
}

module.exports = { createDesktopColdBootstrap, volumeDevice };
