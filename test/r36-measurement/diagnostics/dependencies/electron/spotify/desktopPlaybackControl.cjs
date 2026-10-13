'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { createDesktopPlaybackApi } = require('./desktopPlaybackApi.cjs');
const { createColdVolumeReceipt } = require('./desktopColdRecovery.cjs');
const { createDesktopPreparationIntent } = require('./desktopPreparationIntent.cjs');
const { reportSpotifyPlaybackControl, reportSpotifyColdBootstrap } = require('./requestDiagnostics.cjs');
const { fail, failureCode, validDeviceId, validTrackId, validSessionId, sameStamp, position,
  normalizeDevices, requireDevice, playbackFacts } = require('./desktopPlaybackFacts.cjs');

// electron/spotify/desktopPlaybackControl.cjs: one explicit desktop target, with observed command completion and revocable leases.
function createDesktopPlaybackControl({ onRevoke = () => {}, now = Date.now,
  wait = (ms, signal) => delay(ms, undefined, { signal }), settleTimeoutMs = 4000, settleIntervalMs = 400,
  readRoutePcmEvidence = () => false,
  coldBootstrapDirectory,
  ...dependencies }) {
  if (typeof onRevoke !== 'function' || typeof wait !== 'function'
    || !Number.isInteger(settleTimeoutMs) || settleTimeoutMs < 1 || settleTimeoutMs > 10000
    || !Number.isInteger(settleIntervalMs) || settleIntervalMs < 1 || settleIntervalMs > settleTimeoutMs) throw fail('PROTOCOL_INVALID');
  const api = createDesktopPlaybackApi({ ...dependencies, now });
  let current, revision = 0, closed = false, mutation = Promise.resolve(), uncertainMutation = false;
  const routeSources = new Map();
  const observations = new Set(), devicePreparations = new WeakMap();
  let coldCleanup, observationGeneration = 0, preparationDevices;
  const OBSERVATION_MAX_AGE_MS = 5000;
  // Only an actual state GET creates a receipt. Reuse never refreshes its time,
  // mutation epoch or generation; each control dispatch invalidates first.
  function invalidateObservation(record) {
    record.mutationEpoch = (record.mutationEpoch || 0) + 1;
    record.sourceObservation = undefined;
    record.observationRead = undefined;
    if (record.restoreObservation) record.restoreObservation.invalidated = true;
  }
  function setPreparationPhase(record, phase) {
    if (record.preparationPhase !== phase) { invalidateObservation(record); record.preparationPhase = phase; }
  }
  function rememberObservation(record, body, epoch) {
    if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
    let facts;
    try {
      const trackId = /^spotify:track:([A-Za-z0-9]{22})$/.exec(body?.item?.uri)?.[1];
      const durationMs = body?.item?.duration_ms;
      if (!trackId || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3600000) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      facts = playbackFacts(body, { ...record, trackId, durationMs }, { now });
    } catch { record.sourceObservation = undefined; return; }
    if (facts.serverTimestamp != null && record.observationTimestampFloor != null && facts.serverTimestamp < record.observationTimestampFloor) {
      record.sourceObservation = undefined; return;
    }
    if (facts.serverTimestamp != null) record.observationTimestampFloor = facts.serverTimestamp;
    facts = Object.freeze({ ...facts, disallows: Object.freeze({ ...facts.disallows }) });
    record.sourceObservation = { facts, mutationEpoch: epoch, observationGeneration: ++observationGeneration,
      preparationPhase: record.preparationPhase, stamp: { ...record.stamp }, lease: record.preparationLease };
  }
  function usableObservation(record) {
    const value = record.sourceObservation;
    if (!value || record.revoked || record.controller.signal.aborted || value.mutationEpoch !== record.mutationEpoch
      || value.preparationPhase !== record.preparationPhase || !sameStamp(value.stamp, dependencies.vault.stamp())
      || value.facts.observedAt > now() || now() - value.facts.observedAt >= OBSERVATION_MAX_AGE_MS
      || record.mutationPending || api.hasUnsettledWrites()) return;
    return value;
  }
  function revoke(record, code) {
    if (!record || record.revoked) return;
    invalidateObservation(record);
    if (record.mutationPending || record.preparationPending) uncertainMutation = true;
    record.revoked = true; record.controller.abort(fail(code === 'SESSION_CHANGED' ? code : 'STALE_SESSION'));
    if (current === record) current = null;
    record.detach?.();
    if (record.session) { try { Promise.resolve(onRevoke({ session: record.session, code })).catch(() => {}); } catch {} }
  }
  function own(record) {
    if (record === coldCleanup) {
      if (!sameStamp(record.stamp, dependencies.vault.stamp())) throw fail('SESSION_CHANGED');
      record.controller.signal.throwIfAborted();
      return;
    }
    if (closed || record.revoked || record.controller.signal.aborted || record.revision !== revision
      || record.session && current !== record) throw fail('STALE_SESSION');
    if (record.stamp && !sameStamp(record.stamp, dependencies.vault.stamp())) {
      revoke(record, 'SESSION_CHANGED'); throw fail('SESSION_CHANGED');
    }
  }
  function get(session) {
    if (!current || current.session !== session) throw fail('STALE_SESSION');
    own(current); return current;
  }
  async function guarded(record, action) {
    try { own(record); const result = await action(); own(record); return result; }
    catch (error) {
      if (record.routeEngaged && record.onRouteParked && !record.revoked && !record.controller.signal.aborted) {
        try {
          const currentState = await read(record, { matchTrack: false });
          if (currentState.isPlaying && currentState.trackId !== record.routeCleanupTrack) throw fail('TRACK_NOT_CURRENT');
          await parkBeforeRoute(record, currentState);
          record.onRouteParked();
        } catch { error = fail('ROUTE_SOURCE_PAUSE_UNCONFIRMED'); }
      }
      const code = failureCode(error);
      revoke(record, code); throw fail(code);
    }
  }
  function enqueue(record, action) {
    // Retired leases remain in this barrier even after close/clear removes current.
    // A late targeted pause must finish before a new session selects its track.
    const next = mutation.catch(() => {}).then(() => guarded(record, action));
    mutation = next; record.queue = next; return next;
  }
  const request = (operation, record, options) => {
    if (!['state', 'devices'].includes(operation)) invalidateObservation(record);
    return api.request(operation, record, () => own(record), options);
  };
  const read = async (record, { allowEmpty = false, signal, reusePreparedObservation = false, ...options } = {}) => {
    if (reusePreparedObservation) {
      own(record);
      const saved = usableObservation(record);
      if (saved && saved.facts.deviceId === record.deviceId && (options.matchTrack === false || saved.facts.trackId === record.trackId))
        return saved.facts;
    }
    const epoch = record.mutationEpoch;
    const body = await request('state', record, { signal });
    if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
    rememberObservation(record, body, epoch);
    return allowEmpty && body == null ? null : playbackFacts(body, record, { now, ...options });
  };
  // The deadline covers dispatch, response drain, every read and every wait, even
  // when an injected transport or producer ignores cancellation.
  async function withinConfirmation(confirmation, action) {
    const { signal, deadline } = confirmation;
    const abortedFailure = () => fail(failureCode(signal.reason));
    if (signal.aborted) throw abortedFailure();
    if (now() >= deadline) throw fail('CONTROL_TIMEOUT');
    let abort;
    const aborted = new Promise((_, reject) => { abort = () => reject(abortedFailure()); });
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([action(), aborted]); }
    catch (error) { if (signal.aborted) throw abortedFailure(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  function beginConfirmationPhase(confirmation) {
    const phaseStarted = now();
    const deadline = Math.min(confirmation.overallDeadline, phaseStarted + Math.min(settleTimeoutMs, 4000));
    const remaining = deadline - phaseStarted;
    if (remaining <= 0) throw fail('CONTROL_TIMEOUT');
    confirmation.deadline = deadline;
    confirmation.commandAt = phaseStarted;
    confirmation.observationCount = 0;
    confirmation.signal = AbortSignal.any([confirmation.overallSignal, AbortSignal.timeout(remaining)]);
  }
  function beginConfirmation(record, before, phases = 1) {
    const budget = Math.min(settleTimeoutMs, 4000) * phases;
    const confirmation = { overallDeadline: now() + budget,
      overallSignal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(budget)]),
      timestampFloor: before?.serverTimestamp };
    beginConfirmationPhase(confirmation);
    return confirmation;
  }
  const pending = acknowledgment => acknowledgment?.acknowledgment === 'UNCONFIRMED';
  function checkConfirmation(record, confirmation, code = 'PLAYBACK_STATE_UNCONFIRMED') {
    own(record);
    if (confirmation.signal.aborted || now() >= confirmation.deadline) throw fail(code);
  }
  function timestampCurrent(confirmation, state) {
    const stamp = state?.serverTimestamp;
    if (stamp != null && confirmation.timestampFloor != null && stamp < confirmation.timestampFloor) return false;
    if (stamp != null) confirmation.timestampFloor = stamp;
    return true;
  }
  function reportConfirmed(operation, acknowledgment, confirmation, state, fields = {}) {
    if (!pending(acknowledgment)) return;
    reportSpotifyPlaybackControl(`playback-${operation}`, 'PUT', 200, {
      phase: 'state-confirmed', observationCount: confirmation.observationCount,
      deviceMatched: true, ...(state ? { paused: !state.isPlaying, playing: state.isPlaying } : {}), ...fields,
    });
  }
  function reportUnconfirmed(operation, acknowledgment, confirmation, error) {
    if (pending(acknowledgment)) reportSpotifyPlaybackControl(`playback-${operation}`, 'PUT', 200, {
      phase: 'failed', observationCount: confirmation.observationCount, errorCode: failureCode(error),
    });
  }
  const command = (operation, record, confirmation, positionMs) => withinConfirmation(confirmation,
    () => request(operation, record, { positionMs, signal: confirmation.signal }));
  async function observeCurrentTarget(record) {
    const body = await request('state', record);
    return body == null ? null : playbackFacts(body, { ...record, deviceId: body.device?.id }, { matchTrack: false, now });
  }
  async function coldBaseline(record, signal) {
    const epoch = record.mutationEpoch;
    const body = await request('state', record, { signal });
    if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
    rememberObservation(record, body, epoch);
    return body == null ? null : playbackFacts(body, { ...record, deviceId: body.device?.id },
      { matchTrack: false, allowInactive: true, now });
  }
  async function rebuildBeforeSelection(record) {
    // A retired PUT may have reached Spotify despite cancellation. Observe the
    // account twice before another selection, without treating a different device as ours.
    const first = await observeCurrentTarget(record);
    await wait(settleIntervalMs, record.controller.signal); own(record);
    const second = await observeCurrentTarget(record);
    if (first?.deviceId !== second?.deviceId || first?.trackId !== second?.trackId || first?.isPlaying !== second?.isPlaying)
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
    uncertainMutation = false;
  }
  // Playing observations use elapsed-time plausibility, never paused-position
  // equality. This observes the requested state; it does not prove PUT causality.
  function playingPosition(state, candidate, anchor, commandAt) {
    const elapsed = Math.max(0, state.observedAt - commandAt);
    if (state.positionMs < anchor - 1000 || state.positionMs > anchor + elapsed + 1000) return false;
    return !candidate || state.positionMs >= candidate.positionMs
      && state.positionMs - candidate.positionMs <= Math.max(0, state.observedAt - candidate.observedAt) + 1000;
  }
  async function confirm(record, desired, { selecting = false, positionMs, confirmation,
    strictPair = false, strictPlaying = false, unconfirmedCode } = {}) {
    let candidate;
    const code = unconfirmedCode || (positionMs == null ? 'PLAYBACK_STATE_UNCONFIRMED' : 'SEEK_UNCONFIRMED');
    const checkWindow = () => checkConfirmation(record, confirmation, code);
    for (;;) {
      checkWindow();
      let state;
      try { state = await withinConfirmation(confirmation, () => read(record, { signal: confirmation.signal })); checkWindow(); }
      catch (error) {
        checkWindow();
        if (!selecting || !['TRACK_NOT_CURRENT', 'PLAYBACK_UNAVAILABLE', 'DEVICE_ID_MISMATCH', 'DEVICE_INACTIVE'].includes(error?.code)) throw error;
      }
      if (state) confirmation.observationCount++;
      const timestampValid = timestampCurrent(confirmation, state);
      const positionValid = state && (positionMs == null || (desired && strictPlaying
        ? playingPosition(state, candidate, positionMs, confirmation.commandAt)
        : state.positionMs >= positionMs - 1000
          && state.positionMs <= positionMs + (desired ? Math.max(0, state.observedAt - confirmation.commandAt) : 0) + 1000));
      if (state && timestampValid && state.isPlaying === desired && positionValid) {
        if (!strictPair || candidate && (desired || state.positionMs === candidate.positionMs)) {
          record.mutationPending = false; return state;
        }
        candidate = state;
      } else candidate = undefined;
      const remaining = confirmation.deadline - now();
      if (remaining <= 0) throw fail(code);
      try { await withinConfirmation(confirmation, () => wait(Math.min(settleIntervalMs, remaining), confirmation.signal)); }
      catch (error) { checkWindow(); throw error; }
      checkWindow();
    }
  }
  async function confirmOperation(record, operation, acknowledgment, desired, options) {
    const { confirmation, positionMs, strictPair, strictPlaying } = options;
    try {
      const state = await confirm(record, desired, { ...options,
        unconfirmedCode: operation === 'seek' ? 'SEEK_UNCONFIRMED' : 'PLAYBACK_STATE_UNCONFIRMED' });
      reportConfirmed(operation, acknowledgment, confirmation, state, { trackMatched: true,
        stablePosition: !desired && strictPair,
        ...(positionMs != null ? { positionWithinTolerance: desired && strictPlaying
          ? playingPosition(state, undefined, positionMs, confirmation.commandAt) : Math.abs(state.positionMs - positionMs) <= 1000 } : {}),
        ...(desired && strictPlaying ? { progressPlausible: true } : {}),
      });
      return state;
    } catch (error) { reportUnconfirmed(operation, acknowledgment, confirmation, error); throw error; }
  }
  async function setPlaying(record, playing, { positionMs, reusePreparedObservation = false } = {}) {
    const before = await read(record, { reusePreparedObservation });
    let state = before, confirmation, strictPause = false;
    if (before.isPlaying !== playing) {
      if (before.disallows[playing ? 'resuming' : 'pausing']) throw fail('CONTROL_REJECTED');
      confirmation = beginConfirmation(record, before, positionMs == null ? 1 : 2);
      const operation = playing ? 'play' : 'pause';
      const acknowledgment = await command(operation, record, confirmation);
      strictPause = false;
      // Resume keeps the existing immediate post-PUT GET. A mandatory extra wait
      // here would consume the fixed two-second capture queue before it is read.
      state = await confirmOperation(record, operation, acknowledgment, playing, { confirmation,
        strictPair: strictPause, strictPlaying: playing && pending(acknowledgment),
        positionMs: playing && pending(acknowledgment) ? before.positionMs : undefined });
    }
    if (positionMs != null && state.positionMs !== positionMs) {
      if (state.disallows.seeking) throw fail('CONTROL_REJECTED');
      if (confirmation) beginConfirmationPhase(confirmation);
      else confirmation = beginConfirmation(record, state);
      // Start exactly one corrective phase before dispatch; a 200 cannot reset it.
      const acknowledgment = await command('seek', record, confirmation, positionMs);
      state = await confirmOperation(record, 'seek', acknowledgment, playing, { positionMs, confirmation,
        strictPair: false, strictPlaying: playing && pending(acknowledgment) });
    }
    own(record);
    return state;
  }
  // Routing acquisition needs an observed paused desktop before selecting a new track, which itself starts playback.
  async function parkBeforeRoute(record, baseline) {
    if (!baseline) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    if (!baseline.isPlaying) return baseline;
    if (baseline.disallows.pausing) throw fail('CONTROL_REJECTED');
    const confirmation = beginConfirmation(record, baseline);
    const acknowledgment = await command('pause', record, confirmation);
    for (;;) {
      checkConfirmation(record, confirmation);
      const state = await withinConfirmation(confirmation, () => read(record, { matchTrack: false, signal: confirmation.signal }));
      checkConfirmation(record, confirmation); confirmation.observationCount++;
      if (state.trackId !== baseline.trackId) throw fail('TRACK_NOT_CURRENT');
      const paused = !state.isPlaying && timestampCurrent(confirmation, state);
      if (paused) { record.mutationPending = false; return state; }
      await withinConfirmation(confirmation, () => wait(settleIntervalMs, confirmation.signal));
    }
  }
  async function selectTrack(record, baseline, positionMs) {
    const confirmation = beginConfirmation(record, baseline);
    record.routeCleanupTrack = record.trackId;
    const acknowledgment = await command('select', record, confirmation, positionMs);
    return confirmOperation(record, 'select', acknowledgment, true, { selecting: true, positionMs, confirmation,
      strictPair: false, strictPlaying: pending(acknowledgment) });
  }
  const legacyVolume = createColdVolumeReceipt(coldBootstrapDirectory);
  const preparationIntent = createDesktopPreparationIntent(coldBootstrapDirectory);
  // Old volume receipts are retained byte-for-byte. Only unknown playback writes
  // remain a source-control gate; volume uncertainty never gates a new Play.
  async function inspectLegacyPreparation() {
    try {
      let controlPending = false;
      try { controlPending = !!(await preparationIntent.snapshot()); } catch { controlPending = true; }
      const value = (await legacyVolume.snapshot())?.value;
      if (!value) return { historicalVolumeRecord: false, sourceControlUnconfirmed: controlPending, playbackUncertain: controlPending, recoverable: false };
      const playbackUncertain = controlPending || value.version !== 2 || value.playbackRequestPending !== false;
      return { historicalVolumeRecord: true, sourceControlUnconfirmed: playbackUncertain, playbackUncertain,
        recoverable: false, deviceId: value.deviceId, originalVolume: value.originalVolume };
    } catch {
      return { historicalVolumeRecord: true, sourceControlUnconfirmed: true, playbackUncertain: true, recoverable: false };
    }
  }
  async function assertPreparationAllowed() {
    await preparationIntent.assertClear();
    if ((await inspectLegacyPreparation()).sourceControlUnconfirmed || api.hasUnsettledWrites())
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
  }
  // A failed selection cannot be retired by a later cleanup pause. The existing
  // controller uncertainty barrier and native route owner retain that failure.
  async function preparationMutation(record, operation, action) {
    if (record.preparationPending || api.hasUnsettledWrites()) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    const intent = await preparationIntent.begin(record, operation);
    record.preparationPending = true;
    try {
      const value = await action();
      await preparationIntent.complete(intent, () => { own(record); if (api.hasUnsettledWrites()) throw fail('PLAYBACK_STATE_UNCONFIRMED'); });
      record.preparationPending = false; return value;
    }
    catch (error) {
      // Rejection before dispatch, or a fully rejected/settled command, has no
      // unknown write to retain. Cancellation alone never clears an actual PUT.
      if (!record.mutationPending && !api.hasUnsettledWrites()) {
        try {
          await preparationIntent.complete(intent, () => {
            if (record.mutationPending || api.hasUnsettledWrites()) throw fail('PLAYBACK_STATE_UNCONFIRMED');
          });
          record.preparationPending = false;
        } catch { /* Changed/partial storage remains an unknown preparation. */ }
      }
      if (record.preparationPending) uncertainMutation = true;
      throw error;
    }
  }
  function recordFor(session) {
    return { session, revision, controller: new AbortController(), queue: Promise.resolve(), revoked: false, mutationEpoch: 0, preparationPhase: 'baseline' };
  }
  function routedCallbacks(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['beforeSelect', 'afterPark'].includes(key))
      || typeof value.beforeSelect !== 'function' || typeof value.afterPark !== 'function') throw fail('PROTOCOL_INVALID');
    return value;
  }
  async function protectedRouteSelection(record, positionMs, callbacks, baseline) {
    const hooks = routedCallbacks(callbacks);
    if (!position(positionMs, record.durationMs)) throw fail('PROTOCOL_INVALID');
    setPreparationPhase(record, 'baseline');
    const before = baseline || await read(record, { matchTrack: false });
    const paused = before?.isPlaying
      ? await preparationMutation(record, 'route-park-before', () => parkBeforeRoute(record, before)) : before;
    own(record);
    if (!paused || paused.deviceId !== record.deviceId || paused.isPlaying || !validTrackId(paused.trackId))
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
    record.routeEngaged = true; record.routeCleanupTrack = paused.trackId;
    record.routePreparedParked = undefined;
    record.routeBaselineUri = `spotify:track:${paused.trackId}`;
    record.routeProofController?.abort();
    record.routeProofController = new AbortController(); routeSources.set(record.session, record);
    record.preparationLease = { selectedUri: `spotify:track:${record.trackId}` };
    const baselineObservation = usableObservation(record);
    if (baselineObservation) baselineObservation.lease = record.preparationLease;
    record.preparationObservationOpen = true;
    await hooks.beforeSelect(paused); own(record);
    // Only the exact completed cold transaction can discharge this selection.
    // A paused matching song from an earlier session or an aged GET is insufficient.
    const coldReceipt = record.coldPreparedSelection;
    const reuseColdSelection = coldReceipt && usableObservation(record) === coldReceipt
      && coldReceipt.facts.trackId === record.trackId && coldReceipt.facts.deviceId === record.deviceId
      && coldReceipt.facts.isPlaying === false && coldReceipt.facts.positionMs === positionMs;
    record.coldPreparedSelection = undefined;
    setPreparationPhase(record, 'selected');
    let parked;
    if (reuseColdSelection) {
      // Changing the native preparation phase invalidates reuse. Read again before
      // completing its proof; do not manufacture a newer observation from the receipt.
      parked = await read(record);
      if (parked.isPlaying || parked.positionMs !== positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    } else {
      await preparationMutation(record, 'route-select', () => selectTrack(record, paused, positionMs));
      parked = await preparationMutation(record, 'route-park', () => setPlaying(record, false, { positionMs, reusePreparedObservation: true }));
    }
    own(record);
    if (parked.deviceId !== record.deviceId || parked.trackId !== record.trackId || parked.isPlaying)
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
    record.routePreparedParked = { trackId: parked.trackId, positionMs: parked.positionMs, durationMs: parked.durationMs };
    await hooks.afterPark(parked); own(record); record.onRouteParked?.();
    return parked;
  }
  // Cold identity discovery is still limited to the existing exact no-session
  // branch. Its brief select uses the user's current volume, then parks before
  // native route acquisition. That exact transaction may discharge formal selection.
  async function establishColdIdentity(record, inspect, baseline, device) {
    let selected = false, inspectionCause, inspecting = false;
    try {
      // The select request already targets device_id. Its real state confirmation
      // establishes activation; a separate transfer adds no source identity proof.
      const selectedState = await preparationMutation(record, 'cold-select', () => selectTrack(record, baseline, 0)); selected = true;
      const window = beginConfirmation(record); inspecting = true;
      for (;;) {
        checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED');
        try { await withinConfirmation(window, () => inspect(selectedState)); break; }
        catch (error) {
          inspectionCause = error;
          checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED');
          if (['CANCELLED', 'SUPERSEDED', 'STALE_SESSION', 'CLOSED', 'SESSION_CHANGED'].includes(error?.code)) throw error;
          if (error?.name === 'AbortError') throw fail('CANCELLED');
          if (error?.code !== 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN') throw fail('BOOTSTRAP_IDENTITY_UNCONFIRMED');
        }
        // Session discovery can lag the acknowledged select. Only this exact
        // no-session result retries, within the original deadline and no new PUT.
        try { await withinConfirmation(window, () => wait(Math.min(settleIntervalMs, window.deadline - now()), window.signal)); }
        catch (error) { checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED'); throw error; }
      }
      checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED');
      reportSpotifyColdBootstrap(record.session, 'inspect', 'completed', { selectInvoked: true, selectConfirmed: true });
      inspecting = false;
      const parked = await preparationMutation(record, 'cold-park', () => setPlaying(record, false, { positionMs: 0, reusePreparedObservation: true }));
      record.coldPreparedSelection = usableObservation(record);
      return parked;
    } catch (error) {
      if (inspecting) reportSpotifyColdBootstrap(record.session, 'inspect', 'failed', { errorCode: error,
        ...(inspectionCause ? { causeCode: inspectionCause } : {}), selectInvoked: selected, selectConfirmed: selected });
      // Selecting may have succeeded before an inspection failure. Observe and
      // pause only that exact source; never seek, select, transfer or change volume.
      if (selected || record.preparationPending) {
        coldCleanup = { ...record, controller: new AbortController() };
        try {
          if (record.preparationPending) await setPlaying(coldCleanup, false);
          else await preparationMutation(coldCleanup, 'cleanup-pause', () => setPlaying(coldCleanup, false));
        }
        catch { /* Unknown playback remains retained by the controller barrier. */ }
        finally { coldCleanup.controller.abort(); coldCleanup = undefined; }
      }
      throw error;
    }
  }
  // Speculative inventory has an explicit source owner and never enters the
  // ambient setup handoff. It confers no playback or route authority.
  function prefetchedDevices(receipt, { signal, session, consume = false } = {}) {
    const saved = receipt && devicePreparations.get(receipt);
    if (consume && receipt) devicePreparations.delete(receipt);
    if (!saved || saved.session !== session || signal && saved.signal !== signal
      || saved.signal.aborted || saved.revision !== revision || closed) throw fail('CANCELLED');
    if (!sameStamp(saved.stamp, dependencies.vault.stamp())) throw fail('SESSION_CHANGED');
    if (saved.observedAt > now() || now() - saved.observedAt >= OBSERVATION_MAX_AGE_MS) saved.invalidated = true;
    if (saved.invalidated) return null;
    return saved;
  }
  async function listDevices({ signal, forPreparation = false, session } = {}) {
    if (closed || signal?.aborted) throw fail('CANCELLED');
    if (session != null && (!validSessionId(session) || !signal)) throw fail('PROTOCOL_INVALID');
    const record = recordFor(null); record.readOnly = session != null; observations.add(record);
    const abort = () => revoke(record, 'CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
    try { return await guarded(record, async () => {
      record.stamp = await api.authorize(() => own(record), { readOnly: record.readOnly });
      const body = await request('devices', record, { signal });
      const devices = normalizeDevices(body);
      const snapshot = { body, stamp: { ...record.stamp }, observedAt: now() };
      if (session != null) {
        const receipt = Object.freeze({});
        devicePreparations.set(receipt, { ...snapshot, session, signal, revision });
        return receipt;
      }
      if (forPreparation === true) preparationDevices = snapshot;
      return devices;
    }); } finally { observations.delete(record); signal?.removeEventListener('abort', abort); revoke(record, 'CLOSED'); }
  }
  return {
    inspectLegacyPreparation,
    async inspectColdRecovery() {
      const history = await inspectLegacyPreparation();
      return { ...history, required: false, archived: history.historicalVolumeRecord,
        unresolvedHistorical: history.historicalVolumeRecord };
    },
    async hasOwnedColdRecovery() { return false; },
    async checkColdRecovery() { return this.inspectColdRecovery(); },
    listDevices,
    prefetchDevices({ signal, session } = {}) {
      if (!validSessionId(session) || !signal) throw fail('PROTOCOL_INVALID');
      return listDevices({ signal, session });
    },
    readPrefetchedDevices(receipt, options) {
      const snapshot = prefetchedDevices(receipt, options);
      return snapshot ? normalizeDevices(snapshot.body) : null;
    },
    async prepare({ session, deviceId, trackId, durationMs, positionMs = 0, restoreSavedTarget = false, signal,
      beforeSelect, afterSelect, onRouteParked, coldBootstrap, coldBootstrapRequired = true, routedPreparation,
      preparationDevices: preparationReceipt } = {}) {
      if (closed || signal?.aborted) throw fail('CANCELLED');
      if (!validSessionId(session) || !validDeviceId(deviceId) || !validTrackId(trackId)
        || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3600000 || !position(positionMs, durationMs)
        || typeof restoreSavedTarget !== 'boolean' || typeof coldBootstrapRequired !== 'boolean'
        || coldBootstrap != null && (typeof coldBootstrap !== 'function'
          || typeof beforeSelect !== 'function' && routedPreparation == null || !restoreSavedTarget || positionMs !== 0)) throw fail('PROTOCOL_INVALID');
      if (routedPreparation != null) {
        routedCallbacks(routedPreparation);
        if (beforeSelect != null || afterSelect != null || !restoreSavedTarget) throw fail('PROTOCOL_INVALID');
      }
      const scopedDevices = preparationReceipt ? prefetchedDevices(preparationReceipt, { session, consume: true }) : null;
      const previous = current;
      for (const [oldSession, source] of routeSources) {
        if (oldSession !== session) { source.routeProofController.abort(); routeSources.delete(oldSession); }
      }
      revoke(previous, 'SUPERSEDED'); revision++;
      const record = Object.assign(recordFor(session), { deviceId, trackId, durationMs, onRouteParked }); current = record;
      const abort = () => revoke(record, 'CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
      record.detach = () => signal?.removeEventListener('abort', abort);
      return enqueue(record, async () => {
        // Retire a previously dispatched command before selecting a new track. Aborting
        // its HTTP request does not itself prove the service has settled that command.
        await previous?.queue.catch(() => {}); own(record);
        await assertPreparationAllowed(); own(record);
        record.stamp = await api.authorize(() => own(record));
        const handoff = scopedDevices || preparationDevices; preparationDevices = undefined;
        let device, deviceObservedAt;
        if (handoff && sameStamp(handoff.stamp, record.stamp) && handoff.observedAt <= now()
          && now() - handoff.observedAt < OBSERVATION_MAX_AGE_MS) {
          try { device = requireDevice(handoff.body, deviceId); deviceObservedAt = handoff.observedAt; } catch { /* Fresh GET retains the ordinary target validation. */ }
        }
        if (!device) { device = requireDevice(await request('devices', record), deviceId); deviceObservedAt = now(); }
        record.preparationDevice = { device, observedAt: deviceObservedAt, stamp: { ...record.stamp }, mutationEpoch: record.mutationEpoch };
        if (!device.isActive && !restoreSavedTarget) throw fail('DEVICE_INACTIVE');
        if (!device.isActive && (beforeSelect || routedPreparation) && !coldBootstrap) throw fail('DEVICE_INACTIVE');
        // Only the active VB preparation path can restore its saved target.
        // Passive reads never transfer, select, pause or change volume.
        if (uncertainMutation) await rebuildBeforeSelection(record);
        let baseline;
        if (coldBootstrap) {
          baseline = await coldBaseline(record);
          if (coldBootstrapRequired || !device.isActive || baseline === null || baseline.isActive === false || baseline.deviceId !== deviceId)
            baseline = await establishColdIdentity(record, coldBootstrap, baseline, device);
        } else baseline = !device.isActive ? await coldBaseline(record)
          : await read(record, { matchTrack: false, allowEmpty: restoreSavedTarget });
        if (uncertainMutation) {
          // Cancellation/timeout cannot undo an accepted remote PUT. Rebuild fresh
          // stable observations before proceeding; this is not an atomicity guarantee.
          await wait(settleIntervalMs, record.controller.signal); own(record);
          const rebuilt = await read(record, { matchTrack: false, allowEmpty: restoreSavedTarget });
          if (rebuilt?.trackId !== baseline?.trackId || rebuilt?.isPlaying !== baseline?.isPlaying) throw fail('PLAYBACK_STATE_UNCONFIRMED');
          uncertainMutation = false;
        }
        if (routedPreparation) return protectedRouteSelection(record, positionMs, routedPreparation, baseline);
        if (beforeSelect) {
          const paused = await parkBeforeRoute(record, baseline);
          record.routeEngaged = true; record.routeCleanupTrack = baseline.trackId;
          record.routeBaselineUri = baseline.trackId == null ? null : `spotify:track:${baseline.trackId}`;
          record.routeProofController = new AbortController(); routeSources.set(record.session, record);
          await beforeSelect(paused); own(record);
        }
        const selected = await selectTrack(record, baseline, positionMs);
        if (afterSelect) { await afterSelect(selected); own(record); }
        return setPlaying(record, false, { positionMs });
      });
    },
    async prepareOwnedRoute(session, { positionMs, beforeSelect, afterPark } = {}) {
      const record = get(session), hooks = routedCallbacks({ beforeSelect, afterPark });
      if (!position(positionMs, record.durationMs)) throw fail('PROTOCOL_INVALID');
      return enqueue(record, async () => {
        await assertPreparationAllowed(); own(record);
        // Reopening an existing source cannot claim a different externally selected song.
        setPreparationPhase(record, 'baseline');
        const baseline = await read(record);
        return protectedRouteSelection(record, positionMs, hooks, baseline);
      });
    },
    async resumeOwnedRoute(session, { positionMs, beforePosition, afterPark } = {}) {
      const record = get(session);
      if (!position(positionMs, record.durationMs) || typeof beforePosition !== 'function' || typeof afterPark !== 'function')
        throw fail('PROTOCOL_INVALID');
      return enqueue(record, async () => {
        await assertPreparationAllowed(); own(record);
        // Indefinite Pause retains ownership, never a five-second playback fact.
        // Exact source/device/account identity is observed again before any seek.
        setPreparationPhase(record, 'baseline');
        const baseline = await read(record);
        if (baseline.isPlaying || !record.routeEngaged) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        record.routePreparedParked = undefined;
        record.routeBaselineUri = `spotify:track:${record.trackId}`;
        record.preparationLease = { selectedUri: record.routeBaselineUri };
        const observation = usableObservation(record);
        if (observation) observation.lease = record.preparationLease;
        record.preparationObservationOpen = true;
        await beforePosition(baseline); own(record);
        const currentObservation = usableObservation(record);
        const positionBaseline = currentObservation?.lease === record.preparationLease
          && currentObservation.facts.deviceId === record.deviceId && currentObservation.facts.trackId === record.trackId
          && currentObservation.facts.isPlaying === false ? currentObservation.facts : null;
        setPreparationPhase(record, 'selected');
        const parked = await preparationMutation(record, 'route-park', async () => {
          if (!positionBaseline) return setPlaying(record, false, { positionMs });
          // This fresh observation belongs to this resume transaction. Changing
          // proof phase does not require reading the same pre-seek state twice.
          // The seek's confirmation below establishes new selected-phase facts.
          if (positionBaseline.positionMs === positionMs) return read(record);
          if (positionBaseline.disallows.seeking) throw fail('CONTROL_REJECTED');
          const confirmation = beginConfirmation(record, positionBaseline);
          const acknowledgment = await command('seek', record, confirmation, positionMs);
          return confirmOperation(record, 'seek', acknowledgment, false, { positionMs, confirmation, strictPair: false });
        });
        own(record);
        if (parked.isPlaying || parked.deviceId !== record.deviceId || parked.trackId !== record.trackId
          || parked.positionMs !== positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        record.routePreparedParked = { trackId: parked.trackId, positionMs: parked.positionMs, durationMs: parked.durationMs };
        await afterPark(parked); own(record); record.onRouteParked?.();
        return parked;
      });
    },
    async readState(session, { forPreparation = false } = {}) { const record = get(session);
      return enqueue(record, () => read(record, { reusePreparedObservation: forPreparation && record.preparationObservationOpen === true })); },
    async routeSourceControl(input, { signal: callerSignal } = {}) {
      const record = routeSources.get(input?.session);
      if (!record) throw fail('STALE_SESSION');
      const selectedUri = `spotify:track:${record.trackId}`;
      const reuse = input.requirePreparationObservation === true;
      const restoring = input.restoreOperationId != null;
      const changedPausedRestore = input.allowChangedTrackPausedForRestore === true;
      if (input.allowChangedTrackPausedForRestore != null && typeof input.allowChangedTrackPausedForRestore !== 'boolean'
        || changedPausedRestore && (!restoring || input.action !== 'read')) throw fail('PROTOCOL_INVALID');
      if (restoring && (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.restoreOperationId)
        || input.action !== 'read' || reuse || input.requirePreparedSelection === true || input.preparationPhase != null
        || input.preparationSelectedSourceUri != null)) throw fail('PROTOCOL_INVALID');
      if (input.requirePreparationObservation != null && typeof input.requirePreparationObservation !== 'boolean'
        || reuse && (input.action !== 'read' || !['baseline', 'selected'].includes(input.preparationPhase))
        || !reuse && input.preparationPhase != null) throw fail('PROTOCOL_INVALID');
      if (reuse && (record.revoked || input.preparationPhase !== record.preparationPhase)) throw fail('STALE_SESSION');
      if ((reuse || restoring) && (record.preparationPending || record.mutationPending || api.hasUnsettledWrites())) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      if (input.requirePreparedSelection != null && typeof input.requirePreparedSelection !== 'boolean'
        || input.requirePreparedSelection === true && (input.action !== 'read' || input.preparationSelectedSourceUri !== selectedUri)
        || input.requirePreparedSelection !== true && input.preparationSelectedSourceUri != null) throw fail('PROTOCOL_INVALID');
      if (!record.routeEngaged || !['read', 'pause'].includes(input.action) || input.sourceDeviceId !== record.deviceId
        || !Number.isSafeInteger(input.generation) || input.generation < 1
        || record.routeProofGeneration != null && (input.generation < record.routeProofGeneration
          || record.revoked && input.generation !== record.routeProofGeneration)
        || ![record.routeBaselineUri, selectedUri].includes(input.expectedSourceUri)
        || input.allowPreviousPaused === true && ![record.routeBaselineUri, selectedUri].includes(input.pausedPreviousUri))
        throw fail('PROTOCOL_INVALID');
      if (reuse) {
        if (record.preparationLease?.generation != null && record.preparationLease.generation !== input.generation) throw fail('STALE_SESSION');
        if (!record.preparationLease) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        record.preparationLease.generation = input.generation;
      }
      record.routeProofGeneration = input.generation;
      // Ordinary playback may already be revoked. Keep only this exact route's read/pause authority until
      // native release/recovery finishes; no retained method can play, select, seek or transfer a source.
      const checkProof = () => {
        if (closed || routeSources.get(record.session) !== record || record.routeProofController.signal.aborted
          || reuse && (record.revoked || record.controller.signal.aborted)) throw fail('STALE_SESSION');
        if (!sameStamp(record.stamp, dependencies.vault.stamp())) throw fail('SESSION_CHANGED');
      };
      let restoreContext;
      if (restoring) {
        const scope = JSON.stringify([input.generation, input.sourceDeviceId, input.expectedSourceUri,
          input.allowPreviousPaused === true, input.pausedPreviousUri || null, changedPausedRestore]);
        const previous = record.restoreObservation;
        if (previous?.operationId === input.restoreOperationId) {
          if (previous.scope !== scope) throw fail('PROTOCOL_INVALID');
          restoreContext = previous;
        } else {
          record.restoreOperations ||= new Set();
          if (record.restoreOperations.has(input.restoreOperationId) || record.restoreOperations.size >= 128) throw fail('STALE_SESSION');
          record.restoreOperations.add(input.restoreOperationId);
          restoreContext = { operationId: input.restoreOperationId, scope, mutationEpoch: record.mutationEpoch };
          record.restoreObservation = restoreContext;
        }
      }
      const proof = { ...record, controller: record.routeProofController };
      // Startup may reuse one bounded actual observation. Each normal restore
      // starts with its own real GET; rollback/recovery reads remain independent.
      // No branch queries or changes Spotify volume.
      const proofBudgetMs = input.action === 'read' ? 4000 : 10000;
      const signal = AbortSignal.any([record.routeProofController.signal, callerSignal || new AbortController().signal, AbortSignal.timeout(proofBudgetMs)]);
      const deadline = now() + proofBudgetMs;
      const proofWindow = budget => {
        const remaining = Math.min(budget, deadline - now());
        if (remaining <= 0) throw fail('CONTROL_TIMEOUT');
        return { deadline: now() + remaining, signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]) };
      };
      let capturedObservation, capturedRestore;
      const observe = async (matchSelected = false, window = proofWindow(4000)) => withinConfirmation(window, async () => {
        window.signal.throwIfAborted(); checkProof();
        const requireParked = input.requirePreparedSelection === true && record.routePreparedParked;
        let saved = reuse && usableObservation(record);
        if (saved && saved.lease !== record.preparationLease) saved = undefined;
        let facts;
        if (restoring) {
          if (restoreContext.invalidated || restoreContext.mutationEpoch !== record.mutationEpoch)
            throw fail('STALE_SESSION');
          if (!restoreContext.observation) {
            if (!restoreContext.task) restoreContext.task = (async () => {
              const epoch = record.mutationEpoch;
              const body = await api.request('state', proof, checkProof, { signal: window.signal }); checkProof(); window.signal.throwIfAborted();
              if (epoch !== record.mutationEpoch || record.restoreObservation !== restoreContext || restoreContext.invalidated) throw fail('STALE_SESSION');
              const trackId = /^spotify:track:([A-Za-z0-9]{22})$/.exec(body?.item?.uri)?.[1], durationMs = body?.item?.duration_ms;
              if (!trackId || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3600000) throw fail('PLAYBACK_STATE_UNCONFIRMED');
              const actual = playbackFacts(body, { ...proof, trackId, durationMs }, { now });
              return restoreContext.observation = { facts: actual, observationGeneration: ++observationGeneration, mutationEpoch: epoch };
            })();
            await restoreContext.task;
          }
          capturedRestore = restoreContext.observation;
          facts = capturedRestore.facts;
          if (facts.observedAt > now() || now() - facts.observedAt >= OBSERVATION_MAX_AGE_MS) throw fail('STALE_SESSION');
        } else if (saved) facts = saved.facts;
        else {
          const epoch = record.mutationEpoch;
          const load = async () => {
            const body = await api.request('state', proof, checkProof, { signal: window.signal }); checkProof(); window.signal.throwIfAborted();
            if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
            if (reuse) rememberObservation(record, body, epoch);
            return playbackFacts(body, proof, { matchTrack: matchSelected || !!requireParked, now });
          };
          if (reuse) {
            if (!record.observationRead || record.observationRead.epoch !== epoch) {
              const activeRead = { epoch, task: load() }; record.observationRead = activeRead;
              void activeRead.task.finally(() => { if (record.observationRead === activeRead) record.observationRead = undefined; }).catch(() => {});
            }
            await record.observationRead.task;
            saved = usableObservation(record);
            if (!saved || saved.lease !== record.preparationLease) throw fail('PLAYBACK_STATE_UNCONFIRMED');
            facts = saved.facts;
          } else facts = await load();
        }
        if (requireParked && (facts.isPlaying || facts.trackId !== requireParked.trackId
          || facts.positionMs !== requireParked.positionMs)) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        const uri = facts.trackId == null ? null : `spotify:track:${facts.trackId}`;
        if (uri !== input.expectedSourceUri && !(input.allowPreviousPaused === true && !facts.isPlaying && uri === input.pausedPreviousUri)
          && !(changedPausedRestore && !facts.isPlaying))
          throw fail('TRACK_NOT_CURRENT');
        if (reuse) capturedObservation = saved;
        return facts;
      });
      // Native acquire/validate is awaited from this record's mutation queue. This narrow broker deliberately
      // observes the same record directly; enqueuing a normal readState here would deadlock its own proof.
      let facts = await observe();
      if (input.action === 'pause' && facts.isPlaying) {
        if (input.expectedSourceUri !== selectedUri || facts.disallows.pausing) throw fail('CONTROL_REJECTED');
        await (async () => {
          let timestampFloor = facts.serverTimestamp;
          // A recovery pause includes a prior GET and later confirmation reads.
          // Preserve the original two-second PUT limit inside that fixed total.
          const mutation = proofWindow(2000);
          invalidateObservation(record);
          const acknowledgment = await withinConfirmation(mutation,
            () => api.request('pause', proof, checkProof, { signal: mutation.signal }));
          const confirmation = proofWindow(8000);
          let previousPaused;
          for (;;) {
            facts = await observe(true, confirmation);
            const fresh = facts.serverTimestamp == null || timestampFloor == null || facts.serverTimestamp >= timestampFloor;
            if (facts.serverTimestamp != null && fresh) timestampFloor = facts.serverTimestamp;
            const paused = !facts.isPlaying && fresh;
            if (paused && (!pending(acknowledgment) || previousPaused?.positionMs === facts.positionMs)) { record.mutationPending = false; break; }
            previousPaused = paused ? facts : undefined;
            const remaining = confirmation.deadline - now(); if (remaining <= 0) throw fail('PLAYBACK_STATE_UNCONFIRMED');
            await withinConfirmation(confirmation, () => wait(Math.min(settleIntervalMs, remaining), confirmation.signal));
          }
        })();
        record.onRouteParked?.();
      }
      if (input.requirePreparedSelection === true || reuse || restoring) {
        await preparationIntent.assertClear(); checkProof(); signal.throwIfAborted();
      }
      const preparationOwned = (input.requirePreparedSelection === true || reuse)
        && record.preparationLease?.selectedUri === selectedUri && record.routeEngaged === true
        && record.preparationPending !== true && !api.hasUnsettledWrites();
      const sourceWritesSettled = record.preparationPending !== true && !api.hasUnsettledWrites();
      if ((input.requirePreparedSelection === true || reuse) && !preparationOwned) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      checkProof(); signal.throwIfAborted();
      if (reuse && (!capturedObservation || usableObservation(record) !== capturedObservation
        || capturedObservation.lease !== record.preparationLease || record.preparationLease.generation !== input.generation
        || capturedObservation.preparationPhase !== input.preparationPhase)) throw fail('STALE_SESSION');
      const pcmStopped = readRoutePcmEvidence(record.session, input.generation) === true && sourceWritesSettled && !api.hasUnsettledWrites();
      if (restoring && (!pcmStopped || !capturedRestore || record.restoreObservation !== restoreContext
        || restoreContext.observation !== capturedRestore || restoreContext.invalidated
        || capturedRestore.mutationEpoch !== record.mutationEpoch || facts.observedAt > now()
        || now() - facts.observedAt >= OBSERVATION_MAX_AGE_MS)) throw fail('STALE_SESSION');
      return { sourceDeviceId: facts.deviceId, trackUri: facts.trackId == null ? null : `spotify:track:${facts.trackId}`,
        isPlaying: facts.isPlaying, observedAtUtc: new Date(facts.observedAt).toISOString(),
        pcmStopped,
        ...(input.requirePreparedSelection === true || reuse ? { preparationOwned, playbackRequestPending: !sourceWritesSettled } : {}),
        ...(reuse ? { observationGeneration: capturedObservation.observationGeneration, mutationEpoch: capturedObservation.mutationEpoch,
          preparationPhase: capturedObservation.preparationPhase, positionMs: facts.positionMs } : {}),
        ...(restoring ? { restoreOperationId: restoreContext.operationId, observationGeneration: capturedRestore.observationGeneration,
          mutationEpoch: capturedRestore.mutationEpoch, positionMs: facts.positionMs, playbackRequestPending: !sourceWritesSettled } : {}) };
    },
    async play(session) { const record = get(session); return enqueue(record, async () => {
      const state = await setPlaying(record, true, { reusePreparedObservation: record.preparationObservationOpen === true });
      record.preparationObservationOpen = false; return state;
    }); },
    async pause(session, { forPreparation = false } = {}) { const record = get(session);
      return enqueue(record, () => setPlaying(record, false, { reusePreparedObservation: forPreparation && record.preparationObservationOpen === true })); },
    async seek(session, positionMs) {
      const record = get(session);
      if (!position(positionMs, record.durationMs)) return Promise.reject(fail('PROTOCOL_INVALID'));
      return enqueue(record, async () => {
        const before = await read(record);
        if (before.disallows.seeking) throw fail('CONTROL_REJECTED');
        const confirmation = beginConfirmation(record, before);
        const acknowledgment = await command('seek', record, confirmation, positionMs);
        return confirmOperation(record, 'seek', acknowledgment, before.isPlaying, { positionMs, confirmation,
          strictPair: false, strictPlaying: before.isPlaying && pending(acknowledgment) });
      });
    },
    close(session) { if (current?.session === session) revoke(current, 'CLOSED'); return Promise.resolve(); },
    clear() { revoke(current, 'CLOSED'); revision++; for (const record of observations) revoke(record, 'CLOSED'); return Promise.resolve(); },
    dispose() {
      closed = true;
      for (const record of routeSources.values()) record.routeProofController.abort();
      routeSources.clear(); return this.clear();
    },
  };
}

module.exports = { createDesktopPlaybackControl };
